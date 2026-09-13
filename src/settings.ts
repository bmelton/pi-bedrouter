// pi-bedrouter settings: ~/.pi/agent/pi-bedrouter.json (all keys optional).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Settings = {
  /** Path to a bedrouter checkout or install. Default: the `bedrouter` package this extension depends on. */
  path?: string;
  /** Working directory for the server: holds .env, bedrouter.json, bedrouter.log.jsonl, server.log. Default: `path` when set, else ~/.bedrouter. */
  home?: string;
  /** Port to run/expect bedrouter on. */
  port: number;
  /** Start the server on session start when it is not running. */
  autoStart: boolean;
  /** Model id (from bedrouter's aliases) to select only when no higher-precedence provider/model choice exists; false leaves the model alone. */
  autoSelect: string | false;
  /** Start the server with BEDROUTER_DEBUG=1 (per-request trace in server.log). */
  debug: boolean;
  /** Show the routing status line in Pi's footer. */
  footer: boolean;
  /** Provider name registered in Pi. */
  providerName: string;
  /** Seconds between background health checks that keep the footer honest and restart a dead server (0 disables). */
  healthPollS: number;
  /**
   * What happens to the server when Pi quits (not on /reload or session switches):
   * "if-started-here": stop it if this session started it and no other client used it in the last few minutes;
   * "always": stop it whenever this session started it; "never": leave it running.
   */
  stopOnExit: "if-started-here" | "always" | "never";
};

export const DEFAULTS: Settings = { port: 20129, autoStart: true, autoSelect: "auto", debug: false, footer: true, providerName: "bedrouter", healthPollS: 15, stopOnExit: "if-started-here" };

export const agentDir = () => process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent");
export const settingsPath = () => path.join(agentDir(), "pi-bedrouter.json");
const expand = (p: string) => p.replace(/^~(?=$|\/)/, os.homedir());

export function loadSettings(): Settings {
  let user: Partial<Settings> = {};
  try { user = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { /* none yet */ }
  const s: Settings = { ...DEFAULTS, ...user };
  if (s.path) s.path = expand(s.path);
  if (s.home) s.home = expand(s.home);
  if (process.env.BEDROUTER_PORT) s.port = Number(process.env.BEDROUTER_PORT);
  return s;
}

export function saveSettings(s: Partial<Settings>): void {
  fs.mkdirSync(agentDir(), { recursive: true });
  let cur: Partial<Settings> = {};
  try { cur = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { /* none */ }
  fs.writeFileSync(settingsPath(), JSON.stringify({ ...cur, ...s }, null, 2) + "\n");
}
