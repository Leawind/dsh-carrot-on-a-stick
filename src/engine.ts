/**
 * 执行引擎: 模型选择解析、常驻会话池(cwd + 模型三元组, LRU 淘汰跳过活跃会话)、
 * sessionId 三级接管(本进程池 → live 会话 → 持久化 resume)、统一 cwd 串行锁
 * (按目录与按会话两种入口都锁"实际执行目录", 同一会话的所有入口同锁串行)、
 * MCP 规范原生的取消(notifications/cancelled → 官方 agent.cancel)与进度(_meta.progressToken →
 * notifications/progress)、任务执行与结构化结果读取。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { state } from './state.js'
import type { ModelSelection, ModelSelectionOverride, PooledAgent, TaskResult } from './types.js'
import { canonicalCwd, canonicalizeAllowedCwd, sessionCwdRefusal } from './paths.js'
import { extractTexts, parseSummary } from './projection.js'
import {
  asSessionId,
  attachSessionCwd,
  attachToWorkspace,
  ensureWorkspace,
  eventsOf,
  findSessionHeader,
  serviceOf,
  userMessage,
} from './host.js'

/**
 * setup 挂载 preset(含 bash/fs/todo/web 等完整工具)。
 * 直接调用宿主服务 ctx.agentPresets.mount——scope 校验由 mount 自身完成,
 * 不再用插件侧 scopeOf 预检(混装副本的私有 Symbol 不匹配曾让预检恒假, 导致 agent 静默失去全部工具)。
 */
async function mountPreset(ctx: Context, agentCtx: Context, preset: string): Promise<void> {
  await ctx.agentPresets.mount(agentCtx, preset)
}

/**
 * per-call preset 解析: 缺省回落部署默认(config.preset); 显式指定时先过门禁
 * (allowPresetOverride: false = 部署锁死 preset), 再校验 roster 存在性
 * (ctx.agentPresets.list() 可用时给出可用清单, 不可用时透传给 mount 由宿主报错)。
 */
async function resolvePreset(ctx: Context, preset?: string): Promise<string> {
  if (!preset) return state.config.preset
  if (!state.config.allowPresetOverride) {
    throw new Error('preset override is disabled by plugin config (allowPresetOverride: false); '
      + 'remove preset from the call, or enable allowPresetOverride in cordis.yml')
  }
  const presets = serviceOf<{ list?: () => Promise<{ id?: string }[]> }>(ctx, 'agentPresets')
  if (typeof presets?.list === 'function') {
    const roster = await presets.list().catch(() => undefined)
    if (roster && !roster.some((p) => p?.id === preset)) {
      throw new Error(`unknown preset "${preset}" (available: ${roster.map((p) => p?.id ?? '').filter(Boolean).join(', ') || 'none'}; check agentPresets roster or config.preset)`)
    }
  }
  return preset
}

/**
 * 读宿主默认模型选择(agentDefaultModel; 未挂载该插件时为 undefined)。
 * 与 Web UI 建会话同款来源——插件不自己维护一份"默认模型"。
 */
export function hostDefaultSelection(ctx: Context): ModelSelectionOverride | undefined {
  return serviceOf<{ currentSelection?: () => ModelSelectionOverride | undefined }>(ctx, 'agentDefaultModel')
    ?.currentSelection?.()
}

/** 调用是否携带了任一模型覆盖字段(用于 allowModelOverride 门禁与"没有覆盖"判定) */
function hasModelOverride(override?: ModelSelectionOverride): boolean {
  return override !== undefined
    && (override.provider !== undefined || override.model !== undefined || override.reasoningEffort !== undefined)
}

/** 把 MCP 工具的可选参数收敛成 override(MCP 客户端可能把空串当"未提供", 一并当没有) */
export function selectionOverrideOf(args: { provider?: string; model?: string; reasoningEffort?: string }): ModelSelectionOverride | undefined {
  const o: ModelSelectionOverride = {}
  if (args.provider) o.provider = args.provider
  if (args.model) o.model = args.model
  if (args.reasoningEffort) o.reasoningEffort = args.reasoningEffort
  return hasModelOverride(o) ? o : undefined
}

/**
 * 解析生成 agent 的模型选择, 优先级: 单次调用覆盖 > 插件 config > 宿主默认选择。
 * provider+model 必须成对解析出来: 只给一边时用低优先级来源补另一边, 补齐不了直接抛错。
 * reasoningEffort 与模型同源(见下), 显式钉住模型时不继承宿主默认档位。
 *
 * 背景(E2E 实测): agent-loop 把 {{model}} 提示词变量直接读 agent.options.model, 不做任何默认解析——
 * 默认模型的解析发生在 Web 应用层。插件直连 ctx.agents.create 时必须自带完整选择,
 * 否则 persona 组装期 "{{model}} has no value" 让整个 turn 失败。
 */
