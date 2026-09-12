// Everything about the bedrouter process and its HTTP API: locate, install, start, stop, health, config, models.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { Settings } from "./settings.js";

export type Health = { ok: boolean; region: string; pid: number; version: string; routing: boolean; classifier: string | null; uptimeS: number };
export type ConversationStats = { key: string; requests: number; costUsd: number; requestedCostUsd: number; classifierCostUsd: number; inputTokens: number; outputTokens: number; escalations: number; class: string | null; routedModel: string | null; requestedModel: string | null; lastTs: string };
export type Rung = { alias: string; bedrockId: string; inputPerM: number; outputPerM: number };
export type BedrouterConfig = { families: Record<string, Rung[]>; aliases?: Record<string, string>; routing?: { enabled?: boolean; classes?: Record<string, Record<string, string>>; classifier?: { enabled?: boolean; model?: string } } };

export type Found = { found: true; dir: string; cli: string | null; source: "settings.path" | "dependency"; version: string };
export type Install = Found | { found: false; reason: string; installCmd: string };

const require_ = createRequire(import.meta.url);

/** Where bedrouter lives: settings.path if set, else the `bedrouter` npm dependency of this package. */
export function locate(s: Settings): Install {
  const candidates: { dir: string; source: "settings.path" | "dependency" }[] = [];
  if (s.path) candidates.push({ dir: s.path, source: "settings.path" as const });
  try { candidates.push({ dir: path.dirname(require_.resolve("bedrouter/package.json")), source: "dependency" as const }); } catch { /* not installed */ }
  for (const c of candidates) {
    const pkgPath = path.join(c.dir, "package.json");
    if (!fs.existsSync(pkgPath)) continue;
    let version = "?";
    try { version = JSON.parse(fs.readFileSync(pkgPath, "utf8")).version ?? "?"; } catch { /* ignore */ }
    const dist = path.join(c.dir, "dist", "cli.js");
    const cli = fs.existsSync(dist) ? dist : null;
    return { found: true, dir: c.dir, cli, source: c.source, version };
  }
  const here = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  return { found: false, reason: s.path ? `no package.json at ${s.path}` : "the bedrouter dependency is not installed", installCmd: `npm install --no-audit --no-fund --prefix "${here}"` };
}

/** Install the dependency (npm install in this package's directory) or build dist/ in a checkout. Returns the log. */
export function install(s: Settings): { ok: boolean; log: string } {
  const loc = locate(s);
  const here = path.dirname(path.dirname(new URL(import.meta.url).pathname));
  const cwd = loc.found ? loc.dir : here;
  const args = loc.found ? ["run", "build"] : ["install", "--no-audit", "--no-fund"];
  const r = spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 300_000, env: { ...process.env, npm_config_loglevel: "error" } });
  const log = `$ npm ${args.join(" ")}  (in ${cwd})\n${r.stdout ?? ""}${r.stderr ?? ""}`;
  if (r.status === 0 && loc.found && !fs.existsSync(path.join(loc.dir, "dist", "cli.js"))) return { ok: false, log: log + "\nbuild produced no dist/cli.js" };
  if (r.status === 0 && !loc.found) {
    // a git dependency runs its own `prepare` (build) during npm install; make sure it did
    const again = locate(s);
    if (!again.found) return { ok: false, log: log + "\nbedrouter still not resolvable after install" };
    if (!again.cli) return install(s); // installed but not built (e.g. prepare skipped): build it
  }
  return { ok: r.status === 0, log };
}

export const homeDir = (s: Settings) => s.home ?? s.path ?? path.join(os.homedir(), ".bedrouter");
export const baseUrl = (s: Settings) => `http://127.0.0.1:${s.port}`;

