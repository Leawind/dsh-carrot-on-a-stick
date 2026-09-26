/**
 * Agent 认知面: initialize 的 instructions 引导 + dsh_get_started 帮助文档。
 *
 * 工具描述只覆盖"单次调用"粒度, dsh 的整体工作流与概念词典(Harness/三级接管/preset/turn-step/
 * 审批策略)此前只存在于 README, 到不了 agent 侧。本文件把这两块做成协议内文本:
 *   SERVER_INSTRUCTIONS → 随 initialize result 下发(MCP 规范的 serverOptions.instructions),
 *     体积克制(几十行), 只讲心智模型 + 快速工作流, 指路 dsh_get_started;
 *   GET_STARTED_DOC → dsh_get_started 工具的静态返回值(纯文本, 无运行时依赖), 概念词典 +
 *     工作流食谱 + 错误→替代路径对照表。帮助文档按节拆分(GET_STARTED_SECTIONS), 工具的
 *     section 参数可只取一节——纠错场景不必把整份文档灌进调用方上下文。
 * 面向模型阅读, 英文为主(与 host 侧术语一致); 改内容时同步 README 与 smoke 断言。
 */

/** 随 MCP initialize result 下发的 server 引导文本(McpServer 第二参 serverOptions.instructions) */
export const SERVER_INSTRUCTIONS = `\
dsh-carrot-on-a-stick: an MCP bridge into a running dsh (DeepSeek Harness) process.
Your MCP client is the commander; dsh is the executor — every execution tool here spawns
or drives a dsh agent that has a full toolset (bash, fs, web, ...) inside the host.

Quick start:
- Call model_list before picking a model; pass provider+model as a pair to agent_run/task_inbox.
- agent_run runs a task synchronously and returns a structured result. Continue the same
  conversation later by passing the returned sessionId (send only the delta in context).
- For long or parallel work use task_inbox (returns taskId), poll task_result with
  detail=status, and cancel with task_cancel if needed.
- agent_steer redirects a running agent mid-turn; steering an idle session is refused (use agent_run).
- session_list / session_history let you find and inspect sessions; select_model switches
  an existing session's model in place (history preserved).
- Results are structured ({changes, verification, leftovers, ...}); failures come back with
  isError:true. Read-back is projected by the detail argument to save your context budget —
  default is summary.

If you are new to dsh, call the dsh_get_started tool first: it holds the concept glossary
(takeover tiers, presets, turn vs step, approval policy), workflow recipes, and an
error→alternative-path cheat sheet.`

/** dsh_get_started 的节 id: all=整份文档, 其余各取一节(section 参数可选项须与此对齐) */
export type GuideSection = 'all' | 'concepts' | 'workflows' | 'errors' | 'results' | 'limits'

/** 文档头(节 id 无关的开场白, 'all' 时在第一节前输出) */
const GUIDE_HEADER = `\
# dsh usage guide (for MCP clients)

This server bridges you into dsh (DeepSeek Harness), a local agent runtime.
You compose tasks; dsh agents execute them with a full toolset (bash, fs, web, todo, ...).
All tool names, arguments, and result shapes are described in each tool's own description —
this guide covers what those descriptions assume you already know.
`

