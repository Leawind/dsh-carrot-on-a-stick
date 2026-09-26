/**
 * MCP 工具注册(17 个)与模型目录 + MCP resources 面(5 个只读资源)。
 *
 * 用 registerTool(而非 tool): 带 title 与 annotations(2025-06-18 协议新增字段)。
 * annotations 是给调用方/模型的行为提示, 不影响执行:
 *   readOnlyHint=true   → 纯查询, 不改变任何状态(echo/dsh_list_tools/model_list/task_result/dsh_status/workspace_list)
 *   destructiveHint=false → 有写副作用但不具破坏性(转向/改模型/改名/归组: 历史保留、幂等可重试)
 * 三个 list 类工具(model_list/task_list/session_list)另带 outputSchema(zod 派生):
 * 成功结果带 structuredContent(SDK 按 schema 校验), 强类型客户端免二次解析。
 * 资源面(registerResources)与工具共用 collectSessions/sessionHistoryPayload/listTasksPayload
 * 等实现——两个面同数据同白名单边界。
 */
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { PLUGIN_VERSION } from './config.js'
import { state, sweepExpiredTasks } from './state.js'
import type { ModelSelection, ModelSelectionOverride, TaskItem } from './types.js'
import { canonicalCwd, canonicalizeAllowedCwd, isWithin, sessionCwdRefusal } from './paths.js'
import { DETAIL_ARG, historyTurnsOf, projectModel, renderResult } from './projection.js'
import type { HistoryRole } from './projection.js'
import { executeTask, hostDefaultSelection, knownSelectionOf, rekeyPooledSession, resolveLiveAgent, selectionOverrideOf } from './engine.js'
import { asSessionId, ensureWorkspace, eventsOf, findSessionHeader, headerOfSnapshot, serviceOf, userMessage } from './host.js'
import { GET_STARTED_DOC, guideSectionDoc, type GuideSection } from './onboarding.js'

/** 工具回调统一返回 MCP text content */
function out(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

/** 工具执行错误: 同样的 JSON 文本载荷, 但带 isError 标记(MCP 规范: 工具错误 SHOULD 以 result.isError 表达, 不走协议级错误) */
function outError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

/**
 * 带 outputSchema 的工具统一走这里: text 镜像 + structuredContent 同源同值。
 * 先 schema.parse 再回——SDK 会对成功结果按 outputSchema 校验 structuredContent(isError 结果跳过校验),
 * parse 不过说明实现与 schema 漂移, 宁可当场炸出来也不静默降级。
 */
function structuredOut<T>(value: unknown, schema: z.ZodType<T>): { content: { type: 'text'; text: string }[]; structuredContent: T } {
  const parsed = schema.parse(value)
  return { content: [{ type: 'text' as const, text: JSON.stringify(parsed, null, 2) }], structuredContent: parsed }
}

// ── 模型目录(model_list) ──

/**
 * sessionController 视图(web profile 提供; 可选依赖): 官方模型目录 + "切换会话模型"入口。
 * 官方 UI 的模型选择器走的就是这两个方法, 所以插件不自己维护 provider/模型清单。
 */
interface SessionControllerView {
  modelCatalog?: () => Promise<ModelCatalogView>
  selectModel?: (
    request: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string },
  ) => Promise<{ selected?: ModelSelection } | undefined>
}

/** 官方模型目录形状(只声明本插件读的字段; 未声明的一律不碰) */
interface ModelCatalogView {
  default?: ModelSelection
  routableProviders?: readonly string[]
  groups?: readonly ModelCatalogGroupView[]
  failures?: readonly { id?: string; name?: string; message?: string }[]
}
interface ModelCatalogGroupView {
  id?: string
  name?: string
  models?: readonly {
    id?: string
    name?: string
    reasoning?: { efforts?: readonly { id?: string; name?: string }[]; defaultEffort?: string }
  }[]
}

/** llm 服务视图(sessionController 缺席时的目录回退; llm 是核心服务, 但最小假 ctx 里可能只有空对象) */
interface LlmView {
  listProviders?: () => readonly { id?: string; name?: string }[]
  listModels?: (provider: string) => Promise<readonly { id?: string; name?: string }[]>
}

/** 目录里的模型投影: 只留 id/name + 推理档(选 reasoningEffort 要用), 丢掉 description 等长字段省上下文 */
function projectCatalogModel(m: { id?: string; name?: string; reasoning?: { efforts?: readonly { id?: string; name?: string }[]; defaultEffort?: string } }): Record<string, unknown> {
  const id = m.id ?? ''
  const o: Record<string, unknown> = { id, name: m.name ?? id }
  const efforts = (m.reasoning?.efforts ?? []).map((e) => ({ id: e.id ?? '', name: e.name ?? e.id ?? '' }))
  if (efforts.length) o.reasoningEfforts = efforts
  if (m.reasoning?.defaultEffort) o.defaultReasoningEffort = m.reasoning.defaultEffort
  return o
}

/**
 * 收集当前可路由的模型目录。两个来源:
 *   1. sessionController.modelCatalog() —— 官方口径(含 default / routableProviders / 各 provider 的加载失败),
 *      与 Web UI 模型选择器同一数据源;
 *   2. 回退: llm.listProviders() + 逐个 listModels() —— 只服务会话控制器缺席的部署(如 headless),
 *      逐个 provider 隔离失败, 且不含推理档元数据(那需要 resolveModelInfo, 这里不逐模型发请求)。
 * 同时回报插件自身的模型配置与 allowModelOverride, 让调用方知道"能不能自己选"。
 */