function resolveAgentOptions(ctx: Context, override?: ModelSelectionOverride): ModelSelection {
  if (!state.config.allowModelOverride && hasModelOverride(override)) {
    throw new Error('model override is disabled by plugin config (allowModelOverride: false); '
      + 'remove provider/model/reasoningEffort from the call, or enable allowModelOverride in cordis.yml')
  }
  const cfg = { provider: state.config.provider, model: state.config.model }
  const host = hostDefaultSelection(ctx)
  const provider = override?.provider || cfg.provider || host?.provider
  const model = override?.model || cfg.model || host?.model
  // 推理强度与模型同源: 调用覆盖 > 插件 config > 宿主默认(仅当模型不是被显式钉住时继承)。
  // 若调用方/插件 profile 已显式钉住 provider+model, 就不继承宿主那个"为别的模型选的"档位——
  // 宿主对不支持的显式 effort 是直接拒绝(不做 clamp/别名), 继承反而会把能跑的部署弄挂。
  const pinnedModel = Boolean((override?.provider && override?.model) || (cfg.provider && cfg.model))
  const reasoningEffort = override?.reasoningEffort
    ?? (state.config.reasoningEffort || (pinnedModel ? undefined : host?.reasoningEffort))
  if (!provider || !model) {
    throw new Error(
      `cannot determine model for spawned agent: call override has {provider: ${JSON.stringify(override?.provider ?? null)}, model: ${JSON.stringify(override?.model ?? null)}}, `
      + `plugin config has {provider: ${JSON.stringify(cfg.provider || null)}, model: ${JSON.stringify(cfg.model || null)}}, `
      + `host default selection has {provider: ${JSON.stringify(host?.provider ?? null)}, model: ${JSON.stringify(host?.model ?? null)}}. `
      + '请在调用里成对传 provider+model(先用 model_list 查可用值), 或在插件 config 成对配置, 或先在 dsh 设置里选择默认模型.',
    )
  }
  return reasoningEffort ? { provider, model, reasoningEffort } : { provider, model }
}

/** 从 live agent 读它当前实际用的模型选择(接管别人建的会话时回报用; 读不到就留空, 不抛错) */
function selectionOfAgent(agent: unknown): ModelSelection {
  const opts = (agent as { options?: { provider?: unknown; model?: unknown; reasoningEffort?: unknown } } | undefined)?.options
  const s = (v: unknown) => (typeof v === 'string' ? v : '')
  const provider = s(opts?.provider)
  const model = s(opts?.model)
  const reasoningEffort = s(opts?.reasoningEffort)
  return reasoningEffort ? { provider, model, reasoningEffort } : { provider, model }
}

/** 已知会话的当前模型选择: 常驻池记录 → live agent options; 持久化-only 会话无从得知(agent 未重建), 返回 undefined */
export function knownSelectionOf(ctx: Context, sessionId: string): ModelSelection | undefined {
  const poolKeyOfSession = state.sessionToPoolKey.get(sessionId)
  const pooled = poolKeyOfSession !== undefined ? state.liveAgents.get(poolKeyOfSession) : undefined
  if (pooled) return pooled.selection
  const live = ctx.agents.get(asSessionId(sessionId))
  if (!live) return undefined
  const sel = selectionOfAgent(live)
  return sel.provider && sel.model ? sel : undefined
}

/**
 * 转成宿主 ctx.agents.create/resume 要的 agentOptions。
 * reasoningEffort 在宿主侧是 branded 类型(ReasoningEffortId): 值本身是适配器定义的字符串
 * (来自调用方 / model_list / 适配器默认), 这里只做编译期桥接——零宿主副本原则下不引入宿主的品牌构造函数。
 */
function agentOptionsOf(selection: ModelSelection): AgentOptions {
  const opts: AgentOptions = { provider: selection.provider, model: selection.model }
  if (selection.reasoningEffort !== undefined) {
    opts.reasoningEffort = selection.reasoningEffort as unknown as AgentOptions['reasoningEffort']
  }
  return opts
}

/**
 * 池 key = cwd + 模型三元组 + preset。
 * 带上模型是"按调用选模型"的基础: 同一目录下不同模型各占一个常驻会话, 而不是共用一个会话
 * 中途漂移模型——这样"用 A 模型跑任务1、B 模型跑任务2"在同一 cwd 里也可预期
 * (代价: 这两个会话不共享上下文)。想在同一个会话里换模型请用 select_model。
 * preset 同理: 不同人格(per-call preset)各自一个常驻会话。
 */
function poolKey(cwd: string, selection: ModelSelection, preset: string): string {
  return [cwd, selection.provider, selection.model, selection.reasoningEffort ?? '', preset].join('\u0000')
}

/**
 * 接管前定位会话 cwd(池记录 → live header → 持久化 header): 池记录的 cwd 建会话时已 realpath 规范化,
 * live/持久化侧现规范化。找不到(会话不存在)返回 undefined, 由接管路径给出"session not found"。
 * 用途: executeTask 的统一 cwd 锁与"显式 cwd 必须与会话目录一致"校验(不必等拿锁后接管才发现)。
 */
