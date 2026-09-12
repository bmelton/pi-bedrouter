# pi-bedrouter

A [Pi](https://pi.dev) extension for [bedrouter](https://github.com/bmelton/bedrouter), the cost-aware model router in front of AWS Bedrock. It makes the router a first-class part of a Pi session:

- **finds bedrouter** (a configured checkout, or the npm dependency this package ships with) and installs or builds it when it is missing
- **starts the server** when it is not already running, seeding `.env` and `bedrouter.json` from bedrouter's examples on first run
- **registers a `bedrouter` provider** in Pi whose models come straight from `bedrouter.json`: the `auto` aliases (the router decides everything) plus each rung of each ladder
- **switches the session to `bedrouter/auto`** when the server is healthy, so nobody has to pick a model
- **shows what served each request in the footer**, live: routed model vs requested, class and deciding signal, the classifier's note, and the session's running cost against what the requested model would have cost
- **`/bedrouter`** for everything else: status, start/stop/restart, doctor and the per-rung entitlement probe, the savings report, the last N decisions, pi-agents fit notes

```
⇄ gpt-oss-120b ≠ gpt-oss-20b  explore·clf:explore  $0.0412 saved $0.0188 (31%)  ↑1
```

## Install

```sh
pi install npm:pi-bedrouter          # once published
# or, from a checkout:
pi install /path/to/pi-bedrouter     # or add the path to "packages" in ~/.pi/agent/settings.json
```

The package depends on `bedrouter` (a git dependency with a build step), so `npm install` inside it produces a runnable `bedrouter` binary. If you already have a bedrouter checkout you'd rather use, point at it (below) and the dependency is ignored.

Bedrouter needs AWS credentials that can call Bedrock; see its README for the `aws sso login` recipe. pi-bedrouter does not touch credentials, it just starts the server in a directory that has a `.env`.

## Settings

`~/.pi/agent/pi-bedrouter.json` (all optional; `/bedrouter config` creates it with defaults):

| Key | Default | Meaning |
| --- | --- | --- |
| `path` | the `bedrouter` dependency | A bedrouter checkout or install to use instead |
| `home` | `path` if set, else `~/.bedrouter` | Working directory for the server: `.env`, `bedrouter.json`, `bedrouter.log.jsonl`, `server.log` |
| `port` | `20129` | Port to run / expect the server on (`BEDROUTER_PORT` overrides) |
| `autoStart` | `true` | Start the server on session start when it is not running |
| `autoSelect` | `"auto"` | Model id to switch the session to when bedrouter is healthy (`"auto"`, `"auto-oss"`, a rung alias, or `false` to leave the model alone) |
| `debug` | `false` | Start the server with `BEDROUTER_DEBUG=1` (per-request trace in `server.log`) |
| `footer` | `true` | Show the routing status line in Pi's footer |
| `providerName` | `"bedrouter"` | Provider name registered in Pi |
| `stopOnExit` | `"if-started-here"` | What happens to the server when Pi **quits** (`/reload` and session switches never stop it). `if-started-here`: stop it if this session started it and no other client sent a request in the last 5 minutes; `always`: stop it whenever this session started it; `never`: leave it running. Pi tears down its UI before extensions are told about the quit, so this cannot be a prompt; the policy is shown when the server is started and in `/bedrouter status` |
| `healthPollS` | `15` | Seconds between background health checks. A dead server flips the footer to `bedrouter: DOWN` and, with `autoStart`, is restarted (at most once a minute); `0` disables the poll |

Example for a developer with a checkout:

```json
{ "path": "~/projects/ai/bedrouter", "autoSelect": "auto-oss" }
```

## Commands

| Command | Does |
| --- | --- |
| `/bedrouter` or `/bedrouter status` | Install location, server health (pid, version, region, classifier), registered models, current model, last decision |
| `/bedrouter start` / `stop` / `restart` | Manage the server. It is shared by every Pi session, so `stop` affects all of them; see `stopOnExit` for what happens when Pi quits |
| `/bedrouter install` | `npm install` the dependency, or `npm run build` a checkout that has no `dist/` |
| `/bedrouter doctor` | Which credential source resolved, expiry, the loaded ladder |
| `/bedrouter probe` | One 1-token request per rung: which models this AWS account can actually invoke |
| `/bedrouter report [--since t] [--json]` | Savings report over the decision log |
| `/bedrouter log [n]` | The last n routing decisions, one line each |
| `/bedrouter models` | Re-read `bedrouter.json` and re-register the provider (after editing the ladder) |
| `/bedrouter fitnotes` | Merge model notes into `~/.pi/agent/workflows.json` so the pi-agents planner defaults to `bedrouter/auto` and only pins premium rungs for planning/review |
| `/bedrouter config` | Show (and create) the settings file |

## How the footer works

Bedrouter echoes every routing decision in response headers (`x-bedrouter-model`, `-requested`, `-class`, `-reason`, `-conversation`, `-classifier`). Pi hands extensions those headers in the `after_provider_response` event, so the status line updates the moment a response starts, before any tokens stream. When the turn ends, the extension asks bedrouter for the conversation's running totals (`GET /v1/conversations/:key`) and appends cost: spend so far (classifier calls included), what the same tokens would have cost on the model the client asked for, and the difference as a percentage. `↑n` counts escalations in this conversation. The line clears when you switch to a non-bedrouter model. A background health check (every `healthPollS` seconds) keeps it honest between turns: if the server dies the line reads `bedrouter: DOWN` and, with `autoStart` on, the extension restarts it and says so.

Under a coding agent every request carries tools and a large system prompt, so you will see `execute` and `explore` decided by keywords or the classifier, then `sticky` for the rest of the session, `up:kw:explore` when an explicit design question moves the conversation up, and escalations after failures. `trivial` shows up for bare chat clients, not for Pi.

## Model ids

From bedrouter's example config: `auto` (Anthropic ladder, router decides), `auto-oss` (gpt-oss ladder), and the rungs `haiku`, `sonnet`, `opus`, `gpt-oss-20b`, `gpt-oss-120b`. Picking a rung is a floor: bedrouter may still go up (explore, escalation) but not below it. Picking `auto` hands it the whole decision. The `cost` Pi shows for `auto` is the family's execute rung; bedrouter's log and `/bedrouter report` have what was actually charged.

If your `~/.pi/agent/settings.json` has an `enabledModels` allowlist, add `bedrouter/auto` (and any rungs you want visible) or the provider's models will be hidden.

## Development

```sh
npm install
npm run typecheck
npm test                                        # pure tests
BEDROUTER_TEST_PATH=~/projects/ai/bedrouter npm test   # also exercises locate/start against a built checkout
```

Layout: `extensions/index.ts` (the extension: events, provider registration, `/bedrouter`), `src/bedrouter.ts` (locate/install/start/stop/health/run), `src/models.ts` (config → Pi models, fit notes), `src/footer.ts` (headers → status line), `src/settings.ts`.

## Publishing

Both packages are on npm: `bedrouter` (the server, with the `bedrouter` binary) and `pi-bedrouter` (this extension, which depends on it). The `pi-package` keyword makes the extension discoverable at pi.dev/packages. Release order when both change: publish `bedrouter` first, bump the dependency range here, then publish `pi-bedrouter`.
