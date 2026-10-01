/**
 * 数据层: 工具面(tools)与资源面(resources)共用的读实现——两个面同数据、同 workspaceRoots 白名单边界。
 * 从 tools.ts 抽出(消除"工具↔资源"潜在环), 并承载资源面新增的载荷:
 *   taskDetailPayload   单任务全量(dsh://queue/{taskId}; 完成含 renderResult('full') 投影)
 *   agentsPayload       常驻池明细(dsh://agents; 工具面没有的能力)
 *   presetsPayload      preset 花名册(dsh://presets; agent_run 的 preset 参数此前无从查证)
 *   workspacesPayload   工作区清单/单工作区(dsh://workspaces[/id])
 *   sessionMetaPayload  单会话元数据(dsh://sessions/{id}; persisted-only 也可读)
 *   activityPayload     当前 turn 活动窗口(dsh://sessions/{id}/activity; 订阅核心场景)
 *   sessionEventsPayload 原始事件流(dsh://sessions/{id}/events; JSONL, after 游标翻页)
 *   hostToolsPayload    宿主全局工具注册表(dsh://tools)
 * 本层抛普通 Error(带可诊断信息); 资源面统一转 McpError(-32602), 工具面转 isError 结果。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import { PLUGIN_VERSION } from './config.js'
import { state, sweepExpiredTasks } from './state.js'
import type { ModelSelection, ModelSelectionOverride } from './types.js'
import { canonicalCwd, isWithin, sessionCwdRefusal } from './paths.js'
import { historyTurnsOf, projectModel, renderResult, type HistoryRole } from './projection.js'
import { eventsOf, headerOfSnapshot, serviceOf } from './host.js'
import { hostDefaultSelection, knownSelectionOf } from './engine.js'
import { resolve } from 'node:path'

// ── 规范 URI 构造器(资源面注册 / 订阅 / 通知 / 工具结果的 HATEOAS 引用同一来源) ──

/** 产物: 资源面全 URI 的唯一出处(改 URI 只动这里) */
export const resUri = {
  status: 'dsh://status',
  statusConfig: 'dsh://status/config',
  statusStats: 'dsh://status/stats',
  statusConnections: 'dsh://status/connections',
  guide: 'dsh://guide',
  guideSection: (section: string) => `dsh://guide/${section}`,
  tools: 'dsh://tools',
  models: 'dsh://models',
  modelProvider: (provider: string) => `dsh://models/${encodeURIComponent(provider)}`,
  presets: 'dsh://presets',
  workspaces: 'dsh://workspaces',
  workspace: (id: string) => `dsh://workspaces/${encodeURIComponent(id)}`,
  sessions: 'dsh://sessions',
  session: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}`,
  sessionHistory: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}/history`,
  sessionEvents: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}/events`,
  sessionActivity: (sessionId: string) => `dsh://sessions/${encodeURIComponent(sessionId)}/activity`,
  queue: 'dsh://queue',
  queueTask: (taskId: string) => `dsh://queue/${encodeURIComponent(taskId)}`,
  agents: 'dsh://agents',
} as const

// ── 模型目录(model_list / dsh://models) ──

/**
 * sessionController 视图(web profile 提供; 可选依赖): 官方模型目录 + "切换会话模型"入口。
 * 官方 UI 的模型选择器走的就是这两个方法, 所以插件不自己维护 provider/模型清单。
 */
export interface SessionControllerView {
  modelCatalog?: () => Promise<ModelCatalogView>
  selectModel?: (
    request: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string },
  ) => Promise<{ selected?: ModelSelection } | undefined>
}