/** 帮助文档的各节(section 参数按此取; 'all' = GUIDE_HEADER + 全部按序拼接) */
export const GET_STARTED_SECTIONS: Record<Exclude<GuideSection, 'all'>, string> = {
  concepts: `\
## Concepts

- **dsh / Harness** — the host process this plugin runs inside. Sessions, agents, model
  routing and presets all live there; the plugin only projects them over MCP.
- **Session kinds** — a session is one conversation with one dsh agent.
  - *live*: currently in memory in the host.
  - *pooled / resident*: kept alive after a task ends, keyed by \`cwd + model + preset\`
    (LRU, default 8) so follow-up calls skip reloading project context.
  - *persisted*: written to disk. History of a persisted-only session cannot be read back
    (the host exposes no full-log load API), but \`agent_run\` with its \`sessionId\` still
    resumes it.
- **Three-tier takeover** — \`sessionId\` in \`agent_run\` reattaches at the first tier that
  has it: pool → live → persisted resume. Same conversation, same context.
- **preset** — the persona mounted at session creation (an id from the host's
  \`agentPresets\` roster). Per-call \`preset\` applies to **new** sessions only; taking over
  an existing session keeps its original preset. Pool keys include it, so a "worker" and a
  "reviewer" can coexist in one directory.
- **provider / model / reasoningEffort** — the model selection. Valid values come from
  \`model_list\`; provider and model are a pair (a half is completed from the host default).
  The resident pool keys by the model triple: task on model A and task on model B in the
  same directory are two separate sessions.
- **turn vs step** — a *turn* is one full agent run ending in a structured result.
  *Steps* are the model rounds inside it. \`agent_steer\` (mode=steer) is consumed at the
  next step boundary of the current turn; \`select_model\` takes effect on the next step.
- **Approval policy** — the host may be configured to ask for confirmation on certain
  actions. In unattended deployments such prompts can fail closed; prefer tasks that do not
  depend on interactive approvals, and treat an \`error\` in the result as the signal.
`,
  workflows: `\
## Workflow recipes

1. **One-off task, synchronous** — \`agent_run\` with a task (and cwd). The result carries
   \`sessionId\`; pass it back later to continue that conversation (send only the delta).
2. **Fire-and-forget queue** — \`task_inbox\` → poll \`task_result\` with \`detail=status\`
   (never re-injects the payload) → fetch the summary once done; \`task_cancel\` to abort;
   \`task_list\` for the overview.
3. **Long synchronous runs** — pass \`_meta.progressToken\` on \`agent_run\` to receive
   \`notifications/progress\` heartbeats; cancel via the standard \`notifications/cancelled\`.
4. **Real-time steering** — \`agent_steer\` on a running sessionId/taskId: mode=steer
   redirects within the current turn; mode=inject queues context without waking the driver.
5. **Find and inspect sessions** — \`session_list\` (optionally filtered by cwd),
   \`session_history\` for recent turns (pass \`roles\` to keep only the turn types you
   need, e.g. \`["assistant"]\` to skip tool noise), \`select_model\` to switch models in place,
   \`rename_session\` / \`attach_session\` for housekeeping.
6. **Token-cheap browsing** — MCP resources mirror the read tools (\`dsh://status\`,
   \`dsh://queue\`, \`dsh://sessions\`, \`dsh://sessions/{id}/history\`, \`dsh://guide\`) for
   clients that support \`resources/read\`.
`,
  errors: `\
## Error → alternative path

| Situation | Do this instead |
|---|---|
| steering an idle session refused | \`agent_run\` to send a new task |
| history / steer of a persisted-only session | \`agent_run\` with that \`sessionId\` (resumes it) |
| \`select_model\` says sessionController unavailable | \`agent_run\` / \`task_inbox\` with \`provider\`+\`model\` |
| model / preset override refused | the deployment pinned it (\`allowModelOverride\`/\`allowPresetOverride: false\`); drop the override |
| cwd outside workspaceRoots | pick a directory under the configured roots (see \`dsh_status\`) |
| task queue full | \`task_list\` + \`task_cancel\` stale items, then resubmit |
`,
  results: `\
## Reading results without blowing your context

\`detail\` controls read-back size: \`summary\` (default, a few hundred tokens — the
changes/verification/leftovers summary + answer tail), \`normal\` (~2k, adds truncated tool
calls), \`full\` (everything, for debugging). \`task_result\` also has \`status\` for cheap
polling. Tool-level failures return \`isError: true\` with the reason in the payload.
`,
  limits: `\
## Deployment-imposed limits (visible via \`dsh_status\` / \`model_list\`)

- \`workspaceRoots\`: the cwd whitelist — execution, session takeover, and session reads all
  stop at this boundary.
- \`allowModelOverride\` / \`allowPresetOverride\`: whether you may pick model / preset per call.
- \`maxQueue\` / \`maxAgents\`: queue capacity and session-pool LRU limit.
- Plugin config and per-call arguments beat the host default; the result tells you which
  model/preset actually answered (\`model\` / \`preset\` fields).
`,
}

/** 整份帮助文档(GUIDE_HEADER + 各节按序拼接); dsh://guide 资源与工具的 section=all 同数据 */
export const GET_STARTED_DOC = GUIDE_HEADER + Object.values(GET_STARTED_SECTIONS).join('\n')

/** section 参数取单节的返回值; 非法 id 由 zod schema 拦下, 这里只处理合法枚举 */
export function guideSectionDoc(section?: GuideSection): string {
  if (!section || section === 'all') return GET_STARTED_DOC
  return GET_STARTED_SECTIONS[section]
}
