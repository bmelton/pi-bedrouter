// pi-bedrouter: run bedrouter (the cost-aware Bedrock model router) from inside Pi.
//
//  - finds the bedrouter install (settings.path or the npm dependency), installs/builds it when missing
//  - starts the server when it is not running, seeding .env / bedrouter.json from the examples
//  - registers a "bedrouter" provider whose models come from bedrouter.json (auto aliases + rungs)
//  - optionally switches the session to bedrouter/auto so nobody has to pick a model
//  - shows which model served each request in the footer, from bedrouter's x-bedrouter-* response headers,
//    plus the running session cost against what the requested model would have cost
//  - tags every request with Pi's session id (x-bedrouter-session) so bedrouter can total the whole session, not just
//    one conversation key; /bedrouter usage shows those totals
//  - /bedrouter status|start|stop|restart|install|doctor|probe|usage|report|log|models|fitnotes|config
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadSettings, saveSettings, settingsPath, agentDir, type Settings } from "../src/settings.js";
import * as br from "../src/bedrouter.js";
import { fitNotes, piModels } from "../src/models.js";
import { wantsUs } from "../src/selection.js";
import { downLine, fromHeaders, readyLine, restartingLine, sessionsTable, statusLine, usageReport, type CostTotals, type LastDecision, type Paint } from "../src/footer.js";

