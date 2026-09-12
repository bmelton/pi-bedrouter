// Footer status text: what served the last request and how the session is doing on cost.
import type { ConversationStats } from "./bedrouter.js";

export type LastDecision = { model: string; requested: string; cls: string; reason: string; conversation?: string; classifier?: string };

export function fromHeaders(h: Record<string, string>): LastDecision | null {
  const get = (k: string) => h[k] ?? h[k.toLowerCase()] ?? (Object.entries(h).find(([kk]) => kk.toLowerCase() === k)?.[1]);
  const model = get("x-bedrouter-model");
  if (!model) return null;
  return { model, requested: get("x-bedrouter-requested") ?? "?", cls: get("x-bedrouter-class") ?? "-", reason: get("x-bedrouter-reason") ?? "-", conversation: get("x-bedrouter-conversation"), classifier: get("x-bedrouter-classifier") };
}

const usd = (n: number) => (n >= 1 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`);
const short = (reason: string) => reason.replace(/^keyword:/, "kw:").replace(/^classifier:/, "clf:").replace(/^upgrade:keyword:/, "up:kw:").replace(/^shape:/, "");

export function statusLine(d: LastDecision | null, c: ConversationStats | null): string {
  if (!d) return "bedrouter: ready";
  const arrow = d.model === d.requested ? "=" : "≠";
  let s = `⇄ ${d.model} ${arrow} ${d.requested}  ${d.cls}·${short(d.reason)}`;
  if (c && c.requests > 0) {
    const spend = c.costUsd + c.classifierCostUsd;
    const diff = c.requestedCostUsd - spend;
    const pct = c.requestedCostUsd > 0 ? Math.round((diff / c.requestedCostUsd) * 100) : 0;
    s += `  ${usd(spend)}${diff >= 0 ? ` saved ${usd(diff)} (${pct}%)` : ` +${usd(-diff)} over asked-for`}${c.escalations ? `  ↑${c.escalations}` : ""}`;
  }
  return s;
}