/** Make sure the working directory has .env and bedrouter.json, seeding from the package's examples. Returns what was created. */
export function ensureHome(s: Settings, loc: Found): string[] {
  const home = homeDir(s);
  fs.mkdirSync(home, { recursive: true });
  const created: string[] = [];
  const seed = (name: string, example: string) => {
    const dst = path.join(home, name), src = path.join(loc.dir, example);
    if (!fs.existsSync(dst) && fs.existsSync(src)) { fs.copyFileSync(src, dst); created.push(dst); }
  };
  seed(".env", ".env.example");
  seed("bedrouter.json", "bedrouter.example.json");
  return created;
}

export function readConfig(s: Settings, loc: Found | null): { path: string; config: BedrouterConfig } | { path: string; error: string } {
  const home = homeDir(s);
  const candidates = [path.join(home, "bedrouter.json"), ...(loc ? [path.join(loc.dir, "bedrouter.json"), path.join(loc.dir, "bedrouter.example.json")] : [])];
  const p = candidates.find((c) => fs.existsSync(c));
  if (!p) return { path: candidates[0], error: "no bedrouter.json found" };
  try { return { path: p, config: JSON.parse(fs.readFileSync(p, "utf8")) }; } catch (e) { return { path: p, error: (e as Error).message }; }
}

async function getJson<T>(url: string, timeoutMs = 1500): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

export const health = (s: Settings) => getJson<Health>(`${baseUrl(s)}/health`);

/** Reconstruct a BedrouterConfig from a running server's /v1/models, so the provider can be registered with no local files. */
export async function liveConfig(s: Settings): Promise<BedrouterConfig | null> {
  type M = { id: string; bedrock_id: string; bedrouter?: { family: string; rung: string; auto: boolean; inputPerM: number; outputPerM: number } };
  const r = await getJson<{ data: M[] }>(`${baseUrl(s)}/v1/models`);
  if (!r?.data) return null;
  const families: Record<string, Rung[]> = {};
  const aliases: Record<string, string> = {};
  for (const m of r.data) {
    const b = m.bedrouter;
    if (!b) continue;
    if (b.auto) { aliases[m.id] = `auto:${b.family}`; continue; }
    const fam = (families[b.family] ??= []);
    if (m.id === b.rung) { if (!fam.some((x) => x.alias === b.rung)) fam.push({ alias: b.rung, bedrockId: m.bedrock_id, inputPerM: b.inputPerM, outputPerM: b.outputPerM }); }
    else aliases[m.id] = b.rung;
  }
  // /v1/models is a map, so ladder order is lost; restore cheapest-first by input price (what bedrouter's ladders are)
  for (const fam of Object.values(families)) fam.sort((a, b) => a.inputPerM - b.inputPerM);
  return { families, aliases };
}

/** Last resort when neither a server nor a config file is available: the shipped example ladder. */
export const FALLBACK_CONFIG: BedrouterConfig = {
  families: {
    anthropic: [
      { alias: "haiku", bedrockId: "us.anthropic.claude-haiku-4-5-20251001-v1:0", inputPerM: 1.1, outputPerM: 5.5 },
      { alias: "sonnet", bedrockId: "us.anthropic.claude-sonnet-5", inputPerM: 2.2, outputPerM: 11 },
      { alias: "opus", bedrockId: "us.anthropic.claude-opus-5", inputPerM: 5.5, outputPerM: 27.5 },
    ],
    openai: [
      { alias: "gpt-oss-20b", bedrockId: "openai.gpt-oss-20b-1:0", inputPerM: 0.07, outputPerM: 0.2 },
      { alias: "gpt-oss-120b", bedrockId: "openai.gpt-oss-120b-1:0", inputPerM: 0.15, outputPerM: 0.6 },
    ],
  },
  aliases: { auto: "auto:anthropic", "auto-oss": "auto:openai" },
  routing: { classes: { anthropic: { trivial: "haiku", execute: "sonnet", explore: "opus" }, openai: { execute: "gpt-oss-20b", explore: "gpt-oss-120b" } } },
};
export const conversation = (s: Settings, key: string) => getJson<ConversationStats>(`${baseUrl(s)}/v1/conversations/${key}`);
export const recentConversations = async (s: Settings) => (await getJson<{ data: ConversationStats[] }>(`${baseUrl(s)}/v1/conversations`))?.data ?? [];

