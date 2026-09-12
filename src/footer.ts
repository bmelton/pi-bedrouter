// Footer status text: what served the last request and how the session is doing on cost.
import type { ConversationStats, SessionStats } from "./bedrouter.js";

/** The footer totals against a session (preferred, bedrouter >= 0.3) or a single conversation (older servers). */
export type CostTotals = SessionStats | ConversationStats;

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

export function statusLine(d: LastDecision | null, c: CostTotals | null, paint: Paint = plain): string {
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

const usd4 = (n: number) => `$${n.toFixed(4)}`;
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The `/bedrouter usage` body: this Pi session's spend so far, what the asked-for model would have cost, and where it went. */
export function usageReport(st: SessionStats, opts: { sessionId?: string; conversationOnly?: boolean } = {}): string {
  const spend = st.costUsd + st.classifierCostUsd;
  const diff = st.requestedCostUsd - st.costUsd;
  const pct = st.requestedCostUsd > 0 ? (diff / st.requestedCostUsd) * 100 : 0;
  const mins = Math.max(0, Math.round((Date.parse(st.lastTs) - Date.parse(st.firstTs)) / 60_000));
  const out: string[] = [];
  out.push(`session   ${opts.sessionId ?? st.key}${opts.conversationOnly ? "  (current conversation only: this bedrouter predates per-session totals, upgrade it for whole-session numbers)" : ""}`);
  out.push(`requests  ${st.requests}${st.errors ? ` (${st.errors} errors)` : ""}, conversations ${st.conversations}, escalations ${st.escalations}${mins ? `, over ${mins} min` : ""}`);
  out.push(`tokens    in ${kTok(st.inputTokens)}  out ${kTok(st.outputTokens)}${st.cacheReadTokens ? `  cache-read ${kTok(st.cacheReadTokens)}` : ""}`);
  out.push(`spend     ${usd4(spend)}${st.classifierCostUsd > 0 ? `  (models ${usd4(st.costUsd)} + classifier ${usd4(st.classifierCostUsd)})` : ""}`);
  out.push(`asked-for ${usd4(st.requestedCostUsd)}  what the same tokens would have cost on the model Pi asked for`);
  if (Math.abs(diff) < 1e-6) out.push(`routing   same as asked-for`);
  else if (diff > 0) out.push(`routing   saved ${usd4(diff)} (${pct.toFixed(1)}%)`);
  else out.push(`routing   +${usd4(-diff)} over asked-for (routed up: explore / escalations)`);
  const routes = Object.entries(st.byRoute).sort((a, b) => b[1].costUsd - a[1].costUsd);
  if (routes.length) {
    out.push("");
    out.push(`  ${"requested -> routed".padEnd(28)} ${"reqs".padStart(5)} ${"in tok".padStart(8)} ${"out tok".padStart(8)} ${"cost".padStart(10)} ${"asked-for".padStart(10)}`);
    for (const [k, r] of routes) out.push(`  ${k.padEnd(28)} ${String(r.requests).padStart(5)} ${kTok(r.inputTokens).padStart(8)} ${kTok(r.outputTokens).padStart(8)} ${usd4(r.costUsd).padStart(10)} ${usd4(r.requestedCostUsd).padStart(10)}`);
  }
  return out.join("\n");
}

/** One line per session for `/bedrouter usage all`. */
export function sessionsTable(list: SessionStats[], current?: string): string {
  if (!list.length) return "(no sessions yet: nothing has sent x-bedrouter-session to this server)";
  const rows = [`  ${"session".padEnd(38)} ${"reqs".padStart(5)} ${"spend".padStart(10)} ${"asked-for".padStart(10)} ${"saved".padStart(10)}  last`];
  for (const st of list) rows.push(`${st.key === current ? "*" : " "} ${st.key.slice(0, 38).padEnd(38)} ${String(st.requests).padStart(5)} ${usd4(st.costUsd + st.classifierCostUsd).padStart(10)} ${usd4(st.requestedCostUsd).padStart(10)} ${usd4(st.requestedCostUsd - st.costUsd).padStart(10)}  ${st.lastTs.slice(0, 16).replace("T", " ")}`);
  return rows.join("\n");
}
