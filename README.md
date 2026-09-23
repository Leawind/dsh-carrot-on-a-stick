# dsh-ops-mcp

> Operate [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) over MCP: run an MCP server inside the dsh process and expose session execution, task queues, and workspace management to any MCP client.

[![npm version](https://img.shields.io/npm/v/dsh-ops-mcp)](https://www.npmjs.com/package/dsh-ops-mcp)
[![license](https://img.shields.io/npm/l/dsh-ops-mcp)](./LICENSE)

> 📖 English (this page) · [中文](./README.zh-CN.md)

## What it does

dsh ships a complete agent runtime — model routing, tool sandbox, presets, persistent sessions — but it is a Cordis application that external programs cannot call directly. dsh-ops-mcp turns it inside out: the plugin starts an MCP server (StreamableHTTP) inside the dsh process and bridges the live harness through `ctx.agents` / `ctx.agentPresets` / `ctx.tools`.

**Your MCP client is the commander; dsh is the executor.** Works with Claude Code, Codex CLI, Cursor, another dsh instance (via the official `dsh-mcp-client`), or any automation script.

```
MCP client (Claude Code / Codex / another dsh / …)
   │  agent_run / task_* / session_* / model_list / select_model (HTTP + Bearer)
   ▼
dsh-ops-mcp (MCP server, 127.0.0.1:8090)
   │  ctx.agents.create → mount preset
   ▼
dsh agent — full toolset: bash, fs, todo, web…
```

## Tools

| Tool | Purpose |
|---|---|
| `echo` | connectivity check |
| `dsh_list_tools` | list the host-global tool registry (name + description; model tools are preset-scoped, usually empty) |
| `model_list` | list currently routable providers, model ids, reasoning efforts, and the default selection (look here before picking a model) |
| `agent_run` | run a task synchronously, structured result; `sessionId` continues a session; `provider`/`model`/`reasoningEffort` pick this run's model; `detail` controls result size; cancellable via the MCP `notifications/cancelled` (the host agent's official `cancel` is invoked); reports `notifications/progress` heartbeats when the caller passes `_meta.progressToken` |
| `task_inbox` | push a structured task (task + context + cwd + model) into the async queue, returns `taskId` |
| `task_result` | fetch a queued task's result; `detail=status` is a lightweight poll that never re-injects the payload |
| `task_list` | list queued/running/finished tasks (queue observability) |
| `task_cancel` | cancel a queued or running task (a running one is cancelled through the host's official `agent.cancel`) |
| `session_list` | list known sessions (live + persisted, newest first) to pick `sessionId`s for continuation |
| `session_history` | read a live session's transcript summary (user/assistant/tool turns, newest first, truncated) |
| `select_model` | switch the model of an **existing session** (official `sessionController.selectModel` path) |
| `attach_session` | attach a session to the workspace of its cwd |
| `rename_session` | rename an existing session |

## Model selection

Priority: **per-call arguments > plugin config (`provider`+`model`) > host default selection** (`ctx.agentDefaultModel.currentSelection()`, the same source the Web UI uses when creating a session). Supplying only one half completes it from the lower-priority source; if the pair still cannot be resolved the call fails loudly instead of running with an empty model (an empty model leaves the persona's `{{model}}` variable unset and fails the whole turn at assembly time).

**`reasoningEffort` follows the model's source**: call argument > plugin config > the host default selection's own effort. But when the caller or the plugin config **pins provider+model explicitly**, the host's effort (chosen for some other model) is not inherited — the host rejects unsupported explicit efforts instead of clamping or aliasing, so inheriting one would break a deployment that used to work.

Three ways to change models:

| Goal | How |
|---|---|
| Run this one task on another model | pass `provider`+`model` (plus optional `reasoningEffort`) to `agent_run` / `task_inbox` |
| Switch models mid-conversation, keeping history | `select_model` (official `sessionController.selectModel`: validated, writes a durable notice, takes effect on the next step; history is preserved) |
| Pin one model for the whole deployment | set `provider`+`model` in the plugin config and `allowModelOverride: false` to refuse caller overrides |

Two source semantics worth knowing:

- **The resident session pool is keyed by `cwd + model triple`.** Task 1 on model A and task 2 on model B in the same directory are two separate sessions (no shared context), so which model a session uses is always predictable; to switch models inside one session, use `select_model`.
- Results now carry `model: {provider, model, reasoningEffort?}` so the caller never has to guess who answered.

`model_list`'s `source` names the catalog's origin: `sessionController` = the official view (same data source as the Web UI's model selector; includes `default`, `routableProviders`, per-provider load failures, and reasoning efforts); `llm` = fallback (`llm.listProviders()` + per-provider `listModels()`, for deployments without `sessionController`, e.g. headless, and without reasoning metadata). It also reports the plugin's own model config and `allowModelOverride`, so a caller can see at a glance whether it may choose.

**Result detail levels (token budget)** — the whole point of this plugin is saving the caller's (operator's) context: execution details stay inside dsh, and read-back is projected by `detail`:

- `summary` (default, a few hundred tokens): the `changes/verification/leftovers` three-line summary + the answer tail (the summary JSON sits at the end) + tool-name list + `error`
- `normal` (~2k tokens): the above + truncated tool-call arguments and results
- `full` (up to tens of thousands of tokens, for debugging): the full text
- `task_result` also has a `status` level: polling returns only `{taskId, status, error?}` — fetch the summary once after completion instead of re-injecting the payload on every poll

When continuing the same `sessionId`, the executor already remembers prior turns — send only the **delta** in `context`.

Every result is structured: `sessionId / model / assistantText / toolCalls / toolResults / changes / verification / leftovers` — ready to be persisted by the caller.

Sessions are reused per `cwd + model` (LRU, default 8) to avoid reloading project context on every call.

## Typical workflows

**1. One-off task, synchronous** — get a structured summary back:

```json
{ "name": "agent_run", "arguments": { "task": "fix the failing test in src/auth", "cwd": "/workspace/app" } }
```

Continue it later with `"sessionId": "<from the result>"` — send only the delta in `context`.

**2. Fire-and-forget queue** — submit, poll cheaply, cancel if needed:

```json
{ "name": "task_inbox", "arguments": { "task": "…", "cwd": "/workspace/app", "provider": "deepseek-official", "model": "…" } }
→ { "taskId": "…" }
{ "name": "task_result", "arguments": { "taskId": "…", "detail": "status" } }   // poll: no payload re-injection
{ "name": "task_cancel", "arguments": { "taskId": "…" } }                        // optional
{ "name": "task_result", "arguments": { "taskId": "…" } }                        // fetch the summary once done
```

`task_list` shows everything queued/running/finished at a glance.

**3. Discover and steer sessions** — find the right session, check its model, read what happened:

```json
{ "name": "session_list", "arguments": { "limit": 10 } }                // sessionId / title / cwd / model
{ "name": "session_history", "arguments": { "sessionId": "…" } }        // recent turns, truncated
{ "name": "select_model", "arguments": { "sessionId": "…", "provider": "…", "model": "…" } }
```

**4. Long synchronous runs** — `agent_run` supports MCP-native progress and cancellation: clients
that pass `_meta.progressToken` receive `notifications/progress` heartbeats, and any client can
cancel via the standard `notifications/cancelled` (both wired to the host agent's official
`cancel`). No custom polling protocol required.

## Install & run

The plugin must be installed into a dsh **profile directory** (the loader resolves plugin names from there; `--patch` alone from a repo checkout will not find the local package — see finding 1 in the [E2E report](./docs/e2e-0.1.5-rc.2.zh.md)):

```bash
git clone https://github.com/Leawind/dsh-ops-mcp.git
cd dsh-ops-mcp
npm install && npm run build
npm pack                                        # produces dsh-ops-mcp-<ver>.tgz

# install into the profile (Windows note: use the tarball; pnpm mangles file:D:/... specifiers)
pnpm -C ~/.dsh/profiles/<profile> add -w <path-to-tarball>

export DEEPSEEK_API_KEY=...                     # model credentials (or use what ~/.dsh already stores)
dsh --profile <profile> --patch ./cordis.yml --no-open --port 3081
```

The MCP server listens on `127.0.0.1:8090` (StreamableHTTP). Point any MCP client at `http://127.0.0.1:8090/mcp`.

### Client configuration

Generic (any streamable-http capable MCP client):

```json
{
  "mcpServers": {
    "dsh": {
      "url": "http://127.0.0.1:8090/mcp",
      "headers": { "Authorization": "Bearer <your-secret-token>" }
    }
  }
}
```

Let **another dsh** operate this one (add to the peer profile's `cordis.patch.yml`, using the official `dsh-mcp-client`):

```yaml
- id: mcp-dsh-ops
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: dsh
    transport: streamable-http
    url: http://127.0.0.1:8090/mcp
    headers:
      Authorization: 'Bearer <your-secret-token>'
```

## cordis.yml (patch format)

```yaml
- insert:
    - id: dsh-ops-mcp
      name: 'dsh-ops-mcp'
      config:
        http: true
        port: 8090
        host: 127.0.0.1        # localhost only by default; add auth before exposing
        # authToken: 'your-secret-token'   # Bearer token auth (constant-time compare)
        # workspaceRoots: ['/workspace']   # cwd whitelist (separator/case-safe cross-platform)
        # allowedHosts: ['my-box.lan']     # extra allowed Host header values (DNS-rebinding guard)
        # preset: 'standard'               # agent preset to mount
        # model: ''                        # empty = follow dsh user/default settings
        # provider: ''                     # pair with model; empty = follow host default
        # reasoningEffort: ''              # default reasoning effort (empty = adapter default)
        # allowModelOverride: true         # false = pin the model, refuse caller overrides
        # sessionTtlMs: 86400000           # idle MCP transport sessions are reaped after this (0 = never)
```

| Field | Default | Meaning |
|---|---|---|
| `host` / `port` | `127.0.0.1` / `8090` | MCP server bind address; a listen failure (port in use, …) fails plugin startup loudly |
| `authToken` | — | Bearer token; enforced on every request when set (constant-time compare) |
| `workspaceRoots` | — | cwd whitelist; agents may only work inside the listed directories (subdirs included) |
| `allowedHosts` | — | extra allowed Host-header values; the bind host and loopback aliases are always allowed, everything else gets 403 |
| `provider` / `model` | follow host user settings (`agentDefaultModel`) | spawned-agent model selection; **configure as a pair** — a partial setting is completed from the host default |
| `reasoningEffort` | adapter default | default reasoning effort (adapter-defined id, see `reasoningEfforts` in `model_list`) |
| `allowModelOverride` | `true` | whether callers (`agent_run`/`task_inbox`/`select_model`) may override the model; `false` pins it and refuses overrides explicitly |
| `preset` | `standard` | agent preset to mount |
| `defaultDetail` | `summary` | default detail level for `agent_run`/`task_result` (overridable per call via `detail`) |
| `reattachOrphans` | `false` | bulk-attach ungrouped sessions to workspaces at startup (writes user data; the `attach_session` tool remains available anytime) |
| `maxQueue` / `taskTtlMs` / `maxAgents` | `100` / 10 min / `8` | queue capacity, result TTL, session-pool LRU limit |
| `taskTimeoutMs` | `0` (off) | auto-timeout per agent turn; on expiry the host's official `agent.cancel({kind:'hook'})` fires and the result's `error` notes the timeout. Raise it for long-task deployments |
| `progressIntervalMs` | `5000` (min 250) | heartbeat interval for `notifications/progress` on `agent_run` — only active when the caller passes `_meta.progressToken` |
| `queuePersistPath` | — (off) | persist the task queue to this file: every change is written, and on startup `done`/`error`/`cancelled` tasks come back with their results, `queued` tasks re-execute, and `running` tasks are honestly marked `interrupted by restart` |
| `sessionTtlMs` | `86400000` (24 h) | reap idle MCP transport sessions after this long; clients get 404 on the stale session id and re-initialize per the spec (`0` = never reap) |

Every result is structured: `sessionId / model / changes / verification / leftovers / error / toolCallCount …` (projected by `detail` level); `error` carries non-normal turn endings (model failure / cancel / blocked), so a silent empty "success" can no longer happen. Empty `error`/`taskId` fields are omitted rather than sent as empty strings. Tool-level failures (unknown `taskId`, model override refused, service unavailable, cwd outside `workspaceRoots`, a turn that ended in error) come back as tool results **with `isError: true`** (the MCP-spec-recommended shape) — strict clients and models can recognize them without parsing the payload.

## Zero host copies

The plugin has **zero runtime dependencies on `@deepseek-ai/*`**: every dsh capability is reached
through injected host services (`ctx.agents` / `ctx.tools` / `ctx.agentPresets` …), types only
augment the compiler via `import type` (erased at build), and `@deepseek-ai/*` packages are
devDependencies. A plugin therefore can never drag a mismatched copy of a host package into the
process — the root cause behind the upstream-era `scopeOf` symbol mismatch that silently left
agents tool-less. Event reads go through the public `session.snapshotEvents()` API and message
construction uses a local, field-for-field equivalent of the host's `createUserMessage`.

## Security

⚠️ This plugin exposes **local execution capability** (equivalent to RCE). It binds `127.0.0.1` only by default. When enabling:

1. Set `authToken` — against other local processes and DNS-rebinding attacks (constant-time compare);
2. Set `workspaceRoots` — constrain where agents may work;
3. Never bind `0.0.0.0` or expose to LAN/WAN without a reverse proxy + TLS + auth.

Built-in guards: a Host-header allowlist (bind host + loopback aliases by default, guarding against
DNS rebinding; a missing Host header gets 400), an Origin-header check on the same allowlist
(requests that carry a cross-origin or unparseable `Origin` — e.g. `Origin: null` — get 403;
non-browser MCP clients that send no Origin are unaffected), a `/mcp`-only HTTP surface (everything
else 404), `401` answers with a `WWW-Authenticate: Bearer` challenge, and idle transport sessions
are reaped after `sessionTtlMs` (24 h default). Tools also carry spec-metadata (`title`,
`annotations.readOnlyHint` etc., the 2025-06-18 protocol fields) so clients can label and
sandbox-check them. Note: `queuePersistPath` writes task payloads (task text, caller context,
results) to a plaintext file — point it at a location with appropriate filesystem permissions.

## Provenance

The initial source of this project was **copied from** [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks @chushixixin) and then evolved as an independent project — no git fork relationship, no upstream contributions planned. Key changes:

- drops the Hermes-specific framing — targets any MCP client;
- tracks current dsh releases (see Roadmap);
- independent name and repository: `dsh-ops-mcp`.

## Roadmap / known limitations (against dsh 0.1.5-rc.2)

The 0.2.0 compatibility issues were fixed in 0.3.0; **0.3.1 completed live-host E2E verification** (all green — see [docs/e2e-0.1.5-rc.2.zh.md](./docs/e2e-0.1.5-rc.2.zh.md)) and fixed what it uncovered: the `{{model}}` prompt variable (model selection now completed via `agentDefaultModel`), turn-failure surfacing, pool-session flush, startup reattach off by default, and corrected install docs.
**0.5.0 completed the model-selection surface**: `model_list` (official catalog / `llm` fallback), per-call overrides on `agent_run` + `task_inbox`, `select_model` (in-session switch), `reasoningEffort`, the `allowModelOverride` gate, `model` reported in every result, and a session pool keyed by `cwd + model`.
**0.6.0 tightened MCP-spec conformance**: tool errors now carry `isError: true`, an Origin-header check joins the DNS-rebinding guards, `401` includes a `WWW-Authenticate` challenge, tools expose `title` + `annotations`, idle transport sessions are reaped (`sessionTtlMs`), and the GUI panel shows the TTL.
**0.7.0 completed the cancellation & observability surface**: `agent_run` honours the MCP `notifications/cancelled` (wired to the host's official `agent.cancel({kind:'user'})`), and new `task_cancel` / `task_list` / `session_list` tools make the queue listable+cancellable and sessions discoverable — both previously open roadmap items.
**0.8.0 closed the last roadmap gap in this area**: optional `taskTimeoutMs` auto-timeout (official hook-cause cancel + `error` annotation), `session_list` surfaces live session titles, GUI queue stats split failed/cancelled.
**0.9.0 added opt-in queue persistence** (`queuePersistPath`): task state survives restarts — finished results stay fetchable, queued tasks re-execute, interrupted running tasks are reported honestly. `running` status is now only set when a task actually starts executing (lock acquired), so `task_list` distinguishes queued from running precisely.
**0.10.0 completed the interactive surface**: `notifications/progress` heartbeats for `agent_run` (spec `_meta.progressToken`), and a read-only `session_history` tool for live-session transcripts. A full protocol audit is documented in [docs/protocol-audit-2026-09-24.zh.md](./docs/protocol-audit-2026-09-24.zh.md).

What remains:

- [x] ~~The task queue lives in process memory; a restart loses it~~ — 0.9.0 added opt-in persistence (`queuePersistPath`); without it, the queue is still memory-only.
- [x] ~~No server-side timeout for `agent_run` / `task_inbox`~~ — 0.8.0 added the opt-in `taskTimeoutMs` (off by default); callers can also cancel actively (`notifications/cancelled` for `agent_run`, `task_cancel` for queue tasks).
- [x] ~~The queue cannot be listed or cancelled either~~ — done in 0.7.0 (`task_list` / `task_cancel`).
- [x] ~~Read-only query surface is still incomplete~~ — `session_list` (0.7.0) + `session_history` (0.10.0, live sessions) join `attach_session` / `rename_session` / `select_model`; reading the full log of persisted-only sessions needs a host-side load API.
- [ ] `preset` remains deployment-level (one persona per MCP server instance); it cannot be chosen per call.
- [ ] Tool calls inside spawned sessions go through the host approval policy (sensitive operations under `ask` may pop a dialog or fail closed; the read-only E2E operation was unaffected).
- [ ] `dsh_list_tools` only lists the host-global registry; listing an agent's actually-visible tools needs a host-side API (the ScopeKey is a private symbol, unreachable under the zero-copy principle).
- [ ] `select_model` requires the web profile's `sessionController`; where that service is absent (e.g. headless) only the catalog fallback and per-call overrides work, and the tool says so explicitly.
- [ ] Protocol-native task augmentation (2025-11-25 draft, SDK marks the interfaces experimental): `agent_run` as a spec-native task with `tasks/get` / `tasks/result` polling. Deliberately deferred — our `task_inbox` / `task_result` / `task_cancel` already cover the workflow for all clients; revisit when the spec leaves draft.
- [ ] When dsh releases new versions, the `@deepseek-ai/*` devDependencies need syncing (compile-time only; the zero-runtime-dependency design is unaffected).

## Development

```bash
npm install
npm run build    # standalone build (plain tsc) -> lib/
npm run smoke    # fake-ctx smoke on ports 8099/8098/8096/8095/8094/8093/8092/8091/8089/8088 (104 checks, real MCP protocol round-trips)
                 # + a port-conflict case (apply must fail loudly)
```

Live-host E2E (needs a local dsh with model credentials; costs a few tokens): boot a dedicated
profile as described in [docs/e2e-0.1.5-rc.2.zh.md](./docs/e2e-0.1.5-rc.2.zh.md), then run
`E2E_WITH_AGENT=1 node e2e.mjs`.

## License

MIT — see [LICENSE](./LICENSE) (upstream copyright notice retained).