export async function sessionCwdOf(ctx: Context, sessionId: string): Promise<string | undefined> {
  const poolKeyOfSession = state.sessionToPoolKey.get(sessionId)
  const pooled = poolKeyOfSession !== undefined ? state.liveAgents.get(poolKeyOfSession) : undefined
  if (pooled) return pooled.cwd
  const live = ctx.agents.get(asSessionId(sessionId))
  if (live) {
    const cwd = (live as { session?: { header?: { cwd?: string } } }).session?.header?.cwd
    return cwd === undefined ? undefined : canonicalCwd(cwd)
  }
  const header = await findSessionHeader(ctx, asSessionId(sessionId))
  return header?.cwd === undefined ? undefined : canonicalCwd(header.cwd)
}

/** getAgent 的返回: handle 恒有 .agent; resume 出来的独占句柄带 disposeAfter 标记, 任务结束后应 flush+dispose */
interface ResolvedAgent {
  sessionId: SessionId
  handle: AgentHandle
  /** 本会话的模型选择(池命中/live 接管读其原有选择; resume 用现算的选择) */
  selection: ModelSelection
  /** 本会话实际挂载的 preset(池命中 = 创建时记录; live 接管无从得知 = 空; resume/新建 = 现挂的) */
  preset: string
  /** true = 本插件 resume 出来的独占句柄; false/缺省 = 常驻池会话或 live 接管(生命周期归池/owner) */
  disposeAfter?: boolean
}

/** 获取(或创建)指定 cwd 的常驻 agent 会话; 传 sessionId 时接管指定会话; 传 title 时给新会话命名 */
async function getAgent(ctx: Context, cwd: string, sessionId?: string, title?: string, override?: ModelSelectionOverride, preset?: string): Promise<ResolvedAgent> {
  // 指定 sessionId: 接管已有会话(长任务分多轮投喂 / 中断后恢复 / UI 手开的会话)
  if (sessionId) {
    return takeoverSession(ctx, sessionId, override)
  }
  // 无 sessionId: 按 cwd + 模型三元组 + preset 命中/新建常驻会话(不同模型/人格 = 不同会话, 上下文不串联)
  const presetName = preset ?? state.config.preset
  const selection = resolveAgentOptions(ctx, override)
  const key = poolKey(cwd, selection, presetName)
  const existing = state.liveAgents.get(key)
  if (existing) {
    // LRU: 命中则移到末尾(最近使用)
    state.liveAgents.delete(key)
    state.liveAgents.set(key, existing)
    // 自愈: 幂等补挂(已在花名册则 no-op; 首次挂名失败的池会话在此被捞回)
    await attachToWorkspace(ctx, await canonicalCwd(cwd), existing.sessionId)
    return existing
  }
  // LRU 淘汰: 超过上限时逐出最久未用的会话, 但跳过正在执行 turn 的会话
  // (dispose 活跃会话会打断别人的任务)——全忙时允许池暂时超限
  while (state.liveAgents.size >= state.config.maxAgents) {
    const evictable = [...state.liveAgents.entries()].find(([, rec]) => !state.activeTurnSessions.has(String(rec.sessionId)))
    if (evictable === undefined) break
    const [oldestKey, old] = evictable
    state.liveAgents.delete(oldestKey)
    if (old) {
      state.sessionToPoolKey.delete(String(old.sessionId))
      try { void (old.handle as { dispose?: () => Promise<void> } | undefined)?.dispose?.() } catch { /* 忽略 */ }
    }
  }
  const newSessionId = asSessionId(randomUUID())
  // cwd 先 realpath 规范化: session header 的 cwd 与 workspace.path 必须精确相等,
  // 否则 attachSession 强校验 reject(只会 create 注册而 UI 仍落未分组)
  const canonical = await canonicalCwd(cwd)
  const handle = await ctx.agents.create({
    sessionId: newSessionId,
    // 声明 preset(per-call 覆盖 > 部署默认): 当前版本主要靠 setup 里 mount, meta.agentPreset 供未来 Harness 版本直接消费。
    meta: { cwd: canonical, agentPreset: presetName },
    // 模型选择: 调用覆盖 / 插件 config / 宿主默认补全后的完整选择(agent.options.model 是 {{model}} 变量的来源)
    agentOptions: agentOptionsOf(selection),
    setup: async (agentCtx) => {
      await mountPreset(ctx, agentCtx, presetName)
    },
  })
  const rec: PooledAgent = { sessionId: newSessionId, handle, cwd, selection, preset: presetName }
  state.liveAgents.set(key, rec)
  state.sessionToPoolKey.set(String(newSessionId), key)
  // 新会话入池: sessions/agents 清单成员变化 → 资源面 list_changed(hub 侧合并广播)
  state.hooks.notifyListChanged()

  // 分组: 把会话归属到 cwd 对应的工作区(resolveByPath ?? create + attachSession; 可选依赖; headless 环境自动跳过)
  void (async () => {
    try {
      const ws = await ensureWorkspace(ctx, canonical)
      if (ws?.attachSession) await ws.attachSession(newSessionId)
    } catch (e) {
      console.warn('[dsh-carrot-on-a-stick] workspace attach failed:', String(e))
    }
  })()

  // title 命名(可选): 创建会话后立即命名(走 sessionTitle 服务的 rename)
  if (title) {
    try {
      const session = handle.agent.session as { id?: unknown }
      const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
      st?.rename?.(session, title)
    } catch (e) {
      console.warn('[dsh-carrot-on-a-stick] session title set failed:', String(e))
    }
  }

  return rec
}