/** 官方模型目录形状(只声明本插件读的字段; 未声明的一律不碰) */
interface ModelCatalogView {
  default?: ModelSelectionOverride
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
export async function collectModelCatalog(ctx: Context, only?: string): Promise<Record<string, unknown>> {
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

// ── 队列(task_list / dsh://queue[/taskId]) ──

/**
 * 取消窗口期标记(abort 已送达但任务尚未收敛): task_list/task_result/资源面共用同一判定。
 * signal 一并可选: 持久化恢复的任务 controller 是 JSON 回述的残缺对象({}), 不能假定 signal 存在。
 */
export function cancelRequestedOf(item: { controller?: { signal?: { aborted: boolean } }; status: string }): boolean {
  return item.controller?.signal?.aborted === true && (item.status === 'queued' || item.status === 'running')
}

/** task_list / dsh://queue 的共享实现: 队列快照(顺带 TTL 清理 + 落盘; 清掉的项经 notifyListChanged 广播) */
export function listTasksPayload(status?: string): Record<string, unknown>[] {
  const removed = sweepExpiredTasks() // 顺带清一次过期项, 防列表被撑大
  if (removed.length > 0) state.hooks.notifyListChanged()
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
      // 取消已送达但 agent 尚未收敛的窗口期标记(调度方据此区分"正在取消"与"确认停止")
      ...(cancelRequestedOf(t) ? { cancelRequested: true } : {}),
      ...(t.error ? { error: String(t.error).slice(0, 200) } : {}),
    }))
}

/** 单任务全量(dsh://queue/{taskId}): 元数据 + 完成时的 full 投影结果。不存在(含 TTL 已清) → 抛错 */
export function taskDetailPayload(taskId: string): Record<string, unknown> {
  sweepExpiredTasks()
  const item = state.taskQueue.get(taskId)
  if (!item) {
    throw new Error(`task not found: ${taskId} (never existed or past taskTtlMs — subscribe to ${resUri.queueTask(taskId)} at submit time to be notified on completion)`)
  }
  if (state.config.workspaceRoots.length > 0 && !state.config.workspaceRoots.some((root) => isWithin(root, item.cwd))) {
    throw new Error(`task cwd not allowed (outside workspaceRoots): ${item.cwd}`)
  }
  return {
    taskId: item.id,
    status: item.status,
    ...(item.sessionId ? { sessionId: item.sessionId } : {}),
    cwd: item.cwd,
    createdAt: item.createdAt,
    ...(item.finishedAt ? { finishedAt: item.finishedAt } : {}),
    ...(cancelRequestedOf(item) ? { cancelRequested: true } : {}),
    ...(item.error ? { error: String(item.error).slice(0, 400) } : {}),
    // 结果本体: full 投影(资源是显式读取, 调用方要的就是全量; 队列内部另存无损 TaskResult)
    ...(item.result ? { result: renderResult(item.result, 'full') } : {}),
  }
}

// ── 会话(session_list / session_history / dsh://sessions[/…]) ──

/**
 * session_list / dsh://sessions 的共享实现: live + 持久化合并(live 优先), 白名单裁剪, cwd 过滤
 * (total 为过滤后计数)。cwd 参数越界时抛错(与 agent_run 的 cwd 拒绝同风格)。
 */
