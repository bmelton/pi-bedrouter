import { test } from "node:test";
import assert from "node:assert/strict";
import { piModels, fitNotes } from "../src/models.js";
import { fromHeaders, statusLine } from "../src/footer.js";

const cfg = {
  families: {
    anthropic: [{ alias: "haiku", bedrockId: "h", inputPerM: 1.1, outputPerM: 5.5 }, { alias: "sonnet", bedrockId: "s", inputPerM: 2.2, outputPerM: 11 }, { alias: "opus", bedrockId: "o", inputPerM: 5.5, outputPerM: 27.5 }],
    openai: [{ alias: "gpt-oss-20b", bedrockId: "g20", inputPerM: 0.07, outputPerM: 0.2 }, { alias: "gpt-oss-120b", bedrockId: "g120", inputPerM: 0.15, outputPerM: 0.6 }],
  },
  aliases: { auto: "auto:anthropic", "auto-oss": "auto:openai", "claude-sonnet-5": "sonnet" },
  routing: { classes: { anthropic: { trivial: "haiku", execute: "sonnet", explore: "opus" }, openai: { execute: "gpt-oss-20b", explore: "gpt-oss-120b" } } },
};

test("piModels: auto aliases first, per-family api and baseUrl, full cost object, client aliases omitted", () => {
  const ms = piModels(cfg, "http://127.0.0.1:20129");
  assert.deepEqual(ms.map((m) => m.id), ["auto", "auto-oss", "haiku", "sonnet", "opus", "gpt-oss-20b", "gpt-oss-120b"]);
  const auto = ms[0], oss = ms[1];
  assert.deepEqual([auto.api, auto.baseUrl, auto.input, auto.cost], ["anthropic-messages", "http://127.0.0.1:20129", ["text", "image"], { input: 2.2, output: 11, cacheRead: 0.22, cacheWrite: 2.75 }]);
  assert.deepEqual([oss.api, oss.baseUrl, oss.input], ["openai-completions", "http://127.0.0.1:20129/v1", ["text"]]);
  assert.match(auto.name, /haiku → sonnet → opus/);
  for (const m of ms) assert.ok(m.cost.cacheRead >= 0 && m.cost.cacheWrite >= 0 && m.contextWindow > 0 && m.maxTokens > 0 && m.reasoning === true);
});

test("fitNotes: auto is the default, rungs annotated by class", () => {
  const n = fitNotes(cfg, "bedrouter");
  assert.match(n["bedrouter/auto"], /default for every node/);
  assert.match(n["bedrouter/opus"], /planning, final review/);
  assert.match(n["bedrouter/haiku"], /titles/);
  assert.match(n["bedrouter/gpt-oss-20b"], /implementation/);
});

test("footer: headers → decision → status line, with and without stats", () => {
  assert.equal(fromHeaders({ "content-type": "text/event-stream" }), null);
  const d = fromHeaders({ "X-Bedrouter-Model": "gpt-oss-120b", "x-bedrouter-requested": "gpt-oss-20b", "x-bedrouter-class": "explore", "x-bedrouter-reason": "classifier:explore", "x-bedrouter-conversation": "abc", "x-bedrouter-classifier": "open-ended" })!;
  assert.deepEqual([d.model, d.requested, d.cls, d.reason, d.conversation, d.classifier], ["gpt-oss-120b", "gpt-oss-20b", "explore", "classifier:explore", "abc", "open-ended"]);
  assert.equal(statusLine(null, null), "bedrouter: ready");
  assert.equal(statusLine(d, null), "⇄ gpt-oss-120b ≠ gpt-oss-20b  explore·clf:explore");
  const saved = statusLine({ ...d, model: "gpt-oss-20b", requested: "gpt-oss-20b", reason: "keyword:execute", cls: "execute" }, { key: "abc", requests: 4, costUsd: 0.01, requestedCostUsd: 0.02, classifierCostUsd: 0.0005, inputTokens: 1, outputTokens: 1, escalations: 1, class: "execute", routedModel: "gpt-oss-20b", requestedModel: "gpt-oss-20b", lastTs: "" });
  assert.equal(saved, "⇄ gpt-oss-20b = gpt-oss-20b  execute·kw:execute  $0.0105 saved $0.0095 (48%)  ↑1");
  const over = statusLine(d, { key: "abc", requests: 1, costUsd: 0.03, requestedCostUsd: 0.01, classifierCostUsd: 0, inputTokens: 1, outputTokens: 1, escalations: 0, class: "explore", routedModel: "gpt-oss-120b", requestedModel: "gpt-oss-20b", lastTs: "" });
  assert.match(over, /\+\$0\.0200 over asked-for$/);
});