/**
 * 定位一个**活着**的 agent(实时干预用, agent_steer/注入): 本进程池 → live 会话, 不做持久化 resume
 * (resume 会重建 agent, 重建出的新驱动不是调用方正在看的那一个; 持久化-only 会话没有活 agent 可干预)。
 * 白名单模式下两级都校验会话自身 cwd(与接管面同边界)。找不到返回 undefined, 由调用方给出报错。
 */
export async function resolveLiveAgent(ctx: Context, sessionId: string): Promise<{ agent: AgentHandle['agent']; source: 'pool' | 'live' } | undefined> {
  const whitelistActive = state.config.workspaceRoots.length > 0
  const poolKeyOfSession = state.sessionToPoolKey.get(sessionId)
  if (poolKeyOfSession !== undefined) {
    const pooled = state.liveAgents.get(poolKeyOfSession)
    if (pooled) {
      if (whitelistActive) {
        const refusal = await sessionCwdRefusal(sessionId, pooled.cwd)
        if (refusal) throw new Error(refusal)
      }
      return { agent: pooled.handle.agent, source: 'pool' }
    }
  }
  const live = ctx.agents.get(asSessionId(sessionId))
  if (live) {
    if (whitelistActive) {
      const refusal = await sessionCwdRefusal(sessionId, live.session.header.cwd)
      if (refusal) throw new Error(refusal)
    }
    return { agent: live, source: 'live' }
  }
  return undefined
}

/**
 * sessionId 接管: 三级查找(本进程池 → live 会话 → 持久化 resume), 都没有才报错,
 * 所以进程重启前/UI 手开的会话也能续接。
 * 白名单模式下每一层都先校验会话自身 cwd(越界拒绝, 见 paths.sessionCwdRefusal)——
 * 否则"cwd 参数给白名单内目录 + sessionId 指向白名单外会话"就是一条沙箱绕过路径;
 * resume 层在校验通过后才重建 agent(不在越界会话上白做 resume)。
 */
