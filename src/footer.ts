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

/**
 * Pi's footer sorts extension statuses by key, joins them with ONE space, and collapses runs of ASCII spaces, so two
 * packages' lines run into each other. Each status therefore starts with a dim segment bar and ends with non-breaking
 * spaces (which survive the collapse) as a right margin. `paint` is ctx.ui.theme.fg when a UI is present.
 */
export type Paint = (color: "success" | "error" | "warning" | "dim" | "accent", text: string) => string;
const plain: Paint = (_c, t) => t;
const NBSP2 = "\u00a0\u00a0";
export const segment = (body: string, paint: Paint = plain) => `${paint("dim", "│")} ${body}${NBSP2}`;

export function readyLine(paint: Paint = plain): string { return segment(`${paint("success", "✓")} bedrouter ready`, paint); }
export function downLine(hint: string, paint: Paint = plain): string { return segment(`${paint("error", "✗")} bedrouter down · ${hint}`, paint); }
export function restartingLine(paint: Paint = plain): string { return segment(`${paint("warning", "↻")} bedrouter restarting…`, paint); }

export function statusLine(d: LastDecision | null, c: ConversationStats | null, paint: Paint = plain): string {
  if (!d) return readyLine(paint);
  const arrow = d.model === d.requested ? "=" : "≠";
  let s = `${paint("success", "✓")} bedrouter ⇄ ${d.model} ${arrow} ${d.requested}  ${d.cls}·${short(d.reason)}`;
  if (c && c.requests > 0) {
    const spend = c.costUsd + c.classifierCostUsd;
    // Routing effect = model cost vs the same tokens on the asked-for model. The classifier's one-off call is overhead
    // and shown as such, never folded into "over asked-for" (which would flag every break-even session as a loss).
    const diff = c.requestedCostUsd - c.costUsd;
    const pct = c.requestedCostUsd > 0 ? Math.round((diff / c.requestedCostUsd) * 100) : 0;
    const clf = c.classifierCostUsd > 0 ? `, classifier ${usd(c.classifierCostUsd)}` : "";
    let verdict: string;
    if (Math.abs(diff) < 1e-6) verdict = `same as asked-for${clf}`;
    else if (diff > 0) verdict = `saved ${usd(diff)} (${pct}%)${clf}`;
    else verdict = `+${usd(-diff)} over asked-for (routed up)${clf}`;
    s += `  ${usd(spend)} · ${verdict}${c.escalations ? `  ↑${c.escalations}` : ""}`;
  }
  return segment(s, paint);
}