async function collectModelCatalog(ctx: Context, only?: string): Promise<Record<string, unknown>> {
  const failures: { id: string; name?: string; message: string }[] = []
  let source = 'none'
  let groups: { id: string; name: string; models: Record<string, unknown>[] }[] = []
  let routable: string[] = []
  let def: ModelSelectionOverride | undefined

  const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
  if (typeof sc?.modelCatalog === 'function') {
    try {
      const cat = await sc.modelCatalog()
      source = 'sessionController'
      def = cat.default
      routable = [...(cat.routableProviders ?? [])]
      groups = (cat.groups ?? []).map((g) => {
        const id = g.id ?? ''
        return { id, name: g.name ?? id, models: (g.models ?? []).map(projectCatalogModel) }
      })
      for (const f of cat.failures ?? []) {
        failures.push({ id: f.id ?? '', ...(f.name ? { name: f.name } : {}), message: f.message ?? 'unknown failure' })
      }
    } catch (e) {
      failures.push({ id: 'sessionController', message: String((e as Error)?.message ?? e) })
    }
  }

  const llm = serviceOf<LlmView>(ctx, 'llm')
  if (source !== 'sessionController' && typeof llm?.listProviders === 'function') {
    source = 'llm'
    const providers = llm.listProviders()
    routable = providers.map((p) => p.id ?? '').filter(Boolean)
    groups = await Promise.all(routable.map(async (id) => {
      const name = providers.find((p) => (p.id ?? '') === id)?.name ?? id
      try {
        const models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
        return { id, name, models: models.map(projectCatalogModel) }
      } catch (e) {
        failures.push({ id, name, message: String((e as Error)?.message ?? e) })
        return { id, name, models: [] }
      }
    }))
  }

  // 缺省选择: 官方目录优先, 其次宿主默认选择(agentDefaultModel)
  if (def === undefined) def = hostDefaultSelection(ctx)
  const q = only?.trim()
  const filtered = q ? groups.filter((g) => g.id === q) : groups
  return {
    source,
    default: projectModel(def),
    routableProviders: q ? routable.filter((p) => p === q) : routable,
    providers: filtered,
    ...(failures.length ? { failures } : {}),
    config: {
      provider: state.config.provider || null,
      model: state.config.model || null,
      reasoningEffort: state.config.reasoningEffort || null,
      allowModelOverride: state.config.allowModelOverride,
    },
  }
}

/** registerTools 的可选依赖(apply 级闭包才有数据的能力经它注入; 缺省退回 state 级基础快照) */
export interface ToolDeps {
  /** 完整状态快照(版本/监听/uptime/配置摘要/队列计数/连接; index.ts statusSnapshot 同源) */
  statusSnapshot?: () => Record<string, unknown>
}

/** state 级基础状态快照(deps.statusSnapshot 缺省时 dsh_status 的退路; 不含监听/连接等 apply 级数据) */
export function basicStatusSnapshot(): Record<string, unknown> {
  let queueActive = 0
  let queueDone = 0
  let queueError = 0
  let queueCancelled = 0
  for (const t of state.taskQueue.values()) {
    if (t.status === 'queued' || t.status === 'running') queueActive++
    else if (t.status === 'done') queueDone++
    else if (t.status === 'cancelled') queueCancelled++
    else queueError++
  }
  return {
    name: 'dsh-carrot-on-a-stick',
    version: PLUGIN_VERSION,
    config: {
      provider: state.config.provider || '(跟随宿主默认)',
      model: state.config.model || '(跟随宿主默认)',
      preset: state.config.preset,
      allowModelOverride: state.config.allowModelOverride,
      allowPresetOverride: state.config.allowPresetOverride,
      defaultDetail: state.config.defaultDetail,
      maxAgents: state.config.maxAgents,
      maxQueue: state.config.maxQueue,
      workspaceRoots: state.config.workspaceRoots,
    },
    stats: { liveAgents: state.liveAgents.size, queue: { active: queueActive, done: queueDone, error: queueError, cancelled: queueCancelled } },
  }
}

// ── 工具与资源共享的实现(两个面同数据同白名单边界) ──

/** task_list / dsh://queue 的共享实现: 队列快照(顺带 TTL 清理 + 落盘) */
function listTasksPayload(status?: string): Record<string, unknown>[] {
  sweepExpiredTasks() // 顺带清一次过期项, 防列表被撑大
  state.hooks.persistQueue()
  return [...state.taskQueue.values()]
    .filter((t) => !status || t.status === status)
    .map((t) => ({
      taskId: t.id,
      status: t.status,
      ...(t.sessionId ? { sessionId: t.sessionId } : {}),
      createdAt: t.createdAt,
      ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
      cwd: t.cwd,
      ...(t.error ? { error: String(t.error).slice(0, 200) } : {}),
    }))
}

/**
 * session_list / dsh://sessions 的共享实现: live + 持久化合并(live 优先), 白名单裁剪, cwd 过滤
 * (total 为过滤后计数)。cwd 参数越界时抛错(与 agent_run 的 cwd 拒绝同风格)。
 */
