| [中文](./README.zh.md) | English |
| ---------------------- | ------- |

# DSH Carrot on a Stick

A [DSH](https://github.com/deepseek-ai/deepseek-harness) plugin that exposes DSH operations through the MCP protocol。

## MCP features

### Tools

| Tool              | Purpose                                                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dsh_get_started` | dsh crash course for the agent — concepts, recipes, error recovery. Call this first                                                                                                |
| `echo`            | connectivity check                                                                                                                                                                 |
| `dsh_status`      | plugin status: version, listening, uptime, queue counters, connected clients                                                                                                       |
| `dsh_list_tools`  | list the host's global tool registry                                                                                                                                               |
| `workspace_list`  | registered workspaces and their sessions                                                                                                                                           |
| `model_list`      | routable providers / models / reasoning efforts, and the current default                                                                                                           |
| `agent_run`       | run a task now, get a structured result back; `sessionId` continues a session; per-call `provider` / `model` / `reasoningEffort` / `preset`; cancellable, with progress heartbeats |
| `agent_steer`     | mid-run guidance to a running agent — `steer` acts at the next step boundary, `inject` adds context only                                                                           |
| `task_inbox`      | queue a background task, get a `taskId`; `idempotencyKey` dedupes retries                                                                                                          |
| `task_result`     | fetch a queued task's result (`detail: "status"` for cheap polling)                                                                                                                |
| `task_list`       | queue overview: queued / running / finished                                                                                                                                        |
| `task_cancel`     | cancel a queued (immediate) or running task (`cancelling` → `cancelled`)                                                                                                           |
| `session_list`    | known sessions (live + persisted), newest first                                                                                                                                    |
| `session_history` | recent turns of a session; `roles` filter (e.g. `["assistant"]`)                                                                                                                   |
| `select_model`    | switch an existing session's model, history preserved                                                                                                                              |
| `attach_session`  | attach a session to the workspace of its cwd                                                                                                                                       |
| `rename_session`  | rename a session                                                                                                                                                                   |

### Resources

Resource-capable clients can read the same data without spending tokens, and subscribe to changes instead of polling:

| URI                                           | Content                                   |
| --------------------------------------------- | ----------------------------------------- |
| `dsh://status[/config\|/stats\|/connections]` | deployment status                         |
| `dsh://guide[/{section}]`                     | dsh usage guide (markdown)                |
| `dsh://tools`                                 | host global tool registry                 |
| `dsh://models[/{provider}]`                   | model catalog                             |
| `dsh://presets`                               | legal `preset` ids                        |
| `dsh://workspaces[/{id}]`                     | workspace registry                        |
| `dsh://sessions[/{id}]`                       | session list / metadata                   |
| `dsh://sessions/{id}/history[/{before}]`      | conversation digest (paged)               |
| `dsh://sessions/{id}/events[/{after}]`        | raw event stream (JSONL, paged)           |
| `dsh://sessions/{id}/activity`                | live turn window                          |
| `dsh://queue[/{taskId}]`                      | queue / task detail incl. the full result |
| `dsh://agents`                                | resident session pool                     |

`resources/subscribe` pushes task status transitions, turn-end history refreshes, and live activity over SSE — no polling. Setting `resourceFirst: true` in the config retires the nine read-only tools and returns results as resource references (for clients confirmed to support MCP resources; default `false` keeps tools and resources coexisting).

## Everyday patterns

**One-off task** — synchronous, structured summary back; continue later with `sessionId` (send only the delta in `context`):

```json
{ "name": "agent_run", "arguments": { "task": "fix the failing test in src/auth", "cwd": "/workspace/app" } }
```

**Background queue** — submit, poll cheaply, fetch once done:

```json
{ "name": "task_inbox",   "arguments": { "task": "…", "cwd": "/workspace/app" } }
{ "name": "task_result",  "arguments": { "taskId": "…", "detail": "status" } }
{ "name": "task_cancel",  "arguments": { "taskId": "…" } }
{ "name": "task_result",  "arguments": { "taskId": "…" } }
```

**Sessions** — `session_list` to find one, `session_history` to read it, `select_model` to switch its model, `agent_steer` to redirect it mid-run.

**Models & presets**

-   Priority: **per-call arguments > plugin config > host default**. A half-set pair completes from the lower source; unresolvable calls fail loudly.
-   Three ways to change models: per-call `provider`+`model` · `select_model` mid-conversation · pin via config with `allowModelOverride: false`. Presets (`preset` argument, for new sessions) work the same way under `allowPresetOverride`.
-   Sessions are pooled per `cwd + model + preset`: same directory, different model/preset → a separate session. Taking over a session keeps its model and preset.
-   Continuing by `sessionId` runs in the session's own directory; an explicitly passed `cwd` must match it.

**Result size** — `detail` controls token cost: `summary` (default, a few hundred tokens) / `normal` (~2k) / `full` (debugging); `task_result` adds a `status` level for polling. Results are structured (`sessionId`, `model`, `changes`, `verification`, `leftovers`, …); failures come back with `isError: true`.

## Configuration (cordis.yml)

```yaml
- insert:
      - id: dsh-carrot-on-a-stick
        name: 'dsh-carrot-on-a-stick'
        config:
            http: true
            port: 8090
            host: 127.0.0.1 # localhost only by default; add auth before exposing
            # authToken: 'your-secret-token'
            # workspaceRoots: ['/workspace']   # cwd whitelist (also gates session surfaces)
            # allowedHosts: ['my-box.lan']     # extra allowed Host header values
            # preset: 'standard'               # agent preset to mount
            # model: ''                        # pair with provider; empty = follow host default
            # provider: ''
            # reasoningEffort: ''              # empty = adapter default
            # allowModelOverride: true         # false = pin the model
            # allowPresetOverride: true        # false = pin the preset
            # queuePersistPath: '.dsh/queue.json'
            # queuePersistKey: 'passphrase'    # encrypt the persistence file
            # sessionTtlMs: 86400000
```

| Field                                  | Default                 | Meaning                                                                                                                  |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `host` / `port`                        | `127.0.0.1` / `8090`    | MCP server bind address; a listen failure fails plugin startup                                                           |
| `authToken`                            | —                       | Bearer token; enforced on every request when set                                                                         |
| `workspaceRoots`                       | —                       | cwd whitelist — agents may only work inside listed directories; also limits which sessions can be taken over or read     |
| `allowedHosts`                         | —                       | extra allowed Host-header values (bind host and loopback always allowed)                                                 |
| `provider` / `model`                   | follow host settings    | default model for spawned agents; configure as a pair                                                                    |
| `reasoningEffort`                      | adapter default         | default reasoning effort (ids in `model_list`)                                                                           |
| `allowModelOverride`                   | `true`                  | whether callers may override the model per call                                                                          |
| `allowPresetOverride`                  | `true`                  | whether callers may pick a preset for new sessions                                                                       |
| `preset`                               | `standard`              | agent preset to mount (per-call `preset` applies to new sessions only)                                                   |
| `defaultDetail`                        | `summary`               | default `detail` level for `agent_run` / `task_result`                                                                   |
| `resourceFirst`                        | `false`                 | resource-first mode: read-only tools retire, results come back as resource references                                    |
| `reattachOrphans`                      | `false`                 | bulk-attach ungrouped sessions to workspaces at startup                                                                  |
| `maxQueue` / `taskTtlMs` / `maxAgents` | `100` / 24 h / `8`      | queue capacity, result retention, session-pool size                                                                      |
| `taskTimeoutMs`                        | `0` (off)               | auto-cancel an agent turn after this long                                                                                |
| `progressIntervalMs`                   | `5000` (min 250)        | progress heartbeat interval                                                                                              |
| `queuePersistPath`                     | — (off)                 | persist the task queue; finished results survive restarts, queued tasks re-execute, running tasks are marked interrupted |
| `queuePersistKey`                      | — (plaintext + warning) | encrypts the persistence file; wrong passphrase / corrupt file → queue starts empty                                      |
| `sessionTtlMs`                         | `86400000`              | idle MCP transport sessions are reaped after this (`0` = never)                                                          |

## Security

⚠️ This plugin exposes **local code execution** (equivalent to RCE). It binds `127.0.0.1` only. When enabling:

1.  Set `authToken` — protects against other local processes and DNS rebinding;
2.  Set `workspaceRoots` — without it there is no directory boundary at all; with it, execution and session reads (list / history / steer / takeover) are both constrained;
3.  Never bind `0.0.0.0` or expose to LAN/WAN without a reverse proxy + TLS + auth.

Built-in guards: Host- and Origin-header allowlists (DNS-rebinding guard), HTTP surface limited to `/mcp`, `401` answers with a Bearer challenge, idle transport sessions reaped after `sessionTtlMs`. Note that spawned sessions follow the host/preset **approval policy** — this plugin runs unattended, so `ask`-style policies may pop dialogs or fail closed; verify sensitive operations under your preset before deploying. If you enable `queuePersistPath`, task payloads are written to that file (plaintext unless `queuePersistKey` is set) — choose a location with appropriate permissions.

## Web settings panel

The bundle adds a **Settings → dsh-carrot-on-a-stick** section to the dsh web UI: live status badge, the MCP endpoint (click to copy), start/stop buttons, connected client list, and queue counters.

## Known limitations

-   Spawned sessions follow the host/preset approval policy — `ask`-style policies may pop a dialog or fail closed in unattended use.
-   `select_model` requires the web profile's `sessionController`; headless deployments fall back to the model catalog plus per-call overrides.
-   `dsh_list_tools` only lists the host-global registry; per-agent tool visibility needs a host-side API.
-   Without `queuePersistPath` the queue lives in memory and is lost on restart.

## Acknowledgements

Started as a copy of [`chushixixin/dsh-harness-mcp-server`](https://github.com/chushixixin/dsh-harness-mcp-server) (MIT, thanks @chushixixin), now an independent project.
