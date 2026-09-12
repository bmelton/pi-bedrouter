// Turn bedrouter's config into Pi provider model definitions.
import type { BedrouterConfig, Rung } from "./bedrouter.js";

export type PiModel = {
  id: string; name: string; api: "anthropic-messages" | "openai-completions"; baseUrl: string; reasoning: boolean;
  input: ("text" | "image")[]; cost: { input: number; output: number; cacheRead: number; cacheWrite: number }; contextWindow: number; maxTokens: number;
};

const FAMILY: Record<string, { api: PiModel["api"]; path: string; input: PiModel["input"]; contextWindow: number; maxTokens: number }> = {
  anthropic: { api: "anthropic-messages", path: "", input: ["text", "image"], contextWindow: 200_000, maxTokens: 64_000 },
  openai: { api: "openai-completions", path: "/v1", input: ["text"], contextWindow: 128_000, maxTokens: 32_000 },
};

const cost = (r: Rung) => ({ input: r.inputPerM, output: r.outputPerM, cacheRead: +(r.inputPerM * 0.1).toFixed(4), cacheWrite: +(r.inputPerM * 1.25).toFixed(4) });

/** `auto` aliases first (what most people should pick), then each family's rungs. Client aliases (claude-sonnet-5 → sonnet) are omitted to keep /model short. */
export function piModels(cfg: BedrouterConfig, base: string): PiModel[] {
  const out: PiModel[] = [];
  for (const [alias, target] of Object.entries(cfg.aliases ?? {})) {
    const m = /^auto:(\w+)$/.exec(target);
    if (!m) continue;
    const family = m[1], rungs = cfg.families[family], f = FAMILY[family];
    if (!rungs?.length || !f) continue;
    const exec = cfg.routing?.classes?.[family]?.execute;
    const rep = rungs.find((r) => r.alias === exec) ?? rungs[0];
    out.push({ id: alias, name: `Auto · ${family} ladder (${rungs.map((r) => r.alias).join(" → ")})`, api: f.api, baseUrl: base + f.path, reasoning: true, input: f.input, cost: cost(rep), contextWindow: f.contextWindow, maxTokens: f.maxTokens });
  }
  for (const [family, rungs] of Object.entries(cfg.families)) {
    const f = FAMILY[family];
    if (!f) continue;
    for (const r of rungs) out.push({ id: r.alias, name: `${r.alias} · ${family} (${r.bedrockId})`, api: f.api, baseUrl: base + f.path, reasoning: true, input: f.input, cost: cost(r), contextWindow: f.contextWindow, maxTokens: f.maxTokens });
  }
  return out;
}

/** pi-agents "fit notes" (~/.pi/agent/workflows.json → models) so the planner prefers the router and never pins premium rungs by default. */
export function fitNotes(cfg: BedrouterConfig, provider: string): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const [alias, target] of Object.entries(cfg.aliases ?? {})) {
    if (/^auto:/.test(target)) notes[`${provider}/${alias}`] = "default for every node: bedrouter picks the cheapest adequate model per request and escalates on failure";
  }
  for (const [family, rungs] of Object.entries(cfg.families)) {
    const classes = cfg.routing?.classes?.[family] ?? {};
    for (const r of rungs) {
      const cls = Object.entries(classes).find(([, a]) => a === r.alias)?.[0];
      notes[`${provider}/${r.alias}`] = cls === "explore" ? "pin only for planning, final review, reduces" : cls === "trivial" ? "pin only for titles, summaries, extraction" : cls === "execute" ? "pin only when a node must not be routed; ordinary implementation" : "pinned rung, bypasses routing";
    }
  }
  return notes;
}
