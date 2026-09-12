import { test } from "node:test";
import assert from "node:assert/strict";
import { piModels, fitNotes } from "../src/models.js";
import { fromHeaders, sessionsTable, statusLine, usageReport } from "../src/footer.js";

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
  const NB = "\u00a0\u00a0";
  assert.equal(statusLine(null, null), `│ ✓ bedrouter ready${NB}`);
  assert.equal(statusLine(d, null), `│ ✓ bedrouter ⇄ gpt-oss-120b ≠ gpt-oss-20b  explore·clf:explore${NB}`);
  const saved = statusLine({ ...d, model: "gpt-oss-20b", requested: "gpt-oss-20b", reason: "keyword:execute", cls: "execute" }, { key: "abc", requests: 4, costUsd: 0.01, requestedCostUsd: 0.02, classifierCostUsd: 0.0005, inputTokens: 1, outputTokens: 1, escalations: 1, class: "execute", routedModel: "gpt-oss-20b", requestedModel: "gpt-oss-20b", lastTs: "" });
  assert.equal(saved, `│ ✓ bedrouter ⇄ gpt-oss-20b = gpt-oss-20b  execute·kw:execute  $0.0105 · saved $0.0100 (50%), classifier $0.0005  ↑1${NB}`);
  const over = statusLine(d, { key: "abc", requests: 1, costUsd: 0.03, requestedCostUsd: 0.01, classifierCostUsd: 0, inputTokens: 1, outputTokens: 1, escalations: 0, class: "explore", routedModel: "gpt-oss-120b", requestedModel: "gpt-oss-20b", lastTs: "" });
  assert.match(over, /\+\$0\.0200 over asked-for \(routed up\)\u00a0\u00a0$/);
  // break-even session: same model as asked for, only the classifier's one-off call on top -> never reported as "over"
  const even = statusLine({ ...d, model: "gpt-oss-20b", requested: "gpt-oss-20b", cls: "execute", reason: "sticky" }, { key: "abc", requests: 3, costUsd: 0.0024, requestedCostUsd: 0.0024, classifierCostUsd: 0.0004, inputTokens: 1, outputTokens: 1, escalations: 0, class: "execute", routedModel: "gpt-oss-20b", requestedModel: "gpt-oss-20b", lastTs: "" });
  assert.equal(even, `│ ✓ bedrouter ⇄ gpt-oss-20b = gpt-oss-20b  execute·sticky  $0.0028 · same as asked-for, classifier $0.0004${NB}`);
  // painted: the check mark and bar carry theme colours, the text does not
  const painted = statusLine(null, null, (c, t) => `<${c}>${t}</${c}>`);
  assert.equal(painted, `<dim>│</dim> <success>✓</success> bedrouter ready${NB}`);
});

test("usage: session report and sessions table", () => {
  const st = { key: "sess-1", requests: 7, errors: 1, conversations: 3, costUsd: 0.0312, requestedCostUsd: 0.0512, classifierCostUsd: 0.0004, inputTokens: 12000, outputTokens: 900, cacheReadTokens: 8000, escalations: 1,
    byRoute: { "sonnet -> sonnet": { requests: 5, costUsd: 0.02, requestedCostUsd: 0.02, inputTokens: 9000, outputTokens: 600 }, "sonnet -> haiku": { requests: 2, costUsd: 0.0112, requestedCostUsd: 0.0312, inputTokens: 3000, outputTokens: 300 } },
    firstTs: "2026-09-12T10:00:00.000Z", lastTs: "2026-09-12T10:42:00.000Z" };
  const r = usageReport(st, { sessionId: "sess-1" });
  const lines = r.split("\n");
  assert.equal(lines[0], "session   sess-1");
  assert.equal(lines[1], "requests  7 (1 errors), conversations 3, escalations 1, over 42 min");
  assert.equal(lines[2], "tokens    in 12.0k  out 900  cache-read 8.0k");
  assert.equal(lines[3], "spend     $0.0316  (models $0.0312 + classifier $0.0004)");
  assert.match(lines[5], /^routing   saved \$0\.0200 \(39\.1%\)$/);
  assert.ok(lines.some((l) => l.startsWith("  sonnet -> sonnet") && l.includes("$0.0200")));
  assert.ok(lines.indexOf(lines.find((l) => l.startsWith("  sonnet -> sonnet"))!) < lines.indexOf(lines.find((l) => l.startsWith("  sonnet -> haiku"))!), "routes sorted by cost desc");
  assert.match(usageReport({ ...st, costUsd: 0.06 }), /over asked-for/);
  assert.match(usageReport({ ...st, costUsd: st.requestedCostUsd, classifierCostUsd: 0 }), /routing   same as asked-for/);
  assert.match(usageReport(st, { conversationOnly: true }), /current conversation only/);
  const t = sessionsTable([st, { ...st, key: "sess-2" }], "sess-2");
  assert.match(t, /^\* sess-2/m);
  assert.match(t, /^  sess-1/m);
  assert.equal(sessionsTable([]), "(no sessions yet: nothing has sent x-bedrouter-session to this server)");
});
