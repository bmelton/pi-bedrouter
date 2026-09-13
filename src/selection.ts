import fs from "node:fs";
import path from "node:path";
import { agentDir, type Settings } from "./settings.js";

/** True when this Pi process was launched with an explicit provider or model choice. */
export function launchedWithExplicitModel(argv: string[] = process.argv.slice(2)): boolean {
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--provider" || arg === "--model") return true;
    if (arg.startsWith("--provider=") || arg.startsWith("--model=")) return true;
  }
  return false;
}

export function defaultProvider(): string | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(agentDir(), "settings.json"), "utf8"));
    return typeof value.defaultProvider === "string" ? value.defaultProvider : undefined;
  } catch { return undefined; }
}

/** Whether automatic startup/selection should claim this session for bedrouter. */
export function wantsUs(
  settings: Pick<Settings, "providerName">,
  options: { argv?: string[]; env?: NodeJS.ProcessEnv; defaultProvider?: () => string | undefined } = {},
): boolean {
  const env = options.env ?? process.env;
  if (env.PI_BEDROUTER_AUTOSELECT === "0") return false;
  if (launchedWithExplicitModel(options.argv ?? process.argv.slice(2))) return false;
  const provider = (options.defaultProvider ?? defaultProvider)();
  return !provider || provider === settings.providerName;
}