async function collectSessions(ctx: Context, cwd?: string): Promise<{ total: number; sessions: Record<string, unknown>[] }> {
  // 与 reattachOrphanSessions 同款合并: live 优先, 持久化侧兼容快照/裸 header 两种形状
  const headers = new Map<string, SessionHeader>()
  const liveTitles = new Map<string, string>()
  const sessions = ctx.get('sessions') as { list?: () => { header: SessionHeader; title?: unknown }[] } | undefined
  for (const session of sessions?.list?.() ?? []) {
    headers.set(session.header.id, session.header)
    // live 会话对象可能带 title(sessionTitle 服务维护); 机会式读取, 没有就省略字段
    if (typeof session.title === 'string' && session.title) liveTitles.set(session.header.id, session.title)
  }
  const persistence = ctx.get('sessionPersistence') as { list?: () => Promise<readonly unknown[]> } | undefined
  for (const snap of (await persistence?.list?.()) ?? []) {
    const header = headerOfSnapshot(snap)
    if (header && !headers.has(header.id)) headers.set(header.id, header)
  }
  // cwd 过滤参数在白名单模式下也受白名单约束(与 agent_run 的 cwd 拒绝同风格, 越界直接 isError)
  const whitelistActive = state.config.workspaceRoots.length > 0
  const filterRoot = cwd ? await canonicalCwd(resolve(cwd)) : undefined
  if (filterRoot !== undefined && whitelistActive && !state.config.workspaceRoots.some((root) => isWithin(root, filterRoot))) {
    throw new Error(`cwd not allowed (outside workspaceRoots): ${filterRoot}`)
  }
  // 白名单模式: 只列白名单内会话(header 无 cwd 无法验证, 一并排除)——会话清单与执行面同一边界
  const visible = [...headers.values()]
    .filter((h) => {
      const sessionCwd = h.cwd
      if (whitelistActive) {
        if (sessionCwd === undefined) return false
        if (!state.config.workspaceRoots.some((root) => isWithin(root, sessionCwd))) return false
      }
      return filterRoot === undefined || (sessionCwd !== undefined && isWithin(filterRoot, sessionCwd))
    })
  const items = visible
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((h) => {
      const model = knownSelectionOf(ctx, h.id)
      return {
        sessionId: h.id,
        createdAt: h.createdAt,
        ...(liveTitles.get(h.id) ? { title: liveTitles.get(h.id) } : {}),
        ...(h.cwd ? { cwd: h.cwd } : {}),
        ...(h.agentPreset ? { agentPreset: h.agentPreset } : {}),
        ...(model ? { model: projectModel(model) } : {}),
      }
    })
  return { total: visible.length, sessions: items }
}

/** session_history / dsh://sessions/{id}/history 的共享实现(工具与资源同数据同边界)。不可读时抛错。 */
async function sessionHistoryPayload(ctx: Context, sessionId: string, limit: number, beforeIndex?: number, roles?: HistoryRole[]): Promise<Record<string, unknown>> {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const session = sessions?.get?.(sessionId)
  if (!session) {
    throw new Error(`session not live: ${sessionId} (persisted-only sessions cannot be read back; host does not expose a full-log load API)`)
  }
  // 白名单模式: 会话内容读取与执行面同一边界(越界会话不可读)
  if (state.config.workspaceRoots.length > 0) {
    const refusal = await sessionCwdRefusal(sessionId, (session as { header?: SessionHeader }).header?.cwd)
    if (refusal) throw new Error(refusal)
  }
  const events = eventsOf(session)
  return { sessionId, totalEvents: events.length, turns: historyTurnsOf(events, limit, beforeIndex, roles) }
}

// ── 结构化输出 schema: 用 zod 定义一份, JSON Schema(tools/list 下发)与返回值校验都由它派生, 不手写 JSON Schema ──
// MCP 规范要求 structuredContent 是对象 → task_list 的数组与 dsh://queue 资源包成 { tasks }(text 镜像同步改)。

const taskItemOut = z.object({
  taskId: z.string(),
  status: z.enum(['queued', 'running', 'done', 'error', 'cancelled']),
  sessionId: z.string().optional(),
  createdAt: z.number(),
  finishedAt: z.number().optional(),
  cwd: z.string(),
  error: z.string().optional(),
})
const taskListOut = z.object({ tasks: z.array(taskItemOut) })

const sessionItemOut = z.object({
  sessionId: z.string(),
  createdAt: z.number(),
  title: z.string().optional(),
  cwd: z.string().optional(),
  agentPreset: z.string().optional(),
  model: z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    reasoningEffort: z.string().optional(),
  }).optional(),
})
const sessionListOut = z.object({ total: z.number(), sessions: z.array(sessionItemOut) })

const modelSelectionOut = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  reasoningEffort: z.string().optional(),
})
const modelCatalogOut = z.object({
  source: z.string(),
  default: modelSelectionOut,
  routableProviders: z.array(z.string()),
  providers: z.array(z.object({
    id: z.string(),
    name: z.string(),
    models: z.array(z.object({
      id: z.string(),
      name: z.string(),
      reasoningEfforts: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
      defaultReasoningEffort: z.string().optional(),
    })),
  })),
  failures: z.array(z.object({ id: z.string(), name: z.string().optional(), message: z.string() })).optional(),
  config: z.object({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    reasoningEffort: z.string().nullable(),
    allowModelOverride: z.boolean(),
  }),
})