/** True when a conversation other than `ours` sent a request within `windowMs`: another client is using the server. */
export async function othersActive(s: Settings, ours: Set<string>, windowMs = 5 * 60_000, now = Date.now()): Promise<boolean> {
  const recent = await recentConversations(s);
  return recent.some((c) => !ours.has(c.key) && now - Date.parse(c.lastTs) < windowMs);
}

export const serverLog = (s: Settings) => path.join(homeDir(s), "server.log");
export const decisionLog = (s: Settings) => path.join(homeDir(s), "bedrouter.log.jsonl");

/** Start the server detached; stdout/stderr go to server.log in the home dir. Resolves with health, or the log tail on failure. */
export async function start(s: Settings, locIn: Found): Promise<{ ok: true; health: Health; created: string[] } | { ok: false; error: string; created: string[] }> {
  let loc = locIn;
  const already = await health(s);
  if (already?.ok) return { ok: true, health: already, created: [] };
  const created = ensureHome(s, loc);
  const home = homeDir(s);
  if (!loc.cli) {
    // not built yet (fresh checkout, or a dependency whose prepare step did not run): build once, then continue
    const b = install(s);
    const again = locate(s);
    if (!b.ok || !again.found || !again.cli) return { ok: false, error: `bedrouter at ${loc.dir} has no dist/cli.js and the build failed:\n${b.log.trim().split("\n").slice(-8).join("\n")}`, created };
    loc = again;
  }
  const out = fs.openSync(serverLog(s), "a");
  fs.writeSync(out, `\n--- pi-bedrouter start ${new Date().toISOString()} ---\n`);
  const cli: string = loc.cli!;
  const child = spawn(process.execPath, [cli, "serve"], {
    cwd: home, detached: true, stdio: ["ignore", out, out],
    env: { ...process.env, PORT: String(s.port), BEDROUTER_DEBUG: s.debug ? "1" : process.env.BEDROUTER_DEBUG ?? "", BEDROUTER_LOG: decisionLog(s) },
  });
  child.unref();
  fs.closeSync(out);
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const h = await health(s);
    if (h?.ok) return { ok: true, health: h, created };
    if (child.exitCode !== null) break;
  }
  return { ok: false, error: `bedrouter did not come up on ${baseUrl(s)}:\n${tail(serverLog(s), 12)}`, created };
}

export async function stop(s: Settings): Promise<string> {
  const h = await health(s);
  if (!h?.ok) return "bedrouter is not running";
  try { process.kill(h.pid, "SIGTERM"); } catch (e) { return `could not signal pid ${h.pid}: ${(e as Error).message}`; }
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 150)); if (!(await health(s))) return `stopped bedrouter (pid ${h.pid})`; }
  return `sent SIGTERM to pid ${h.pid} but it is still answering; check ${serverLog(s)}`;
}

export function tail(file: string, n: number): string {
  try { const lines = fs.readFileSync(file, "utf8").trimEnd().split("\n"); return lines.slice(-n).join("\n"); } catch { return `(no ${file})`; }
}

/** Run a bedrouter subcommand (doctor/report/smoke) in the home dir and capture its output. */
export function run(s: Settings, loc: Found, args: string[], timeoutMs = 120_000): { code: number; out: string } {
  if (!loc.cli) return { code: 1, out: "bedrouter is not built; run /bedrouter install" };
  const r = spawnSync(process.execPath, [loc.cli, ...args], { cwd: homeDir(s), encoding: "utf8", timeout: timeoutMs, env: { ...process.env, PORT: String(s.port), BEDROUTER_LOG: decisionLog(s), FORCE_COLOR: "0" } });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() || (r.error ? String(r.error) : "") };
}
