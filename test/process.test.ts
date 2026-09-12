// Mechanics against a real bedrouter checkout (BEDROUTER_TEST_PATH) when one is available; skipped otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as br from "../src/bedrouter.js";
import { DEFAULTS } from "../src/settings.js";

const checkout = process.env.BEDROUTER_TEST_PATH;

test("locate/ensureHome/readConfig/start against a checkout", { skip: !checkout && "set BEDROUTER_TEST_PATH to a built bedrouter checkout" }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pb-home-"));
  const s = { ...DEFAULTS, path: checkout!, home, port: 20900 + Math.floor(Math.random() * 90) };
  const loc = br.locate(s);
  assert.ok(loc.found && loc.cli && loc.source === "settings.path", JSON.stringify(loc));
  const created = br.ensureHome(s, loc);
  assert.deepEqual(created.map((f) => path.basename(f)).sort(), [".env", "bedrouter.json"]);
  const cfg = br.readConfig(s, loc);
  assert.ok("config" in cfg && cfg.config.families.anthropic.length > 0);
  assert.equal(await br.health(s), null);
  // With no credentials the preflight refuses to serve; start() must surface the reason from server.log instead of hanging.
  const r = await br.start(s, loc);
  if (r.ok) { assert.ok(r.health.pid > 0); assert.match(await br.stop(s), /stopped/); }
  else assert.match(r.error, /credentials|aws sso login|did not come up/);
  const d = br.run(s, loc, ["doctor"]);
  assert.match(d.out, /bedrouter: credentials/);
  assert.equal(br.locate({ ...s, path: "/nope" }).found, false);
});