async function takeoverSession(ctx: Context, sessionId: string, override?: ModelSelectionOverride): Promise<ResolvedAgent> {
  const whitelistActive = state.config.workspaceRoots.length > 0
  // 先看本进程常驻池(池 key 里含模型, 所以按 sessionId → 池 key 的索引定位; 命中 LRU 移到末尾)
  const poolKeyOfSession = state.sessionToPoolKey.get(sessionId)
  if (poolKeyOfSession !== undefined) {
    const existing = state.liveAgents.get(poolKeyOfSession)
    if (existing) {
      // 校验池记录的 cwd: 防热重载把白名单收窄后, 旧池会话成为绕过路径
      if (whitelistActive) {
        const refusal = await sessionCwdRefusal(sessionId, existing.cwd)
        if (refusal) throw new Error(refusal)
      }
      state.liveAgents.delete(poolKeyOfSession)
      state.liveAgents.set(poolKeyOfSession, existing)
      return existing
    }
  }
  const sid = asSessionId(sessionId)
  // 不在常驻池: 看 live(UI 手开的、别的插件持有的会话), 直接接管、不持有 dispose(归其 owner)。
  // 这条路不解析模型选择: 沿用该会话原有的选择(只给一边 override 时也不改它, 想改请用 select_model)。
  const live = ctx.agents.get(sid)
  if (live) {
    if (whitelistActive) {
      const refusal = await sessionCwdRefusal(sessionId, live.session.header.cwd)
      if (refusal) throw new Error(refusal)
    }
    // live 会话也补挂工作区(幂等): 用户手开的会话若尚未归组, 这里一并挂名
    await attachSessionCwd(ctx, sid, live.session.header.cwd)
    // no-op dispose 兜底: executeTask 只在 disposeAfter 为 true 时调用 dispose
    return { sessionId: sid, handle: { agent: live, dispose: () => Promise.resolve() }, disposeAfter: false, selection: selectionOfAgent(live), preset: '' }
  }
  // live 也没有: 从持久化会话存储 resume 并接管(进程重启前的会话、LRU 淘汰后被释放的会话)
  // header 预读(无条件): 白名单校验 + 恢复原 preset 都需要; 查不到时跳过校验, 让 resume 用自己的"session not found"报错
  const header = await findSessionHeader(ctx, sid)
  if (whitelistActive && header !== undefined) {
    const refusal = await sessionCwdRefusal(sessionId, header.cwd)
    if (refusal) throw new Error(refusal)
  }
  // resume 会重建 agent, 所以这里必须现算一份完整模型选择(agent.options.model 是 {{model}} 变量的来源)
  const selection = resolveAgentOptions(ctx, override)
  // resume 沿用会话原 preset(header.agentPreset; 旧会话/未记录时回落部署默认)——重建不换人格,
  // 否则依赖特定人格/工具集的工作会话在续接时被静默换掉执行环境。
  // 原 preset 已不在花名册时回落部署默认并告警(结果里如实回报实际挂载的 preset)。
  const originalPreset = header?.agentPreset
  let mountedPreset = state.config.preset
  let handle: AgentHandle
  try {
    handle = await ctx.agents.resume({
      resumeSessionId: sid,
      agentOptions: agentOptionsOf(selection),
      setup: async (agentCtx) => {
        if (originalPreset && originalPreset !== state.config.preset) {
          try {
            await mountPreset(ctx, agentCtx, originalPreset)
            mountedPreset = originalPreset
            return
          } catch (e) {
            console.warn(`[dsh-carrot-on-a-stick] resume: original preset "${originalPreset}" mount failed, falling back to "${state.config.preset}":`, String(e))
          }
        }
        await mountPreset(ctx, agentCtx, state.config.preset)
      },
    })
  } catch (e) {
    // 恢复失败返回明确错误(沿用上游错误风格): 不在常驻池、不是 live、持久化里也没有(或 resume 失败)
    throw new Error(`session not found for resume: ${sessionId} (not live and not persisted; ${(e as Error)?.message ?? e})`)
  }
  await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd)
  return { sessionId: sid, handle, disposeAfter: true, selection, preset: mountedPreset }
}

/** 同一 cwd 串行执行, 避免并发 followup 同一会话; 链尾落定且无新等待者时清理 key(防长进程下 Map 无限增长) */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = state.agentLocks.get(key) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  const stored = next.catch(() => {})
  state.agentLocks.set(key, stored)
  void stored.then(() => {
    // 仍是链尾(没有后来的等待者替换掉它)才清; 有等待者时 map 里已是对方的 stored
    if (state.agentLocks.get(key) === stored) state.agentLocks.delete(key)
  })
  return next
}

/**
 * 等待 agent 收敛到 idle; abort 信号触发时走官方 `agent.cancel(...)`(中止当前 turn 并清掉
 * 未开工的排队输入), 再等 whenIdle 收敛——withLock 的锁持有到收敛为止, 取消不会与后续
 * followup 并发。取消原因由 getCause 现取(外部取消 = user, 超时 = hook+reason)。
 * 宿主缺 cancel(旧版本)时退化为不可取消: 忽略信号继续等原 promise。
 * 取消的收场经 turn/end 事件进 result.error。
 */