/** 在给定 McpServer 上注册全部工具 */
export function registerTools(mcp: McpServer, ctx: Context, deps?: ToolDeps): void {
  // agent 认知入口: 静态帮助文档(概念词典/工作流/排错对照), 不了解 dsh 的模型先读这个再动手。
  // section 参数只取一节: 纠错场景(如只想查错误→替代路径表)不必把整份文档灌进调用方上下文。
  mcp.registerTool(
    'dsh_get_started',
    {
      title: 'dsh usage guide',
      description: 'If you are new to dsh, call this first: concept glossary (sessions, takeover tiers, presets, turn vs step, approval policy), workflow recipes, and an error→alternative-path cheat sheet. Pass section to fetch just one part instead of the whole guide. Returns a static markdown guide; no side effects.',
      inputSchema: {
        section: z.enum(['all', 'concepts', 'workflows', 'errors', 'results', 'limits']).optional().describe('all=整份文档(默认); concepts=概念词典; workflows=工作流食谱; errors=错误→替代路径对照表; results=detail 分级与结果阅读; limits=部署方配置约束'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ section }) => out(guideSectionDoc(section as GuideSection | undefined)),
  )

  mcp.registerTool(
    'echo',
    {
      title: 'Echo',
      description: '回显输入, 验证 MCP server 连通',
      inputSchema: { text: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => {
      return out(`收到: ${text} @ ${Date.now()}`)
    },
  )

  mcp.registerTool(
    'dsh_list_tools',
    {
      title: 'List dsh tools',
      description: '列出宿主全局工具注册表(name + description)。注意: 0.1.5+ 的模型工具挂在 preset/agent 作用域, 全局表通常为空(见返回的 note 字段); agent 实际可用的工具以 agent_run 结果里的 toolCalls 为准。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      // 0.1.5+: ctx.tools.schemas() 投影全局可见工具; 更早版本的 keys() 作为回退
      const tools = ctx.tools as unknown as
        | { schemas?: () => { name: string; description?: string }[]; keys?: () => Iterable<string> }
        | null
      let list: { name: string; description?: string }[]
      if (tools && typeof tools.schemas === 'function') {
        list = tools.schemas().map((s) => ({ name: s.name, description: s.description ?? '' }))
      } else if (tools && typeof tools.keys === 'function') {
        list = Array.from(tools.keys(), (n) => ({ name: n, description: '' }))
      } else {
        list = []
      }
      // 盲区自述随数据一起返回: 调用方(模型)在拿到空列表时能当场看到原因与替代路径
      return out(JSON.stringify({
        source: 'global-registry',
        note: '0.1.5+ 的模型工具挂在 preset/agent 作用域, 此全局表通常为空; agent 实际可用的工具以 agent_run 结果里的 toolCalls 为准(想确认某能力是否可用, 直接跑个小任务看 toolCalls)',
        tools: list,
      }))
    },
  )

  // 插件状态(只读): headless/脚本场景不开 Web 面板也能看部署状态与队列计数
  mcp.registerTool(
    'dsh_status',
    {
      title: 'Plugin status',
      description: '查看插件部署状态(只读): 版本/监听状态/uptime/配置摘要/队列计数(active/done/error/cancelled)/常驻会话数/连接的 MCP 客户端。Web 设置面板同源数据; 未配 workspaceRoots 时 workspaceRoots 为空数组。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => out(JSON.stringify(deps?.statusSnapshot?.() ?? basicStatusSnapshot(), null, 2)),
  )

  // 工作区清单(只读): workspaceRegistry 的花名册(id/路径/会话归属)
  mcp.registerTool(
    'workspace_list',
    {
      title: 'List workspaces',
      description: '列出已注册的工作区(id/路径/归属会话)。工作区归组是锦上添花(attach_session 可随时补挂); workspaceRegistry 服务缺席(headless 类部署)时明确报不可用。',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const registry = serviceOf<{ list?: () => { id?: string; path?: string; sessionIds?: readonly SessionId[] }[] }>(ctx, 'workspaceRegistry')
      if (typeof registry?.list !== 'function') {
        return outError(JSON.stringify({ error: 'workspaceRegistry service unavailable (headless deployment has no workspace grouping)' }))
      }
      const workspaces = registry.list().map((w) => ({
        id: w.id ?? '',
        path: w.path ?? '',
        sessionCount: w.sessionIds?.length ?? 0,
        sessionIds: [...(w.sessionIds ?? [])],
      }))
      return out(JSON.stringify({ total: workspaces.length, workspaces }))
    },
  )

  // 模型目录: 选模型前先查这里(provider route / 模型 id / 推理档 / 缺省选择)
  mcp.registerTool(
    'model_list',
    {
      title: 'List models',
      description: '列出当前可路由的 provider、模型 id 与推理档(reasoningEfforts), 以及缺省模型选择。agent_run/task_inbox 的 provider/model/reasoningEffort 与 select_model 都取自这里。source=sessionController 为官方口径(与 Web UI 模型选择器同源); source=llm 为回退(不含推理档)。',
      inputSchema: {
        provider: z.string().optional().describe('只看某个 provider route(缺省: 全部)'),
      },
      annotations: { readOnlyHint: true },
      outputSchema: modelCatalogOut,
    },
    async ({ provider }) => structuredOut(await collectModelCatalog(ctx, provider), modelCatalogOut),
  )

  // 同步执行任务(简单场景: 调用方下发 → 立即拿结果)
  mcp.registerTool(
    'agent_run',
    {
      title: 'Run agent task (sync)',
      description: '同步执行任务(改代码/分析/跑命令), 返回结构化结果。可传 sessionId 续接已有会话(长任务分多轮投喂)。可用 provider/model/reasoningEffort 指定本次模型(见 model_list; 同 cwd 下不同模型各自一个常驻会话)。可用 preset 为新建会话选人格(agentPresets roster 里的 id; 仅对新建会话生效, 接管已有会话沿用其原 preset)。默认返回 summary 级(省上下文), 需要 toolCalls 原文时传 detail=full。',
      inputSchema: {
        task: z.string().describe('要 Harness 执行的自然语言任务'),
        context: z.string().optional().describe('调用方记忆/上下文, 注入给 agent 参考(续接同一 sessionId 时建议只发增量)'),
        cwd: z.string().optional().describe('工作目录(默认当前)'),
        sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果里的 sessionId 字段)'),
        title: z.string().optional().describe('新会话的标题(创建时命名, 便于会话列表归档)'),
        detail: z.enum(['summary', 'normal', 'full']).optional().describe(`结果详略: ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
        provider: z.string().optional().describe('模型 provider route(见 model_list; 需与 model 成对; 缺省走插件配置/宿主默认)'),
        model: z.string().optional().describe('模型 id(见 model_list; 需与 provider 成对; 缺省走插件配置/宿主默认)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
        preset: z.string().optional().describe('新建会话挂载的 agent preset id(仅对新建会话生效; 接管已有会话沿用其原 preset)'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ task, context, cwd, sessionId, title, detail, provider, model, reasoningEffort, preset }, extra) => {
      // extra.signal: 客户端发 notifications/cancelled(MCP 规范的请求取消)时中止 → 官方 agent.cancel
      // extra._meta.progressToken: 调用方请求进度(MCP notifications/progress) → agent turn 期间定期回报
      const progressToken = extra?._meta?.progressToken
      const send = extra?.sendNotification
      let progressTick = 0
      const reportProgress = progressToken !== undefined && typeof send === 'function'
        ? (info: { events: number; turns: number; lastTool: string }) => send({
          method: 'notifications/progress',
          params: { progressToken, progress: ++progressTick, message: `agent running: turn ${info.turns}, last tool ${info.lastTool || 'none'}, ${info.events} new events` },
        })
        : undefined
      const result = await executeTask({
        ctx,
        task,
        context: context ?? '',
        cwd: cwd ?? process.cwd(),
        resumeSessionId: sessionId,
        title,
        override: selectionOverrideOf({ provider, model, reasoningEffort }),
        preset,
        signal: extra?.signal,
        reportProgress,
      })
      const rendered = JSON.stringify(renderResult(result, detail ?? state.config.defaultDetail), null, 2)
      // turn 失败透出: 带错误的执行结果按 MCP 规范标 isError, 严格客户端/模型可直接识别为失败
      return result.error ? outError(rendered) : out(rendered)
    },
  )

  // 实时干预: 对运行中的 agent 中途转向(steer, 下个 step 边界生效)或注入上下文(inject, 不唤醒)
  mcp.registerTool(
    'agent_steer',
    {
      title: 'Steer running agent',
      description: '对一个 dsh agent 实时干预, 无需取消重跑: mode=steer(默认)把转向指令送到最近的 step 边界, agent 在当前 turn 内消化; mode=inject 注入模型可见的补充上下文, 不唤醒驱动。目标二选一: sessionId(运行中/常驻池/live 会话)或 taskId(执行中的队列任务)。空闲会话不能 steer(转向会开一个无人接管的 turn)——用 agent_run 下发新任务; inject 空闲时允许, 挂起到下次唤醒。dsh 概念(turn/step/三级接管)见 dsh_get_started。',
      inputSchema: {
        message: z.string().describe('转向指令 / 注入的上下文内容'),
        sessionId: z.string().optional().describe('目标会话 id(须有活 agent: 常驻池或 live; 持久化-only 会话请改用 agent_run 续接)'),
        taskId: z.string().optional().describe('目标队列任务 id(仅 running 状态可干预; 与 sessionId 二选一)'),
        mode: z.enum(['steer', 'inject']).optional().describe('steer=转向(下个 step 边界消化, 默认); inject=注入上下文(不唤醒, 空闲时挂起)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ message, sessionId, taskId, mode }) => {
      const m = mode ?? 'steer'
      if (!sessionId === !taskId) {
        return outError(JSON.stringify({ error: 'exactly one of sessionId / taskId is required' }))
      }
      // taskId 目标: 只有执行中的任务才有活 agent 可干预; item.sessionId 由 onSession 在拿锁后即时回填
      let sid = sessionId
      if (taskId) {
        const item = state.taskQueue.get(taskId)
        if (!item) return outError(JSON.stringify({ error: `task not found: ${taskId}` }))
        if (item.status !== 'running') {
          return outError(JSON.stringify({ error: `task ${taskId} is ${item.status}, not running; only a running task has a live agent to steer` }))
        }
        if (!item.sessionId) {
          return outError(JSON.stringify({ error: `task ${taskId} is running but has not claimed a session yet; retry shortly` }))
        }
        sid = item.sessionId
      }
      let target: { agent: { steer?: (m: unknown) => void; inject?: (m: unknown) => void; status?: unknown }; source: string }
      try {
        const found = await resolveLiveAgent(ctx, sid!)
        if (!found) {
          return outError(JSON.stringify({ error: `no live agent for session ${sid} (not in the pool and not live; persisted-only sessions cannot be steered — use agent_run with this sessionId instead)` }))
        }
        target = found as typeof target
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
      const agentStatus = typeof target.agent.status === 'string' ? target.agent.status : 'unknown'
      const msg = userMessage(message)
      if (m === 'steer') {
        // 空闲拒绝: 宿主语义下空闲 agent 收到 steer 会立刻开一个新 turn, 但没有调用方在等结果,
        // 结束时不会被回收成结构化结果, 还可能与锁上排队的任务竞态。下发新任务请走 agent_run。
        if (!state.activeTurnSessions.has(sid!) || agentStatus !== 'running') {
          return outError(JSON.stringify({ error: `session ${sid} is idle (no running turn); steer would open an unwatched turn — use agent_run to send a new task instead` }))
        }
        target.agent.steer?.(msg)
        return out(JSON.stringify({ ok: true, sessionId: sid, mode: m, agentStatus, note: 'steering queued; consumed at the next step boundary of the current turn' }))
      }
      // inject: 不唤醒驱动; 空闲时挂起直到 followup/steer 唤醒(可能错过已 claim pre-step 的请求)
      target.agent.inject?.(msg)
      const note = agentStatus === 'running'
        ? 'context queued for the next pre-step (driver not woken)'
        : 'driver idle: context parked until the next followup/steer wakes it (it may miss a request whose pre-step already claimed its batch)'
      return out(JSON.stringify({ ok: true, sessionId: sid, mode: m, agentStatus, note }))
    },
  )

  // 异步 push 任务到队列(调用方 → dsh 任务入口)
  mcp.registerTool(
    'task_inbox',
    {
      title: 'Submit task (async)',
      description: '把结构化任务(任务+上下文)推入 dsh 队列, 异步执行, 返回 taskId。可用 provider/model/reasoningEffort 指定本次模型(见 model_list)。',
      inputSchema: {
        task: z.string().describe('任务内容'),
        context: z.string().optional().describe('调用方记忆/上下文, 随任务注入给 agent'),
        cwd: z.string().optional().describe('工作目录'),
        sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果)'),
        title: z.string().optional().describe('新会话的标题(创建时命名)'),
        provider: z.string().optional().describe('模型 provider route(见 model_list; 需与 model 成对)'),
        model: z.string().optional().describe('模型 id(见 model_list; 需与 provider 成对)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
        preset: z.string().optional().describe('新建会话挂载的 agent preset id(仅对新建会话生效)'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ task, context, cwd, sessionId, title, provider, model, reasoningEffort, preset }) => {
      sweepExpiredTasks()
      state.hooks.persistQueue()
      // 队列容量上限: 活动任务(排队+执行中)超过上限则拒绝
      let active = 0
      for (const t of state.taskQueue.values()) if (t.status === 'queued' || t.status === 'running') active++
      if (active >= state.config.maxQueue) {
        return outError(JSON.stringify({ error: `task queue full (${active}/${state.config.maxQueue})` }))
      }
      // 提交时即校验 cwd 白名单: 越界任务直接 isError 拒绝, 不入队(否则调用方要轮询才发现被拒)
      try {
        await canonicalizeAllowedCwd(cwd ?? process.cwd())
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
      const id = randomUUID()
      const item: TaskItem = {
        id, task, context: context ?? '', cwd: cwd ?? process.cwd(), status: 'queued', createdAt: Date.now(),
        controller: new AbortController(),
        ...(sessionId ? { sessionId } : {}),
        ...(title ? { title } : {}),
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(preset ? { preset } : {}),
      }
      state.taskQueue.set(id, item)
      // 异步执行(不阻塞调用方); task_cancel 经 controller.abort() → executeTask 走官方 agent.cancel
      state.hooks.runTaskItem(item)
      state.hooks.persistQueue()
      return out(JSON.stringify({ taskId: id, status: 'queued' }))
    },
  )

  // 取回任务结果(结构化 changes/verification/leftovers; 轮询用 status 档避免重复注入 payload)
  mcp.registerTool(
    'task_result',
    {
      title: 'Fetch task result',
      description: '取回 task_inbox 提交任务的结构化结果。轮询请传 detail=status(只返回状态, 不注入结果 payload, 完成后再取一次默认 summary)。',
      inputSchema: {
        taskId: z.string().describe('task_inbox 返回的 taskId'),
        detail: z.enum(['status', 'summary', 'normal', 'full']).optional().describe(`结果详略: status=只查状态(轮询); ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ taskId, detail }) => {
      const item = state.taskQueue.get(taskId)
      if (!item) return outError(JSON.stringify({ error: `task not found: ${taskId}` }))
      // status 档 / 任务未完成: 轻量返回, 不带结果字段(避免轮询把 payload 重复灌进调用方上下文)
      if (detail === 'status' || !item.result) {
        const statusPayload = JSON.stringify({
          taskId: item.id,
          status: item.status,
          ...(item.error ? { error: String(item.error).slice(0, 400) } : {}),
        })
        // 失败任务的轮询也标 isError: 严格客户端无需解析 payload 就知道该任务失败了
        return item.status === 'error' ? outError(statusPayload) : out(statusPayload)
      }
      const rendered = JSON.stringify(renderResult(item.result, detail ?? state.config.defaultDetail), null, 2)
      return item.result.error ? outError(rendered) : out(rendered)
    },
  )

  // 取消队列中/执行中的任务(执行中走官方 agent.cancel 中止当前 turn)
  mcp.registerTool(
    'task_cancel',
    {
      title: 'Cancel task',
      description: '取消队列中或执行中的任务。排队中的任务直接出队; 执行中的走官方 agent.cancel(中止当前 turn 并清掉未开工输入), 结果 status 变为 cancelled。已结束的任务无法取消, 原样回报当前状态。',
      inputSchema: {
        taskId: z.string().describe('task_inbox 返回的 taskId'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ taskId }) => {
      const item = state.taskQueue.get(taskId)
      if (!item) return outError(JSON.stringify({ error: `task not found: ${taskId}` }))
      if (item.status === 'done' || item.status === 'error' || item.status === 'cancelled') {
        return out(JSON.stringify({ taskId, status: item.status, cancelled: false, note: 'already finished' }))
      }
      item.controller?.abort()
      item.status = 'cancelled'
      state.hooks.persistQueue()
      return out(JSON.stringify({ taskId, status: item.status, cancelled: true }))
    },
  )

  // 任务清单(队列可观测; 查单个结果用 task_result, 取消用 task_cancel)
  mcp.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description: '列出队列中的任务(taskId/状态/创建时间/cwd)。排队中(queued)/执行中(running)/已完成(done)/失败(error)/已取消(cancelled)。查询单个任务结果用 task_result; 取消用 task_cancel。返回 { tasks: [...] }。',
      inputSchema: {
        status: z.enum(['queued', 'running', 'done', 'error', 'cancelled']).optional().describe('按状态过滤(缺省: 全部)'),
      },
      annotations: { readOnlyHint: true },
      outputSchema: taskListOut,
    },
    async ({ status }) => structuredOut({ tasks: listTasksPayload(status) }, taskListOut),
  )

  // 会话清单(live + 持久化合并, 只读): 挑选要续接/改名/归组的会话
  mcp.registerTool(
    'session_list',
    {
      title: 'List sessions',
      description: '列出已知会话的元数据(sessionId/创建时间/cwd/preset/当前模型)。live 与持久化合并、live 优先、按创建时间倒序; 模型选择仅 live/常驻池会话可知。配置 workspaceRoots 时只列白名单内会话(total 为过滤后计数), cwd 参数越界会被拒绝。用于挑选要续接(agent_run 的 sessionId)/改名/归组的会话。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('最多返回条数(默认 20)'),
        cwd: z.string().optional().describe('只列该目录(含子目录)下的会话'),
      },
      annotations: { readOnlyHint: true },
      outputSchema: sessionListOut,
    },
    async ({ limit, cwd }) => {
      try {
        const { total, sessions: items } = await collectSessions(ctx, cwd)
        return structuredOut({ total, sessions: items.slice(0, limit ?? 20) }, sessionListOut)
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 会话纪要(只读): 读 live 会话的事件快照, 从最新往回取; 长文本按角色截断省上下文
  mcp.registerTool(
    'session_history',
    {
      title: 'Session history',
      description: '读取一个 live 会话的对话纪要(user/assistant/tool_call/tool_result/turn_end 轮次, 从最新往回取, 文本截断)。roles 可只取指定类型(如只看回答传 ["assistant"], 排查问题再取 tool_call/tool_result); 缺省返回全部类型, limit 按过滤后的条数计数。支持 beforeIndex 向更早翻页(上次结果最早的 index)。配置 workspaceRoots 时, 白名单外会话不可读。只支持内存中的 live 会话; 已持久化但不在内存的会话, 宿主未暴露整日志加载 API, 无法读取。',
      inputSchema: {
        sessionId: z.string().describe('会话 id(live; 来自 agent_run 结果或 session_list)'),
        limit: z.number().int().min(1).max(50).optional().describe('最多返回轮数(默认 10)'),
        roles: z.array(z.enum(['user', 'assistant', 'tool_call', 'tool_result', 'turn_end'])).optional().describe('只返回这些类型的轮次; 缺省 = 全部类型'),
        beforeIndex: z.number().int().min(0).optional().describe('从该事件序号之前往回取(翻页: 传上次结果最早的 index)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ sessionId, limit, roles, beforeIndex }) => {
      try {
        return out(JSON.stringify(await sessionHistoryPayload(ctx, sessionId, limit ?? 10, beforeIndex, roles)))
      } catch (e) {
        return outError(JSON.stringify({ error: (e as Error)?.message ?? String(e) }))
      }
    },
  )

  // 会话内换模型(官方 selectModel 路径: 校验 + 持久通知, 下一个 step 生效; 历史不丢)
  mcp.registerTool(
    'select_model',
    {
      title: 'Select session model',
      description: '切换一个已存在会话使用的模型(走官方 sessionController.selectModel: 校验后写一条持久通知, 在下一个 step 生效, 对话历史保留)。需要 web profile 的 sessionController; 不可用时改用 agent_run 的 provider/model 参数。',
      inputSchema: {
        sessionId: z.string().describe('要换模型的会话 id'),
        provider: z.string().describe('目标 provider route(见 model_list)'),
        model: z.string().describe('目标模型 id(见 model_list)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, provider, model, reasoningEffort }) => {
      if (!state.config.allowModelOverride) {
        return outError(JSON.stringify({ error: 'model override is disabled by plugin config (allowModelOverride: false)' }))
      }
      const sc = serviceOf<SessionControllerView>(ctx, 'sessionController')
      if (typeof sc?.selectModel !== 'function') {
        return outError(JSON.stringify({
          error: 'sessionController service unavailable (select_model needs the web profile session controller); '
            + 'use agent_run with provider/model to run on another model instead',
        }))
      }
      try {
        const requested: ModelSelection = reasoningEffort ? { provider, model, reasoningEffort } : { provider, model }
        const res = await sc.selectModel({ sessionId: asSessionId(sessionId), ...requested })
        const selected = res?.selected ?? requested
        // 池 key 含模型: 切完要把该会话挪到新 key 下, 否则下次同模型调用会误开一个新会话
        rekeyPooledSession(sessionId, selected)
        return out(JSON.stringify({ ok: true, sessionId, selected: projectModel(selected) }))
      } catch (e) {
        return outError(JSON.stringify({ error: `select_model failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )

  // 给已有会话改名(走 sessionTitle 服务, 便于会话列表归档)
  mcp.registerTool(
    'rename_session',
    {
      title: 'Rename session',
      description: '给已有会话改名(走 sessionTitle 服务的 rename), 便于会话列表归档区分。',
      inputSchema: {
        sessionId: z.string().describe('要改名的会话 id(来自 agent_run 结果里的 sessionId 字段)'),
        title: z.string().describe('新标题'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, title }) => {
      try {
        const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
        const session = sessions?.get?.(sessionId)
        if (!session) return outError(JSON.stringify({ error: `session not found: ${sessionId}` }))
        const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
        if (!st?.rename) return outError(JSON.stringify({ error: 'sessionTitle service unavailable' }))
        const snapshot = st.rename(session, title) as { title?: string } | undefined
        return out(JSON.stringify({ ok: true, sessionId, title: snapshot?.title ?? title }))
      } catch (e) {
        return outError(JSON.stringify({ error: String(e) }))
      }
    },
  )

  // 手动归组补给站: 官方 UI 没有"移动会话到工作区"功能, 本工具供随时归组
  mcp.registerTool(
    'attach_session',
    {
      title: 'Attach session to workspace',
      description: '把会话归组到工作区(补给站: 官方 UI 无移动会话功能)。path 缺省用该会话 header 的 cwd; 归组依赖官方 attachSession 的强校验——realpath(header.cwd) 必须与工作区路径精确相等, 不匹配会返回官方报错。dsh 概念(工作区/会话)见 dsh_get_started。',
      inputSchema: {
        sessionId: z.string().describe('要归组的会话 id(live 或已持久化)'),
        path: z.string().optional().describe('目标工作区目录(缺省: 会话 header 的 cwd)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sessionId, path }) => {
      const sid = asSessionId(sessionId)
      const header = await findSessionHeader(ctx, sid)
      if (header === undefined) {
        return outError(JSON.stringify({ error: `session not found: ${sessionId}(live 与持久化里都没有)` }))
      }
      const target = path ?? header.cwd
      if (target === undefined) {
        return outError(JSON.stringify({ error: `session ${sessionId} 的 header 没有 cwd, 官方 attachSession 无法校验, 不能归组` }))
      }
      try {
        const canonical = await canonicalCwd(target) // 目录不存在时回退 resolve, 由官方校验给出明确报错
        const ws = await ensureWorkspace(ctx, canonical)
        if (!ws?.attachSession) return outError(JSON.stringify({ error: 'workspaceRegistry unavailable' }))
        if (ws.sessionIds.includes(sid)) {
          return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: false, note: 'already attached' }))
        }
        await ws.attachSession(sid)
        return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: true }))
      } catch (e) {
        return outError(JSON.stringify({ error: `attach failed: ${(e as Error)?.message ?? String(e)}` }))
      }
    },
  )
}

// ── MCP resources 面(与工具同数据的只读浏览面, 对支持 resources 的客户端零成本可浏览) ──

/** 注册资源面: status / queue / sessions / sessions/{id}/history / guide。会话数据与工具共用实现——两个面同白名单边界。 */
export function registerResources(mcp: McpServer, ctx: Context, deps?: ToolDeps): void {
  const json = (uri: URL, value: unknown) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  })
  mcp.registerResource(
    'status',
    'dsh://status',
    { title: 'Plugin status', description: '插件部署状态快照(dsh_status 工具同数据)', mimeType: 'application/json' },
    async (uri) => json(uri, deps?.statusSnapshot?.() ?? basicStatusSnapshot()),
  )
  mcp.registerResource(
    'guide',
    'dsh://guide',
    { title: 'dsh usage guide', description: 'dsh 概念词典/工作流/排错对照(dsh_get_started 工具 section=all 同数据)', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: GET_STARTED_DOC }] }),
  )
  mcp.registerResource(
    'queue',
    'dsh://queue',
    { title: 'Task queue', description: '任务队列快照(task_list 工具同数据)', mimeType: 'application/json' },
    async (uri) => json(uri, { tasks: listTasksPayload(undefined) }),
  )
  mcp.registerResource(
    'sessions',
    'dsh://sessions',
    { title: 'Sessions', description: '会话清单(session_list 工具同数据, 白名单裁剪)', mimeType: 'application/json' },
    async (uri) => json(uri, await collectSessions(ctx, undefined)),
  )
  mcp.registerResource(
    'session-history',
    new ResourceTemplate('dsh://sessions/{sessionId}/history', {
      list: async () => {
        const { sessions } = await collectSessions(ctx, undefined)
        return {
          resources: sessions.map((s) => ({
            uri: `dsh://sessions/${encodeURIComponent(String(s.sessionId))}/history`,
            name: String(s.title ?? s.sessionId),
            mimeType: 'application/json',
          })),
        }
      },
    }),
    { title: 'Session history', description: '单个 live 会话的对话纪要(session_history 工具同数据, 白名单内才可读)', mimeType: 'application/json' },
    async (uri, vars) => json(uri, await sessionHistoryPayload(ctx, decodeURIComponent(String(vars.sessionId)), 50)),
  )
}