export async function activate(pi: ExtensionAPI, runtime: typeof br = br) {
  let settings = loadSettings();
  let last: LastDecision | null = null;
  let stats: CostTotals | null = null;            // footer totals: the session when the server supports it, else the last conversation
  let registeredModelIds: string[] = [];
  let lastCtx: ExtensionContext | null = null; // most recent context, for the background poll to update the footer
  let serverUp: boolean | null = null;         // last known health; null = never checked
  let restartAttemptAt = 0;                    // throttle auto-restarts to one per 60 s
  let startedHere = false;                     // this session launched the server (so it may stop it on quit)
  const ourConversations = new Set<string>();  // bedrouter conversation keys seen from this session

  const isOurs = (ctx: ExtensionContext) => ctx.model?.provider === settings.providerName;
  const sessionId = (ctx: ExtensionContext) => { try { return ctx.sessionManager.getSessionId(); } catch { return null; } };
  /** Whole-session totals from bedrouter (>= 0.3); falls back to the last conversation on older servers. */
  async function refreshStats(ctx: ExtensionContext): Promise<{ session: br.SessionStats | null; conversation: br.ConversationStats | null }> {
    const id = sessionId(ctx);
    const session = id ? await runtime.session(settings, id) : null;
    const conversation = !session && last?.conversation ? await runtime.conversation(settings, last.conversation) : null;
    stats = session ?? conversation ?? stats;
    return { session, conversation };
  }
  const setStatus = (ctx: ExtensionContext, text: string | undefined) => { lastCtx = ctx; if (ctx.hasUI && settings.footer) ctx.ui.setStatus("bedrouter", text); };
  const paint = (ctx: ExtensionContext | null): Paint => (ctx?.hasUI && ctx.ui.theme ? (c, t) => ctx.ui.theme.fg(c, t) : (_c, t) => t);
  const readyText = (ctx: ExtensionContext | null = lastCtx) => statusLine(last, stats, paint(ctx));
  const notify = (ctx: ExtensionContext, msg: string, type: "info" | "warning" | "error" = "info") => { if (ctx.hasUI) ctx.ui.notify(msg, type); };
  /** Show multi-line output (doctor/report/log) as a visible message without adding it to the model's context. */
  const show = (title: string, body: string) => pi.sendMessage({ customType: "bedrouter", content: `**${title}**\n\n\`\`\`\n${body}\n\`\`\``, display: true }, { triggerTurn: false });

  /**
   * Register (or re-register) the provider. Source, in order: the running server's /v1/models (always right for the
   * ladder that is actually serving), then bedrouter.json (home dir, then the checkout), then the shipped default.
   */
  async function registerProvider(loc: br.Found | null): Promise<string> {
    let cfg: br.BedrouterConfig | null = null;
    let source = "";
    const live = await runtime.liveConfig(settings);
    if (live && Object.keys(live.families).length) { cfg = live; source = `${br.baseUrl(settings)}/v1/models`; }
    if (!cfg) {
      const file = runtime.readConfig(settings, loc);
      if ("config" in file) { cfg = file.config; source = file.path; }
    }
    if (!cfg) { cfg = runtime.FALLBACK_CONFIG; source = "built-in default ladder (no server, no bedrouter.json yet)"; }
    const models = piModels(cfg, br.baseUrl(settings));
    pi.registerProvider(settings.providerName, {
      name: "bedrouter (Bedrock, routed)",
      baseUrl: br.baseUrl(settings),
      apiKey: process.env.BEDROUTER_API_KEY || "bedrouter",
      api: "anthropic-messages",
      models,
    });
    registeredModelIds = models.map((m) => m.id);
    return `registered ${models.length} models from ${source}: ${registeredModelIds.join(", ")}`;
  }

  const exitPolicyText = () => settings.stopOnExit === "never" ? "left running" : settings.stopOnExit === "always" ? "stopped" : "stopped unless another client is using it";

  /** Locate → (install) → start → register. Returns a human summary. Never throws. */
  async function bringUp(ctx: ExtensionContext | null, opts: { install?: boolean; start?: boolean } = {}): Promise<{ ok: boolean; lines: string[] }> {
    const lines: string[] = [];
    let loc = runtime.locate(settings);
    if (!loc.found && opts.install) {
      lines.push(`bedrouter not found (${loc.reason}); installing…`);
      const r = runtime.install(settings);
      lines.push(r.log.trim().split("\n").slice(-6).join("\n"));
      loc = runtime.locate(settings);
    }
    if (!loc.found) { lines.push(`bedrouter is not installed: ${loc.reason}. Run /bedrouter install (or: ${loc.installCmd}).`); return { ok: false, lines }; }
    if (!loc.cli && opts.install) {
      lines.push(`bedrouter at ${loc.dir} is not built; building…`);
      const r = runtime.install(settings);
      lines.push(r.log.trim().split("\n").slice(-6).join("\n"));
      loc = runtime.locate(settings);
    }
    lines.push(await registerProvider(loc as br.Found));
    if (opts.start) {
      const before = await runtime.health(settings);
      const r = await runtime.start(settings, loc as br.Found);
      for (const f of r.created) lines.push(`created ${f} from the example; edit it for this machine (AWS_PROFILE, ladder)`);
      if (r.ok) {
        if (!before?.ok) startedHere = true;
        lines.push(`bedrouter ${r.health.version} up on ${br.baseUrl(settings)} (pid ${r.health.pid}, region ${r.health.region}, classifier ${r.health.classifier ?? "off"})${!before?.ok ? `; started by this session, on quit: ${exitPolicyText()}` : "; was already running (not started here, left alone on quit)"}`);
      } else { lines.push(r.error); return { ok: false, lines }; }
    }
    return { ok: true, lines };
  }

  async function autoSelect(ctx: ExtensionContext) {
    if (settings.autoSelect === false || !ctx.hasUI) return;
    if (isOurs(ctx)) return;
    if (!wantsUs(settings)) return;
    const want = registeredModelIds.includes(settings.autoSelect) ? settings.autoSelect : registeredModelIds.find((id) => id.startsWith("auto")) ?? registeredModelIds[0];
    if (!want) return;
    const model = ctx.modelRegistry.find(settings.providerName, want);
    if (!model) return;
    const ok = await pi.setModel(model);
    if (ok) notify(ctx, `bedrouter: model set to ${settings.providerName}/${want} (bedrouter picks the rung per request; /model to change)`);
  }

  // ---- startup -----------------------------------------------------------------------------------------------
  // The factory is async, so pi waits for this: the provider exists for `pi --list-models` and `--provider bedrouter`
  // whether or not the server or a checkout is present yet.
  {
    const loc = runtime.locate(settings);
    await registerProvider(loc.found ? loc : null);
  }

  pi.on("session_start", async (ev, ctx) => {
    lastCtx = ctx;
    if (ev.reason !== "startup" && ev.reason !== "new") { if (isOurs(ctx)) setStatus(ctx, statusLine(last, stats, paint(ctx))); return; }
    last = null; stats = null;
    const h = await runtime.health(settings);
    serverUp = !!h?.ok;
    const intended = wantsUs(settings);
    if (!h?.ok && settings.autoStart && intended) {
      const r = await bringUp(ctx, { install: true, start: true });
      serverUp = r.ok;
      if (!r.ok) { notify(ctx, `bedrouter: ${r.lines[r.lines.length - 1]}`, "warning"); setStatus(ctx, downLine("/bedrouter start", paint(ctx))); return; }
      const created = r.lines.filter((l) => l.startsWith("created "));
      if (created.length) notify(ctx, created.join("\n"), "warning");
    } else if (!h?.ok && intended) { setStatus(ctx, downLine("/bedrouter start", paint(ctx))); return; }
    else if (!intended) { setStatus(ctx, undefined); return; }
    await autoSelect(ctx);
    if (isOurs(ctx)) setStatus(ctx, readyText(ctx));
  });

  pi.on("model_select", async (ev, ctx) => {
    if (ev.model.provider !== settings.providerName) { setStatus(ctx, undefined); return; }
    const h = await runtime.health(settings);
    serverUp = !!h?.ok;
    if (!h?.ok && settings.autoStart) {
      const r = await bringUp(ctx, { install: true, start: true });
      serverUp = r.ok;
      if (!r.ok) { notify(ctx, `bedrouter: ${r.lines[r.lines.length - 1]}`, "warning"); setStatus(ctx, downLine("/bedrouter start", paint(ctx))); return; }
    }
    setStatus(ctx, serverUp ? statusLine(last, stats, paint(ctx)) : downLine("/bedrouter start", paint(ctx)));
  });

  // ---- live routing display ------------------------------------------------------------------------------------
  // Tag requests with Pi's session id: bedrouter's conversation key is derived from the system prompt and first user
  // message, so one Pi session becomes several conversations (compaction, sub-agents, prompt changes) and trivial or
  // pinned requests are not tracked at all. The session key is what /bedrouter usage and the footer total against.
  pi.on("before_provider_headers", async (ev, ctx) => {
    if (!isOurs(ctx)) return;
    const id = sessionId(ctx);
    if (id) ev.headers["x-bedrouter-session"] = id;
  });

  pi.on("after_provider_response", async (ev, ctx) => {
    if (!isOurs(ctx)) return;
    const d = fromHeaders(ev.headers ?? {});
    if (!d) return;
    last = d;
    serverUp = true;
    if (d.conversation) ourConversations.add(d.conversation);
    setStatus(ctx, statusLine(last, stats, paint(ctx)));
  });

  pi.on("agent_end", async (_ev, ctx) => {
    if (!isOurs(ctx) || !last) return;
    await refreshStats(ctx);
    setStatus(ctx, statusLine(last, stats, paint(ctx)));
  });

  // ---- background health poll ----------------------------------------------------------------------------------
  // Pi only tells us about responses; a server that dies between turns would leave the footer saying "ready".
  let poll: NodeJS.Timeout | null = null;
  async function checkHealth() {
    const ctx = lastCtx;
    if (!ctx || !isOurs(ctx)) return;
    const h = await runtime.health(settings);
    const up = !!h?.ok;
    if (up === serverUp) return;
    serverUp = up;
    if (up) { setStatus(ctx, readyText()); if (last) notify(ctx, "bedrouter: back up"); return; }
    setStatus(ctx, settings.autoStart ? restartingLine(paint(ctx)) : downLine("/bedrouter start", paint(ctx)));
    if (!settings.autoStart || Date.now() - restartAttemptAt < 60_000) return;
    restartAttemptAt = Date.now();
    // same path as startup: locate, build/install if needed, start
    const r = await bringUp(ctx, { install: true, start: true });
    serverUp = r.ok;
    if (r.ok) { setStatus(ctx, readyText()); notify(ctx, `bedrouter: restarted`); }
    else { setStatus(ctx, downLine("/bedrouter start", paint(ctx))); notify(ctx, `bedrouter: restart failed — ${r.lines[r.lines.length - 1].split("\n")[0]}`, "warning"); }
  }
  if (settings.healthPollS > 0) { poll = setInterval(() => void checkHealth(), settings.healthPollS * 1000); poll.unref(); }

  pi.on("session_shutdown", async (ev) => {
    if (poll) clearInterval(poll);
    // Only a real quit ends the server; /reload and session switches keep it (the next session picks it straight up).
    // The TUI is already gone at this point, so the policy is a setting, not a prompt (see stopOnExit).
    if (ev.reason !== "quit" || !startedHere || settings.stopOnExit === "never") return;
    if (settings.stopOnExit === "if-started-here" && (await br.othersActive(settings, ourConversations))) return;
    await br.stop(settings);
  });

  // ---- /bedrouter ------------------------------------------------------------------------------------------------
  const SUB = ["status", "start", "stop", "restart", "install", "doctor", "probe", "usage", "report", "log", "models", "fitnotes", "config", "help"];
  pi.registerCommand("bedrouter", {
    description: "bedrouter router: status | start | stop | restart | install | doctor | probe | usage [all] | report | log [n] | models | fitnotes | config",
    getArgumentCompletions: (prefix) => SUB.filter((s) => s.startsWith(prefix.trim())).map((value) => ({ value, label: value })),
    handler: async (args, ctx) => {
      const [sub = "status", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      settings = loadSettings();
      const located = br.locate(settings);
      const loc: br.Found | null = located.found ? located : null;
      const need = (): boolean => { if (!loc) notify(ctx, `bedrouter is not installed: ${(located as { reason: string }).reason}. Run /bedrouter install.`, "error"); return !!loc; };
      switch (sub) {
        case "status": {
          const h = await br.health(settings);
          const lines = [
            loc ? `install: ${loc.dir} (${loc.source}, v${loc.version}${loc.cli ? "" : ", NOT BUILT"})` : `install: missing (${(located as { reason: string }).reason})`,
            `home:    ${br.homeDir(settings)}`,
            `server:  ${h?.ok ? `up on ${br.baseUrl(settings)}, pid ${h.pid}, v${h.version}, region ${h.region}, routing ${h.routing ? "on" : "off"}, classifier ${h.classifier ?? "off"}, up ${h.uptimeS}s` : `down (${br.baseUrl(settings)})`}`,
            `provider: ${settings.providerName} → ${registeredModelIds.length ? registeredModelIds.join(", ") : "(not registered)"}`,
            `session:  ${isOurs(ctx) ? `using ${ctx.model?.id}` : `not using bedrouter (model ${ctx.model?.provider}/${ctx.model?.id})`}`,
            `last:     ${last ? `${last.requested} → ${last.model}  ${last.cls} · ${last.reason}${last.classifier ? `  classifier: ${last.classifier}` : ""}` : "-"}`,
            `on quit:  ${startedHere ? `server ${exitPolicyText()} (stopOnExit: ${settings.stopOnExit})` : "server was not started by this session; left alone"}`,
            `settings: ${settingsPath()}${fs.existsSync(settingsPath()) ? "" : " (defaults; /bedrouter config to create)"}`,
          ];
          show("bedrouter status", lines.join("\n"));
          break;
        }
        case "start": case "restart": {
          if (sub === "restart") notify(ctx, await br.stop(settings));
          const r = await bringUp(ctx, { install: false, start: true });
          show(`bedrouter ${sub}`, r.lines.join("\n"));
          serverUp = r.ok;
          if (r.ok) { await autoSelect(ctx); setStatus(ctx, isOurs(ctx) ? readyText(ctx) : undefined); }
          break;
        }
        case "stop": notify(ctx, await br.stop(settings)); serverUp = false; setStatus(ctx, isOurs(ctx) ? downLine("/bedrouter start", paint(ctx)) : undefined); break;
        case "install": {
          notify(ctx, "bedrouter: installing/building (this can take a minute)…");
          const r = await bringUp(ctx, { install: true, start: false });
          show("bedrouter install", r.lines.join("\n"));
          break;
        }
        case "doctor": case "probe": {
          if (!need() || !loc) break;
          if (sub === "probe") notify(ctx, "bedrouter: probing every rung with a 1-token request…");
          const r = br.run(settings, loc, sub === "probe" ? ["doctor", "--probe"] : ["doctor"]);
          show(`bedrouter ${sub}`, r.out);
          break;
        }
        case "usage": {
          const h = await br.health(settings);
          if (!h?.ok) { notify(ctx, `bedrouter is down (${br.baseUrl(settings)}); /bedrouter start`, "error"); break; }
          const id = sessionId(ctx);
          if (rest[0] === "all") { show("bedrouter usage: recent sessions on this server", sessionsTable(await br.recentSessions(settings), id ?? undefined)); break; }
          const { session, conversation } = await refreshStats(ctx);
          if (session) { show("bedrouter usage: this session", usageReport(session, { sessionId: id ?? undefined })); }
          else if (conversation) {
            // older bedrouter: no /v1/sessions; present the last conversation in the same shape
            show("bedrouter usage: this conversation", usageReport({ ...conversation, errors: 0, conversations: 1, cacheReadTokens: 0, byRoute: conversation.routedModel ? { [`${conversation.requestedModel ?? "?"} -> ${conversation.routedModel}`]: { requests: conversation.requests, costUsd: conversation.costUsd, requestedCostUsd: conversation.requestedCostUsd, inputTokens: conversation.inputTokens, outputTokens: conversation.outputTokens } } : {}, firstTs: conversation.lastTs }, { sessionId: id ?? undefined, conversationOnly: true }));
          } else show("bedrouter usage", isOurs(ctx) ? `nothing routed yet in this session (${id ?? "no session id"})` : `this session is not using bedrouter (model ${ctx.model?.provider}/${ctx.model?.id}); pick bedrouter/auto with /model`);
          if (isOurs(ctx) && last) setStatus(ctx, statusLine(last, stats, paint(ctx)));
          break;
        }
        case "report": {
          if (!need() || !loc) break;
          const r = br.run(settings, loc, ["report", ...rest]);
          show("bedrouter report", r.out);
          break;
        }
        case "log": {
          const n = Number(rest[0]) || 15;
          const raw = br.tail(br.decisionLog(settings), n);
          const lines = raw.split("\n").map((l) => { try { const j = JSON.parse(l); return `${j.ts.slice(11, 19)} ${String(j.requestedModel ?? "-").padEnd(12)} → ${String(j.routedModel ?? "-").padEnd(12)} ${String(j.class ?? "-").padEnd(7)} ${String(j.classReason ?? "-").padEnd(22)} ${j.outputTokens ?? "-"} out  ${j.costUsd != null ? "$" + j.costUsd.toFixed(5) : "-"}${j.escalated ? "  ↑" + j.escalationReason : ""}${j.error ? "  ✗ " + j.error : ""}`; } catch { return l; } });
          show(`bedrouter log (last ${n})`, lines.join("\n") || "(empty)");
          break;
        }
        case "models": {
          show("bedrouter models", await registerProvider(loc));
          break;
        }
        case "fitnotes": {
          const file = br.readConfig(settings, loc);
          const cfg = "config" in file ? file.config : (await br.liveConfig(settings)) ?? br.FALLBACK_CONFIG;
          const notes = fitNotes(cfg, settings.providerName);
          const wf = path.join(agentDir(), "workflows.json");
          let cur: { models?: Record<string, string> } = {};
          try { cur = JSON.parse(fs.readFileSync(wf, "utf8")); } catch { /* none */ }
          const preview = Object.entries(notes).map(([k, v]) => `${k}: ${v}`).join("\n");
          const ok = !ctx.hasUI || (await ctx.ui.confirm("Write pi-agents model notes?", `Merge these into ${wf} → models:\n\n${preview}`));
          if (!ok) break;
          fs.writeFileSync(wf, JSON.stringify({ ...cur, models: { ...(cur.models ?? {}), ...notes } }, null, 2) + "\n");
          notify(ctx, `bedrouter: wrote ${Object.keys(notes).length} model notes to ${wf}`);
          break;
        }
        case "config": {
          if (!fs.existsSync(settingsPath())) saveSettings(settings);
          show("bedrouter settings", `${settingsPath()}\n\n${fs.readFileSync(settingsPath(), "utf8")}\nKeys: path, home, port, autoStart, autoSelect (model id or false), debug, footer, providerName, healthPollS, stopOnExit (if-started-here | always | never). Edit the file, then /reload.`);
          break;
        }
        default:
          show("bedrouter", `/bedrouter ${SUB.join(" | ")}\n\nstatus    install, server, provider, current model, last decision\nstart     start the server if needed (seeds .env / bedrouter.json on first run)\nstop      stop the server (shared by all Pi sessions)\ninstall   npm install / build the bedrouter dependency\ndoctor    credential source + loaded ladder;  probe: 1-token call per rung\nreport    savings report over the decision log (args pass through: --since, --json)\nlog [n]   last n routing decisions\nmodels    re-read bedrouter.json and re-register the provider\nfitnotes  write pi-agents model notes so the planner defaults to the router\nconfig    show/create ${settingsPath()}`);
      }
    },
  });
}

export default activate;