async function awaitIdleCancellable(agent: AgentHandle['agent'], pending: Promise<void>, signal?: AbortSignal, getCause: () => unknown = () => ({ kind: 'user' })): Promise<void> {
  const cancel = () => (agent as { cancel?: (cause: unknown, options?: unknown) => void }).cancel?.(getCause())
  if (!signal) return pending
  if (signal.aborted) {
    cancel()
    return pending
  }
  let onAbort: () => void = () => {}
  const aborted = new Promise<void>((resolveAborted) => { onAbort = () => { cancel(); resolveAborted() } })
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    await Promise.race([pending, aborted])
    if (signal.aborted) await pending // cancel 已触发: 等真正收敛(而非半路返回)
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

/** executeTask 的参数包(位置参数超过 8 个, 收拢成对象) */
export interface ExecuteTaskOptions {
  ctx: Context
  task: string
  context: string
  /** 工作目录(缺省: 无 sessionId = 进程 cwd; 续接会话 = 沿用会话自身目录, 显式传入时必须与会话目录一致) */
  cwd?: string
  resumeSessionId?: string
  title?: string
  override?: ModelSelectionOverride
  /** per-call preset(仅对新建会话生效; 接管已有会话沿用其原 preset; 门禁与 roster 校验在此统一做) */
  preset?: string
  /** 外部取消信号(MCP notifications/cancelled / 队列 task_cancel) */
  signal?: AbortSignal
  /** 拿到 cwd/session 锁、真正开始执行时回调(队列据此区分"排队"与"执行中") */
  onStart?: () => void
  /** 拿到实际执行的 sessionId 时回调(agent_run 同步返回前调用方无从得知池新建的会话; 队列据此即时回填 item.sessionId, 运行中就能按 taskId 转向) */
  onSession?: (sessionId: string) => void
  /** 进度心跳(可选): agent turn 期间定期回调, 参数为本次 turn 的观测摘要(新增事件数/轮数/最近工具) */
  reportProgress?: (info: { events: number; turns: number; lastTool: string }) => void
}

/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果; signal 中止时走官方 cancel */
export async function executeTask(opts: ExecuteTaskOptions): Promise<TaskResult> {
  const { ctx, task, context, cwd, resumeSessionId, title, override, preset, signal, onStart, onSession, reportProgress } = opts
  // 执行目录解析: 无 sessionId 时规范化+白名单校验调用方 cwd(缺省进程 cwd); 有 sessionId 时
  // 会话自身 cwd 是权威执行目录——显式传 cwd 必须与会话目录一致(防"以为在 A 树、实际在 B 树执行"),
  // 缺省沿用会话目录。目录统一后, 按目录与按会话两种入口落到同一把 cwd 锁(统一互斥)。
  let workdir: string
  if (resumeSessionId) {
    const sessionCwd = await sessionCwdOf(ctx, resumeSessionId)
    if (sessionCwd !== undefined) {
      // 白名单边界先行(与接管面同款拒绝语义; 接管面内还有同级校验兜底), 再做一致性校验
      if (state.config.workspaceRoots.length > 0) {
        const refusal = await sessionCwdRefusal(resumeSessionId, sessionCwd)
        if (refusal) throw new Error(refusal)
      }
      if (cwd !== undefined) {
        const requested = await canonicalCwd(cwd)
        if (requested !== sessionCwd) {
          throw new Error(`session ${resumeSessionId} lives in ${sessionCwd}, not the requested cwd ${requested}; `
            + `pass the session's own cwd (see session_list) or omit cwd to follow the session`)
        }
      }
      workdir = sessionCwd
    } else {
      // 会话定位不到(不存在/刚被清理): 用调用方 cwd 走接管路径, 由 takeover 给出 not found
      workdir = await canonicalizeAllowedCwd(cwd)
    }
  } else {
    workdir = await canonicalizeAllowedCwd(cwd)
  }
  // per-call preset 在拿锁前解析(门禁/roster 校验快速失败, 不占排队位); 接管已有会话时忽略(沿用原 preset)
  const presetName = resumeSessionId ? undefined : await resolvePreset(ctx, preset)
  // 统一互斥: 一切任务都锁"实际执行目录"——同一会话的所有入口(按目录池命中/按 sessionId 接管)
  // 必然解析出同一 workdir, 因此同锁串行; 不再有"目录锁 + 会话锁"两套互斥各管半边的问题
  return withLock(workdir, async () => {
    // 排队期间已被取消(task_cancel abort): 不投递给 agent, 直接以取消收场
    if (signal?.aborted) {
      return { taskId: '', sessionId: '', model: { provider: '', model: '' }, preset: '', durationMs: 0, assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', error: 'cancelled before start' }
    }
    // 外部取消与超时先合流到同一 abort: 监听必须先于 getAgent 注册——AbortSignal 对注册前
    // 已发生的 abort 不补发事件, 晚注册会漏掉"会话初始化期间"的取消(followup 照发、cancel 零调用)
    let timedOut = false
    let cancelCause: unknown = { kind: 'user' }
    const timeoutAbort = new AbortController()
    const onOuterAbort = () => timeoutAbort.abort()
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    let claimed: ResolvedAgent
    try {
      onStart?.()
      claimed = await getAgent(ctx, workdir, resumeSessionId, title, override, presetName)
    } catch (e) {
      // 初始化失败(resume 失败/宿主异常): 先摘除取消监听再上抛——不把监听残留在调用方 signal 上
      signal?.removeEventListener('abort', onOuterAbort)
      throw e
    }
    const { sessionId, handle, disposeAfter, selection, preset: mountedPreset } = claimed
    onSession?.(String(sessionId))
    // 会话初始化(await getAgent: 池新建/resume 可能耗时)期间可能已取消: 取得会话后、投递任务前
    // 再查一次——不投递、不开无人接管的 turn; resume 的独占句柄照常释放, 结果按取消收场但带
    // sessionId(调用方仍可续接这个空闲会话)
    if (signal?.aborted) {
      signal?.removeEventListener('abort', onOuterAbort)
      if (disposeAfter) {
        try { await handle.dispose() } catch { /* 释放失败不影响结果 */ }
      }
      return { taskId: '', sessionId, model: selection, preset: mountedPreset, durationMs: 0, assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', error: 'cancelled before start (session claimed, task not delivered)' }
    }
    // 事件基线: 只读本轮新增事件(公开 API snapshotEvents; 旧宿主回退 log 字段)
    const baseline = eventsOf(handle.agent.session).length
    // 标记活跃: 池 LRU 淘汰据此跳过本会话(不能 dispose 一个正在跑 turn 的会话)
    state.activeTurnSessions.add(String(sessionId))
    // 资源面: 活动窗口(dsh://sessions/{id}/activity)立即反映"已启动"
    state.hooks.notifySessionActivity(String(sessionId))
    // 立即回报一次"已启动"(0 事件), 让调用方的进度 UI 无需等第一个心跳间隔
    const progressInfo = (): { events: number; turns: number; lastTool: string } => {
      const events = eventsOf(handle.agent.session).slice(baseline)
      let turns = 0
      let lastTool = ''
      for (const e of events) {
        const t = (e as { type?: string }).type
        if (t === 'turn/start') turns++
        else if (t === 'tool/call') lastTool = (e as { data?: { name?: string } }).data?.name ?? lastTool
      }
      return { events: events.length, turns, lastTool }
    }
    if (reportProgress) void Promise.resolve(reportProgress(progressInfo())).catch(() => { /* 单次心跳失败不影响任务 */ })

    // 组装完整任务文本: 记忆上下文 + 任务 + 执行环境合同 + 结构化输出要求
    const fullTask = [
      context ? `【记忆/上下文(供参考, 来自调用方)】\n${context}\n` : '',
      `【任务】\n${task}\n`,
      `【执行环境】你在无人监督的受控环境里执行; 你的总结会被机器读取, 转交给看不到本次对话的调用方——总结必须自包含, 不要引用对话上下文, 验证要具体到命令/文件/路径。`,
      `【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
      `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
    ].filter(Boolean).join('\n')

    // turn 墙钟起点: 从投递任务起算(含组装后的投递排队), 收敛后差值进结果
    const turnStartedAt = Date.now()
    handle.agent.followup(userMessage(fullTask))
    // 超时门禁(taskTimeoutMs=0 关闭): 到点以 hook 原因走官方 cancel(与上方已合流的外部取消同一 abort)
    const taskTimeoutMs = state.config.taskTimeoutMs
    const timeoutTimer = taskTimeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        cancelCause = { kind: 'hook', reason: `dsh-carrot-on-a-stick: task timeout after ${taskTimeoutMs}ms` }
        timeoutAbort.abort()
      }, taskTimeoutMs)
      : undefined
    // 进度心跳: 调用方在 _meta.progressToken 请求了进度则定期回报 turn 观测摘要;
    // 同时(无条件)驱动资源面的活动窗口订阅推送(hub 侧节流+无人订阅时零开销)
    const progressTimer = setInterval(() => {
      try {
        if (reportProgress) void Promise.resolve(reportProgress(progressInfo())).catch(() => { /* 单次心跳失败不影响任务 */ })
        state.hooks.notifySessionActivity(String(sessionId))
      } catch { /* 忽略单次心跳失败 */ }
    }, state.config.progressIntervalMs)
    try {
      await awaitIdleCancellable(handle.agent, handle.agent.whenIdle(), timeoutAbort.signal, () => cancelCause)
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (progressTimer) clearInterval(progressTimer)
      signal?.removeEventListener('abort', onOuterAbort)
      state.activeTurnSessions.delete(String(sessionId))
      // 资源面: turn 收敛——活动窗口回到 idle, 历史翻新(订阅 history/activity 的客户端各得一次更新)
      state.hooks.notifySessionActivity(String(sessionId))
      state.hooks.notifySessionHistory(String(sessionId))
    }

    // 结构化读输出
    const result: TaskResult = {
      taskId: '', sessionId, model: selection, preset: mountedPreset, durationMs: Date.now() - turnStartedAt,
      assistantText: '', toolCalls: [], toolResults: [],
      changes: '', verification: '', leftovers: '', error: '',
    }
    let observedEvents = 0
    try {
      const events = eventsOf(handle.agent.session).slice(baseline)
      observedEvents = events.length
      for (const e of events) {
        const ev = e as {
          type?: string
          data?: unknown
        }
        if (ev.type === 'assistant/message') {
          const d = ev.data as {
            message?: { content?: { type?: string; text?: string }[]; usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown } }
            /** 0.1.7+ 的 usage 挂在事件载荷上(不再随 message); 两处都试 */
            usage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown }
          } | undefined
          const content = d?.message?.content
          if (content) {
            const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text)
            if (texts.length) result.assistantText += texts.join('\n') + '\n'
          }
          // token 用量(机会式): 0.1.7+ 在事件载荷, 更早宿主在 message.usage; 都没有就省略字段
          const u = d?.usage ?? d?.message?.usage
          if (u && typeof u === 'object') {
            const inTok = Number(u.inputTokens)
            const outTok = Number(u.outputTokens)
            if (Number.isFinite(inTok) || Number.isFinite(outTok)) {
              result.usage = result.usage ?? { inputTokens: 0, outputTokens: 0 }
              result.usage.inputTokens += Number.isFinite(inTok) ? inTok : 0
              result.usage.outputTokens += Number.isFinite(outTok) ? outTok : 0
              const total = Number(u.totalTokens)
              if (Number.isFinite(total)) result.usage.totalTokens = (result.usage.totalTokens ?? 0) + total
            }
          }
        } else if (ev.type === 'tool/call') {
          const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
          result.toolCalls.push({
            name: d?.name ?? '?',
            args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
          })
        } else if (ev.type === 'tool/result') {
          const texts = extractTexts(ev.data ?? ev)
          if (texts.length) result.toolResults.push(texts.join('\n').slice(0, 3000))
        } else if (ev.type === 'turn/end') {
          // 失败透出: turn/end 的非 completed 收场(LlmError/取消/blocked/max-tokens)进 error 字段。
          // E2E 实测教训: 模型调用失败时没有任何 assistant 输出, 不透出的话调用方只拿到"成功"的空结果。
          const d = ev.data as {
            turn?: number
            reason?: { kind?: string; error?: { message?: string; code?: string }; reason?: unknown }
          } | undefined
          const r = d?.reason
          if (r && r.kind && r.kind !== 'completed') {
            const bits = [`turn ${d?.turn ?? '?'} ended: ${r.kind}`]
            if (r.error) bits.push(`${r.error.code ?? 'ERROR'}: ${r.error.message ?? ''}`)
            else if (r.reason !== undefined) bits.push(String(r.reason))
            let msg = bits.join(' — ')
            // blocked 收场通常是宿主在等交互式审批/输入: 无人值守的调用方拿不到它, 给出可执行的下一步
            // (安排宿主侧审批/放宽审批策略后, 用同一 sessionId 续接继续)
            if (r.kind === 'blocked') {
              msg += ' (host is waiting for interactive input/approval that an unattended run cannot grant; '
                + 'arrange approval or relax the host approval policy, then continue via agent_run with this sessionId)'
            }
            result.error = (result.error ? `${result.error} | ` : '') + msg
          }
        }
      }
    } catch (e) {
      // 追加而非覆盖: 读输出中途异常时, 之前已解析出的 assistantText 不丢失
      result.assistantText = `${result.assistantText}[读输出异常] ${String(e)}`.trim()
    }
    // 超时透出: turn/end 事件里只有 canceled 收场, 这里补上"谁砍的、砍的时候多久"
    if (timedOut) {
      result.error = (result.error ? `${result.error} | ` : '') + `task timed out after ${taskTimeoutMs}ms (official agent.cancel fired)`
    }
    // 完全无产出且无错误事件时给出可诊断的兜底(而不是一份"成功"的空结果)
    if (!result.assistantText && !result.error) {
      result.error = observedEvents === 0
        ? 'no new session events observed (turn may not have started)'
        : `turn produced no assistant output (observed ${observedEvents} events, none assistant/message)`
    }

    // 解析结构化 summary
    const summary = parseSummary(result.assistantText)
    result.changes = summary.changes
    result.verification = summary.verification
    result.leftovers = summary.leftovers

    // 持久化同步: 池会话与 resume 会话都在任务后尽力 flush(官方 whenIdle 注释: 消费者自读存储需自行 flush;
    // 不 flush 的话 durable log 只有 header, 进程重启后的续接会丢历史)。失败不阻断结果返回。
    try {
      await (ctx.get('sessions') as { flush?: (session: unknown) => Promise<unknown> } | undefined)?.flush?.(handle.agent.session)
    } catch {
      /* flush 失败不阻断结果返回 */
    }
    // resume 兜底分支: 再释放我们 resume 出来的独占句柄(不留给僵尸 live agent)
    if (disposeAfter) {
      try {
        await handle.dispose()
      } catch {
        /* 释放失败不影响结果 */
      }
    }

    return result
  })
}

/**
 * 会话模型切换后的池维护: 池 key 含模型三元组, 模型变了就要把该会话挪到新 key 下。
 * 目标 key 已被同 cwd 的另一个会话占用时不再入池(避免顶掉别人的默认会话): 该会话仍可按
 * sessionId 接管(ctx.agents.get), 只是不再是"该 cwd + 该模型"的默认池会话。
 */
export function rekeyPooledSession(sessionId: string, next: ModelSelection): void {
  const key = state.sessionToPoolKey.get(sessionId)
  if (key === undefined) return
  const rec = state.liveAgents.get(key)
  state.sessionToPoolKey.delete(sessionId)
  if (rec === undefined) return
  state.liveAgents.delete(key)
  const nextKey = poolKey(rec.cwd, next, rec.preset)
  if (state.liveAgents.has(nextKey)) return
  rec.selection = next
  state.liveAgents.set(nextKey, rec)
  state.sessionToPoolKey.set(sessionId, nextKey)
  // 池明细(dsh://agents)与会话模型字段变化 → 粗粒度清单广播(hub 侧合并)
  state.hooks.notifyListChanged()
}