export async function collectSessions(ctx: Context, cwd?: string): Promise<{ total: number; sessions: Record<string, unknown>[] }> {
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

/** 单会话元数据(dsh://sessions/{id}): 白名单内即可读(persisted-only 也行), 附 historyReadable 指路 */
export async function sessionMetaPayload(ctx: Context, sessionId: string): Promise<Record<string, unknown>> {
  const { sessions } = await collectSessions(ctx, undefined)
  const item = sessions.find((s) => String(s.sessionId) === sessionId)
  if (!item) {
    throw new Error(`session not found (or outside workspaceRoots): ${sessionId}`)
  }
  const live = (ctx.get('sessions') as { get?: (id: string) => unknown } | undefined)?.get?.(sessionId)
  return { ...item, historyReadable: live !== undefined }
}

/** session_history / dsh://sessions/{id}/history 的共享实现(工具与资源同数据同边界)。不可读时抛错。 */
export async function sessionHistoryPayload(ctx: Context, sessionId: string, limit: number, beforeIndex?: number, roles?: HistoryRole[]): Promise<Record<string, unknown>> {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const session = sessions?.get?.(sessionId)
  if (!session) {
    throw new Error(`session not live: ${sessionId} (persisted-only sessions cannot be read back; host does not expose a full-log load API — use agent_run with this sessionId to resume)`)
  }
  // 白名单模式: 会话内容读取与执行面同一边界(越界会话不可读)
  if (state.config.workspaceRoots.length > 0) {
    const refusal = await sessionCwdRefusal(sessionId, (session as { header?: SessionHeader }).header?.cwd)
    if (refusal) throw new Error(refusal)
  }
  const events = eventsOf(session)
  return { sessionId, totalEvents: events.length, turns: historyTurnsOf(events, limit, beforeIndex, roles) }
}

/** 活动/事件流面的公共前置: live 校验 + 白名单校验, 返回 live 会话对象。不可读时抛错。 */
async function liveSessionOf(ctx: Context, sessionId: string): Promise<{ session: unknown; events: readonly unknown[] }> {
  const sessions = ctx.get('sessions') as { get?: (id: string) => unknown } | undefined
  const session = sessions?.get?.(sessionId)
  if (!session) {
    throw new Error(`session not live: ${sessionId} (activity/events streams exist only for in-memory sessions)`)
  }
  if (state.config.workspaceRoots.length > 0) {
    const refusal = await sessionCwdRefusal(sessionId, (session as { header?: SessionHeader }).header?.cwd)
    if (refusal) throw new Error(refusal)
  }
  return { session, events: eventsOf(session) }
}

/** 当前 turn 活动窗口(dsh://sessions/{id}/activity): 订阅推送的低粒度高频观测面 */
export async function activityPayload(ctx: Context, sessionId: string): Promise<Record<string, unknown>> {
  const { events } = await liveSessionOf(ctx, sessionId)
  let turns = 0
  let lastTool = ''
  let lastEventTime: number | undefined
  let assistantTail: string | undefined
  for (const e of events) {
    const ev = e as { type?: string; time?: unknown; data?: unknown }
    if (ev.type === 'turn/start') turns++
    else if (ev.type === 'tool/call') lastTool = (ev.data as { name?: string })?.name ?? lastTool
    if (typeof ev.time === 'number') lastEventTime = ev.time
    if (ev.type === 'assistant/message') {
      const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
      const text = (d?.message?.content ?? []).filter((c) => c.type === 'text' && c.text).map((c) => c.text).join('\n')
      if (text.trim()) assistantTail = text.slice(-400)
    }
  }
  return {
    sessionId,
    active: state.activeTurnSessions.has(sessionId),
    turns,
    totalEvents: events.length,
    ...(lastTool ? { lastTool } : {}),
    ...(lastEventTime !== undefined ? { lastEventTime } : {}),
    ...(assistantTail !== undefined ? { assistantTail } : {}),
  }
}

/** 原始事件流(dsh://sessions/{id}/events): JSONL, after=日志下标游标翻页, 上限 500 行防灌穿 */
export async function sessionEventsPayload(ctx: Context, sessionId: string, afterIndex?: number): Promise<{ sessionId: string; total: number; returned: number; after?: number; next?: number; truncated: boolean; lines: string[] }> {
  const { events } = await liveSessionOf(ctx, sessionId)
  const from = Math.max(0, Math.min(afterIndex ?? -1, events.length - 1) + 1)
  const CAP = 500
  const slice = events.slice(from, from + CAP)
  const lines = slice.map((e, i) => {
    const ev = e as { type?: string; seq?: unknown; time?: unknown; data?: unknown }
    return JSON.stringify({
      i: from + i,
      ...(typeof ev.seq === 'number' ? { seq: ev.seq } : {}),
      ...(typeof ev.time === 'number' ? { time: ev.time } : {}),
      type: ev.type ?? '?',
      data: ev.data ?? null,
    })
  })
  const lastIndex = from + slice.length - 1
  return {
    sessionId,
    total: events.length,
    returned: lines.length,
    ...(afterIndex !== undefined ? { after: afterIndex } : {}),
    // 还有更多时给 next 游标(下一次 ?after=), 到头不给
    ...(lines.length > 0 && from + slice.length < events.length ? { next: lastIndex + 1 } : {}),
    truncated: from + slice.length < events.length,
    lines,
  }
}

// ── 池 / preset / 工作区 / 宿主工具(纯新增数据能力) ──

/** 常驻池明细(dsh://agents): 工具面没有的能力——谁在池里、用什么模型、是否正跑 turn */
export function agentsPayload(): Record<string, unknown> {
  const whitelistActive = state.config.workspaceRoots.length > 0
  const agents = [...state.liveAgents.values()]
    .filter((rec) => !whitelistActive || state.config.workspaceRoots.some((root) => isWithin(root, rec.cwd)))
    .map((rec) => ({
      sessionId: String(rec.sessionId),
      ...(rec.cwd ? { cwd: rec.cwd } : {}),
      preset: rec.preset,
      model: projectModel(rec.selection),
      activeTurn: state.activeTurnSessions.has(String(rec.sessionId)),
    }))
  return { total: agents.length, agents }
}

/** preset 花名册(dsh://presets): agent_run/task_inbox 的 preset 参数的合法取值来源 */
export async function presetsPayload(ctx: Context): Promise<Record<string, unknown>> {
  const presets = serviceOf<{ list?: () => Promise<readonly { id?: string; name?: string; description?: string; order?: number }[]> }>(ctx, 'agentPresets')
  if (typeof presets?.list !== 'function') {
    throw new Error('agentPresets service unavailable (preset roster unreadable; use config.preset default)')
  }
  const roster = (await presets.list()) ?? []
  return {
    total: roster.length,
    presets: roster.map((p) => ({
      id: p.id ?? '',
      ...(p.name ? { name: p.name } : {}),
      ...(p.description ? { description: p.description } : {}),
      ...(p.order !== undefined ? { order: p.order } : {}),
    })),
  }
}

/** 工作区清单(dsh://workspaces / workspace_list 工具同数据) */
export async function workspacesPayload(ctx: Context): Promise<Record<string, unknown>> {
  const registry = serviceOf<{ list?: () => { id?: string; path?: string; sessionIds?: readonly SessionId[] }[] }>(ctx, 'workspaceRegistry')
  if (typeof registry?.list !== 'function') {
    throw new Error('workspaceRegistry service unavailable (headless deployment has no workspace grouping)')
  }
  const workspaces = registry.list().map((w) => ({
    id: w.id ?? '',
    path: w.path ?? '',
    sessionCount: w.sessionIds?.length ?? 0,
    sessionIds: [...(w.sessionIds ?? [])],
  }))
  return { total: workspaces.length, workspaces }
}

/** 单工作区(dsh://workspaces/{id}) */
export async function workspaceDetailPayload(ctx: Context, id: string): Promise<Record<string, unknown>> {
  const all = await workspacesPayload(ctx)
  const found = (all.workspaces as { id: string }[]).find((w) => w.id === id)
  if (!found) throw new Error(`workspace not found: ${id}`)
  return found
}

/** 宿主全局工具注册表(dsh://tools / dsh_list_tools 工具同数据) */
export function hostToolsPayload(ctx: Context): Record<string, unknown> {
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
  return {
    source: 'global-registry',
    note: '0.1.5+ 的模型工具挂在 preset/agent 作用域, 此全局表通常为空; agent 实际可用的工具以 agent_run 结果里的 toolCalls 为准(想确认某能力是否可用, 直接跑个小任务看 toolCalls)',
    tools: list,
  }
}

// ── 状态快照(dsh_status / dsh://status[/…]) ──

/** apply 级依赖注入(完整状态快照等 apply 闭包才有的能力经它传给两个面; 缺省退回 state 级基础快照) */
export interface ToolDeps {
  /** 完整状态快照(版本/监听/uptime/配置摘要/队列计数/连接; index.ts statusSnapshot 同源) */
  statusSnapshot?: () => Record<string, unknown>
}

/** 队列计数(状态快照里复用) */
export function queueCounts(): { active: number; done: number; error: number; cancelled: number } {
  let active = 0
  let done = 0
  let error = 0
  let cancelled = 0
  for (const t of state.taskQueue.values()) {
    if (t.status === 'queued' || t.status === 'running') active++
    else if (t.status === 'done') done++
    else if (t.status === 'cancelled') cancelled++
    else error++
  }
  return { active, done, error, cancelled }
}

/** state 级基础状态快照(deps.statusSnapshot 缺省时的退路; 不含监听/连接等 apply 级数据) */
export function basicStatusSnapshot(): Record<string, unknown> {
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
    stats: { liveAgents: state.liveAgents.size, queue: queueCounts() },
  }
}
