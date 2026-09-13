import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activate } from "../extensions/index.js";
import * as real from "../src/bedrouter.js";

test("startup stays inert off bedrouter while registration remains unconditional; a late switch starts it", async () => {
  const priorDir = process.env.PI_CODING_AGENT_DIR;
  const priorEscape = process.env.PI_BEDROUTER_AUTOSELECT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bedrouter-extension-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PI_BEDROUTER_AUTOSELECT = "0";
  fs.writeFileSync(path.join(dir, "pi-bedrouter.json"), JSON.stringify({ autoStart: true, healthPollS: 0 }));

  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<unknown>>();
  let registrations = 0;
  let starts = 0;
  const pi = {
    on(name: string, handler: (event: any, ctx: ExtensionContext) => Promise<unknown>) { handlers.set(name, handler); },
    registerProvider() { registrations++; },
    registerCommand() {},
  } as unknown as ExtensionAPI;
  const found: real.Found = { found: true, dir, cli: "/tmp/bedrouter", source: "settings.path", version: "0.5.0" };
  const runtime: typeof real = {
    ...real,
    locate: () => found,
    liveConfig: async () => null,
    readConfig: () => ({ path: "built-in", config: real.FALLBACK_CONFIG }),
    health: async () => null,
    start: async () => {
      starts++;
      return { ok: true, health: { ok: true, region: "us-east-1", pid: 1, version: "0.5.0", routing: true, classifier: null, uptimeS: 0 }, created: [] };
    },
  };
  const statuses: Array<string | undefined> = [];
  const ctx = {
    hasUI: true,
    model: { provider: "openai", id: "gpt" },
    modelRegistry: { find: () => undefined },
    sessionManager: { getSessionId: () => "s" },
    ui: { setStatus: (_key: string, value: string | undefined) => statuses.push(value), notify() {}, theme: { fg: (_c: string, value: string) => value } },
  } as unknown as ExtensionContext;

  try {
    await activate(pi, runtime);
    assert.equal(registrations, 1);
    await handlers.get("session_start")!({ reason: "startup" }, ctx);
    assert.equal(starts, 0);
    await handlers.get("model_select")!({ model: { provider: "bedrouter", id: "auto" } }, { ...ctx, model: { provider: "bedrouter", id: "auto" } } as ExtensionContext);
    assert.equal(starts, 1);
    assert.ok(registrations >= 2, "bring-up re-registers from the live/local config");
  } finally {
    if (priorDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = priorDir;
    if (priorEscape === undefined) delete process.env.PI_BEDROUTER_AUTOSELECT; else process.env.PI_BEDROUTER_AUTOSELECT = priorEscape;
  }
});
