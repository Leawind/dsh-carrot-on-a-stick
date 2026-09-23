/**
 * dsh-ops-mcp — 在 Harness 内部启动 MCP server, 把 dsh 的操作能力暴露给任意 MCP 客户端。
 *
 * 工具集:
 *   - echo             : 验证 MCP server 连通
 *   - dsh_list_tools   : 列出 dsh 工具注册表(name + description)
 *   - model_list       : 列出当前可路由的 provider/模型/推理档(选模型前先查这里)
 *   - agent_run        : 同步执行任务(改代码/分析/跑命令), 返回结构化结果;
 *                        客户端 notifications/cancelled 取消 → 官方 agent.cancel({kind:'user'})
 *   - task_inbox       : 调用方 push 结构化任务(任务+上下文)到 dsh 队列, 异步执行, 返回 taskId
 *   - task_result      : 取回任务的结构化结果(changes/verification/leftovers)
 *   - task_list        : 列出队列中的任务(taskId/状态/cwd; 队列可观测)
 *   - task_cancel      : 取消排队/执行中的任务(执行中走官方 agent.cancel)
 *   - session_list     : 列出已知会话元数据(live+持久化合并, 只读)
 *   - select_model     : 切换已存在会话使用的模型(官方 selectModel 路径)
 *   - attach_session   : 把会话归组到其 cwd 对应的工作区(手动补给站)
 *   - rename_session   : 给已有会话改名
 *
 * sessionId 续接: 指定 sessionId 时按 本进程池 → live 会话(UI 手开)→ 持久化 resume 三级接管,
 * 前两者都找不到才报错, 所以进程重启前/UI 手开的会话也能续接。
 * 工作区分组: cwd 先 realpath 规范化再 `workspaceRegistry.resolveByPath ?? create` + attachSession;
 * 启动时对存量未分组会话补挂一次(存量捞回)。
 *
 * 模型选择: 优先级 = 单次调用参数 > 插件 config(provider+model 成对) > 宿主默认选择
 * (ctx.agentDefaultModel.currentSelection(), Web UI 建会话同款来源)。常驻会话按
 * cwd + 模型三元组分池, 所以同一目录下不同模型各占一个会话; 会话内换模型走 select_model。
 *
 * ── 零宿主副本原则 ──
 * 运行时对 `@deepseek-ai/*` 零依赖: 所有 dsh 能力都经注入的宿主服务(ctx.agents/ctx.tools/…)访问,
 * 类型只做编译期声明合并(import type, 构建后擦除)。这样插件自带的新旧依赖副本永远不会与
 * 宿主进程内的私有 Symbol/类标识错位(上游 0.1.x 时代 scopeOf 副本不匹配导致 agent 无工具的根因)。
 *
 * 回路: 调用方上下文 →(context)→ task_inbox → dsh agent 执行 → 结果进队列 → task_result → 调用方持久化
 */

// ── Context 声明合并(仅类型, 编译后擦除): 让 ctx.tools / ctx.llm / ctx.agents / ctx.agentPresets 有类型 ──
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'

import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import http from 'node:http'
import { resolve, sep } from 'node:path'

/** Cordis 插件名 */
export const name = 'dsh-ops-mcp'

/** 插件版本(MCP server 握手时上报) */
const PLUGIN_VERSION = '0.8.0'

/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions']

/** 插件配置 */
export interface Config {
  /** 是否启动 HTTP MCP server(默认 true; 显式 false 时不监听, 仅保留生命周期钩子) */
  http?: boolean
  port?: number
  host?: string
  /** 后端 provider(默认空 = 跟随宿主用户设置; 需与 model 成对配置才生效) */
  provider?: string
  /** 执行任务的模型(默认空 = 跟随宿主用户设置; 需与 provider 成对配置才生效) */
  model?: string
  /** 默认推理强度(适配器定义的 id; 空 = 跟随适配器/提供商默认) */
  reasoningEffort?: string
  /**
   * 是否允许调用方在单次调用里覆盖模型(agent_run/task_inbox 的 provider/model/reasoningEffort,
   * 以及 select_model; 默认 true)。设为 false = 由部署锁死模型, 覆盖请求会被明确拒绝。
   */
  allowModelOverride?: boolean
  /** 挂载的 agent preset(默认 standard) */
  preset?: string
  /** 任务队列容量上限(默认 100) */
  maxQueue?: number
  /**
   * 任务自动超时毫秒数(默认 0 = 不启用)。agent turn 执行超过该时长即走官方
   * agent.cancel({kind:'hook', reason:'task timeout'}), 结果 error 会注明超时。
   * 长任务(大改动/长分析)部署请按需调大或保持关闭。
   */
  taskTimeoutMs?: number
  /** 已完成任务保留毫秒数(默认 10 分钟) */
  taskTtlMs?: number
  /** 常驻 agent 会话上限(默认 8, LRU 淘汰) */
  maxAgents?: number
  /**
   * MCP 传输会话空闲 TTL 毫秒数(默认 24 小时, 0 = 永不淘汰)。
   * 超时未活动的会话被服务端关闭, 客户端下次请求得 404 后按规范重新 initialize。
   */
  sessionTtlMs?: number
  /** Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>, 常数时间比较) */
  authToken?: string
  /** cwd 白名单(设置后 agent 只能在列出的目录下干活; 跨平台分隔符/大小写安全) */
  workspaceRoots?: string[]
  /** Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名; 对外暴露时按需配置) */
  allowedHosts?: string[]
  /** 结果默认详略级别(默认 summary; 单次调用可用 detail 参数覆盖) */
  defaultDetail?: 'summary' | 'normal' | 'full'
  /**
   * 启动时存量捞回: 把现存未分组会话补挂到已注册工作区(默认 false)。
   * 0.1.5+ 的 workspaceRegistry 本身按 header.cwd 自动索引, 该操作只补充手动花名册——
   * 会对用户数据做批量持久化写入, 仅在明确需要时开启。
   */
  reattachOrphans?: boolean
}

/** 运行时配置默认值 */
const DEFAULTS = {
  // provider/model 默认空 = 完全跟随宿主用户设置(官方 session.create 同款)。
  // E2E 教训: 只传 provider 不传 model 会让 persona 提示词的 {{model}} 变量无值, 整个 turn 在组装期失败。
  provider: '',
  model: '',
  reasoningEffort: '',
  allowModelOverride: true,
  preset: 'standard',
  maxQueue: 100,
  taskTimeoutMs: 0,
  taskTtlMs: 10 * 60 * 1000,
  maxAgents: 8,
  sessionTtlMs: 24 * 60 * 60 * 1000,
  authToken: '',
  workspaceRoots: [] as string[],
  defaultDetail: 'summary' as 'summary' | 'normal' | 'full',
}

type RuntimeConfig = typeof DEFAULTS

/** 运行时配置(每次 apply 重新构建, 不跨次泄漏) */
let runtimeConfig: RuntimeConfig = { ...DEFAULTS }

/** 工具回调统一返回 MCP text content */
function out(content: string) {
  return { content: [{ type: 'text' as const, text: content }] }
}

/** 工具执行错误: 同样的 JSON 文本载荷, 但带 isError 标记(MCP 规范: 工具错误 SHOULD 以 result.isError 表达, 不走协议级错误) */
function outError(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true as const }
}

// ── 零宿主副本: 本地等价实现(与宿主 dsh-llm/dsh-session 的纯数据行为逐字段一致) ──

/** SessionId 品牌转换: 宿主实现同样只是编译期 cast, 运行时原样返回字符串 */
function asSessionId(id: string): SessionId {
  return id as SessionId
}

/** 深冻结纯数据(数组/普通对象逐层 Object.freeze) */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze)
    Object.freeze(value)
  } else if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze)
    Object.freeze(value)
  }
  return value
}

/** 等价 dsh-llm 的 createUserMessage: {id, role:'user', content, source} 深冻结的 user 消息(纯数据, 无宿主符号) */
function userMessage(text: string): UserMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: name },
  }) as UserMessage
}

/** 读取会话事件快照: 优先公开 API snapshotEvents()(0.1.5+), 回退旧版运行时同形的 log 字段 */
function eventsOf(session: unknown): readonly unknown[] {
  const s = session as { snapshotEvents?: (from?: number) => readonly unknown[]; log?: readonly unknown[] }
  if (typeof s.snapshotEvents === 'function') return s.snapshotEvents()
  return Array.isArray(s.log) ? s.log : []
}

// ── 工作区归组 ──

/** 工作区视图(ctx.get('workspaceRegistry')): 可选依赖, headless/无 workspace 插件的环境自动跳过 */
interface WorkspaceView {
  id: string
  path: string
  sessionIds: readonly SessionId[]
  attachSession?: (sessionId: SessionId) => Promise<void>
}
interface WorkspaceRegistryView {
  create?: (path: string) => Promise<WorkspaceView>
  resolveByPath?: (path: string) => Promise<WorkspaceView | undefined>
  list?: () => WorkspaceView[]
}

/**
 * cwd realpath 规范化: 解析符号链接与 .. 段, 使 cwd 能与 workspace.path(存储时为 realpath 规范化值)
 * 精确比对——这是官方 attachSession 强校验通过的前提。目录不存在时回退 resolve 结果, 由调用方告警不阻断。
 */
async function canonicalCwd(raw: string): Promise<string> {
  try {
    return await realpath(raw)
  } catch {
    return resolve(raw)
  }
}

/** 官方 session.create RPC 同款姿势: resolveByPath ?? create, 幂等; 无 workspaceRegistry 时返回 undefined */
async function ensureWorkspace(ctx: Context, canonical: string): Promise<WorkspaceView | undefined> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  if (!registry) return undefined
  return (await registry.resolveByPath?.(canonical)) ?? (await registry.create?.(canonical))
}

/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
 *  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。 */
async function attachToWorkspace(ctx: Context, canonical: string, sessionId: SessionId): Promise<void> {
  try {
    const ws = await ensureWorkspace(ctx, canonical)
    if (ws?.attachSession) await ws.attachSession(sessionId)
  } catch (e) {
    console.warn('[dsh-ops-mcp] workspace attach failed:', (e as Error)?.message ?? e)
  }
}

/** 按会话 header 的 cwd(realpath 规范化后)补挂工作区; header 无 cwd 时静默跳过 */
async function attachSessionCwd(ctx: Context, sessionId: SessionId, cwd: string | undefined): Promise<void> {
  if (cwd === undefined) return
  await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId)
}

// ── cwd 白名单(跨平台) ──

/**
 * 跨平台目录包含判定: 双方 resolve 后统一分隔符为 '/', win32 再做大小写折叠。
 * 修复旧版 `startsWith(root + '/')` 在 Windows(反斜杠路径)下子目录永远不匹配的 bug。
 */
function isWithin(root: string, dir: string): boolean {
  const fold = (p: string) => {
    let s = resolve(p)
    if (sep !== '/') s = s.split(sep).join('/')
    return process.platform === 'win32' ? s.toLowerCase() : s
  }
  const r = fold(root)
  const d = fold(dir)
  return d === r || d.startsWith(`${r}/`)
}

// ── agent 会话池 ──

/** 一次模型选择: provider+model 必成对; reasoningEffort 可选 */
interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 调用方单次调用的模型覆盖(三项都可选; 只给一边时由插件 config / 宿主默认补另一边) */
type ModelSelectionOverride = Partial<ModelSelection>

/** 池中常驻 agent 的记录: 记下 cwd 与模型选择, 供 sessionId 续接与"改模型后重新入池"复用 */
interface PooledAgent {
  sessionId: SessionId
  handle: AgentHandle
  /** realpath 规范化后的 cwd(池 key 的第一段) */
  cwd: string
  /** 建这个会话时用的模型选择(结果回报与 re-key 用) */
  selection: ModelSelection
}

/** 常驻 agent 会话(按 cwd + 模型三元组复用, 省 token: 避免每次全量加载项目上下文) */
const liveAgents = new Map<string, PooledAgent>()

/** sessionId → 池 key 索引(支持按 session 续接: 指定 sessionId 时定位到对应常驻会话) */
const sessionToPoolKey = new Map<string, string>()

/** 每个 cwd 的串行执行锁(防同一 agent 会话被并发 followup 冲突) */
const agentLocks = new Map<string, Promise<unknown>>()

/**
 * 池 key = cwd + 模型三元组。
 * 带上模型是"按调用选模型"的基础: 同一目录下不同模型各占一个常驻会话, 而不是共用一个会话
 * 中途漂移模型——这样"用 A 模型跑任务1、B 模型跑任务2"在同一 cwd 里也可预期
 * (代价: 这两个会话不共享上下文)。想在同一个会话里换模型请用 select_model。
 */
function poolKey(cwd: string, selection: ModelSelection): string {
  return [cwd, selection.provider, selection.model, selection.reasoningEffort ?? ''].join('\u0000')
}

/** 取宿主服务: 优先 ctx.get(可选依赖的官方姿势), 回退同名属性(最小假 ctx / 旧宿主) */
function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const viaGet = (ctx as { get?: (n: string) => unknown }).get?.(name)
  if (viaGet !== undefined) return viaGet as T
  return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
}

/** getAgent 的返回: handle 恒有 .agent; resume 出来的独占句柄带 disposeAfter 标记, 任务结束后应 flush+dispose */
interface ResolvedAgent {
  sessionId: SessionId
  handle: AgentHandle
  /** 本会话的模型选择(池命中/live 接管读其原有选择; resume 用现算的选择) */
  selection: ModelSelection
  /** true = 本插件 resume 出来的独占句柄; false/缺省 = 常驻池会话或 live 接管(生命周期归池/owner) */
  disposeAfter?: boolean
}

/**
 * setup 挂载 preset(含 bash/fs/todo/web 等完整工具)。
 * 直接调用宿主服务 ctx.agentPresets.mount——scope 校验由 mount 自身完成,
 * 不再用插件侧 scopeOf 预检(混装副本的私有 Symbol 不匹配曾让预检恒假, 导致 agent 静默失去全部工具)。
 */
async function mountPreset(ctx: Context, agentCtx: Context): Promise<void> {
  await ctx.agentPresets.mount(agentCtx, runtimeConfig.preset)
}

/**
 * 读宿主默认模型选择(agentDefaultModel; 未挂载该插件时为 undefined)。
 * 与 Web UI 建会话同款来源——插件不自己维护一份"默认模型"。
 */
function hostDefaultSelection(ctx: Context): ModelSelectionOverride | undefined {
  return serviceOf<{ currentSelection?: () => ModelSelectionOverride | undefined }>(ctx, 'agentDefaultModel')
    ?.currentSelection?.()
}

/** 调用是否携带了任一模型覆盖字段(用于 allowModelOverride 门禁与"没有覆盖"判定) */
function hasModelOverride(override?: ModelSelectionOverride): boolean {
  return override !== undefined
    && (override.provider !== undefined || override.model !== undefined || override.reasoningEffort !== undefined)
}

/** 把 MCP 工具的可选参数收敛成 override(MCP 客户端可能把空串当"未提供", 一并当没有) */
function selectionOverrideOf(args: { provider?: string; model?: string; reasoningEffort?: string }): ModelSelectionOverride | undefined {
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
  if (!runtimeConfig.allowModelOverride && hasModelOverride(override)) {
    throw new Error('model override is disabled by plugin config (allowModelOverride: false); '
      + 'remove provider/model/reasoningEffort from the call, or enable allowModelOverride in cordis.yml')
  }
  const cfg = { provider: runtimeConfig.provider, model: runtimeConfig.model }
  const host = hostDefaultSelection(ctx)
  const provider = override?.provider || cfg.provider || host?.provider
  const model = override?.model || cfg.model || host?.model
  // 推理强度与模型同源: 调用覆盖 > 插件 config > 宿主默认(仅当模型不是被显式钉住时继承)。
  // 若调用方/插件 profile 已显式钉住 provider+model, 就不继承宿主那个"为别的模型选的"档位——
  // 宿主对不支持的显式 effort 是直接拒绝(不做 clamp/别名), 继承反而会把能跑的部署弄挂。
  const pinnedModel = Boolean((override?.provider && override?.model) || (cfg.provider && cfg.model))
  const reasoningEffort = override?.reasoningEffort
    ?? (runtimeConfig.reasoningEffort || (pinnedModel ? undefined : host?.reasoningEffort))
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

/** 获取(或创建)指定 cwd 的常驻 agent 会话; 传 sessionId 时接管指定会话; 传 title 时给新会话命名 */
async function getAgent(ctx: Context, cwd: string, sessionId?: string, title?: string, override?: ModelSelectionOverride): Promise<ResolvedAgent> {
  // 指定 sessionId: 接管已有会话(长任务分多轮投喂 / 中断后恢复 / UI 手开的会话)
  if (sessionId) {
    // 先看本进程常驻池(池 key 里含模型, 所以按 sessionId → 池 key 的索引定位; 命中 LRU 移到末尾)
    const poolKeyOfSession = sessionToPoolKey.get(sessionId)
    if (poolKeyOfSession !== undefined) {
      const existing = liveAgents.get(poolKeyOfSession)
      if (existing) {
        liveAgents.delete(poolKeyOfSession)
        liveAgents.set(poolKeyOfSession, existing)
        return existing
      }
    }
    const sid = asSessionId(sessionId)
    // 不在常驻池: 看 live(UI 手开的、别的插件持有的会话), 直接接管、不持有 dispose(归其 owner)。
    // 这条路不解析模型选择: 沿用该会话原有的选择(只给一边 override 时也不改它, 想改请用 select_model)。
    const live = ctx.agents.get(sid)
    if (live) {
      // live 会话也补挂工作区(幂等): 用户手开的会话若尚未归组, 这里一并挂名
      await attachSessionCwd(ctx, sid, live.session.header.cwd)
      // no-op dispose 兜底: executeTask 只在 disposeAfter 为 true 时调用 dispose
      return { sessionId: sid, handle: { agent: live, dispose: () => Promise.resolve() }, disposeAfter: false, selection: selectionOfAgent(live) }
    }
    // live 也没有: 从持久化会话存储 resume 并接管(进程重启前的会话、LRU 淘汰后被释放的会话)
    // resume 会重建 agent, 所以这里必须现算一份完整模型选择(agent.options.model 是 {{model}} 变量的来源)
    const selection = resolveAgentOptions(ctx, override)
    let handle: AgentHandle
    try {
      handle = await ctx.agents.resume({
        resumeSessionId: sid,
        agentOptions: agentOptionsOf(selection),
        setup: async (agentCtx) => {
          await mountPreset(ctx, agentCtx)
        },
      })
    } catch (e) {
      // 恢复失败返回明确错误(沿用上游错误风格): 不在常驻池、不是 live、持久化里也没有(或 resume 失败)
      throw new Error(`session not found for resume: ${sessionId} (not live and not persisted; ${(e as Error)?.message ?? e})`)
    }
    await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd)
    return { sessionId: sid, handle, disposeAfter: true, selection }
  }
  // 无 sessionId: 按 cwd + 模型三元组命中/新建常驻会话(不同模型 = 不同会话, 上下文不串联)
  const selection = resolveAgentOptions(ctx, override)
  const key = poolKey(cwd, selection)
  const existing = liveAgents.get(key)
  if (existing) {
    // LRU: 命中则移到末尾(最近使用)
    liveAgents.delete(key)
    liveAgents.set(key, existing)
    // 自愈: 幂等补挂(已在花名册则 no-op; 首次挂名失败的池会话在此被捞回)
    await attachToWorkspace(ctx, await canonicalCwd(cwd), existing.sessionId)
    return existing
  }
  // LRU 淘汰: 超过上限时逐出最久未用的会话
  while (liveAgents.size >= runtimeConfig.maxAgents) {
    const oldestKey = liveAgents.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    const old = liveAgents.get(oldestKey)
    liveAgents.delete(oldestKey)
    if (old) {
      sessionToPoolKey.delete(String(old.sessionId))
      try { void (old.handle as { dispose?: () => Promise<void> } | undefined)?.dispose?.() } catch { /* 忽略 */ }
    }
  }
  const newSessionId = asSessionId(randomUUID())
  // cwd 先 realpath 规范化: session header 的 cwd 与 workspace.path 必须精确相等,
  // 否则 attachSession 强校验 reject(只会 create 注册而 UI 仍落未分组)
  const canonical = await canonicalCwd(cwd)
  const handle = await ctx.agents.create({
    sessionId: newSessionId,
    // 声明 preset: 当前版本主要靠 setup 里 mount, meta.agentPreset 供未来 Harness 版本直接消费。
    meta: { cwd: canonical, agentPreset: runtimeConfig.preset },
    // 模型选择: 调用覆盖 / 插件 config / 宿主默认补全后的完整选择(agent.options.model 是 {{model}} 变量的来源)
    agentOptions: agentOptionsOf(selection),
    setup: async (agentCtx) => {
      await mountPreset(ctx, agentCtx)
    },
  })
  const rec: PooledAgent = { sessionId: newSessionId, handle, cwd, selection }
  liveAgents.set(key, rec)
  sessionToPoolKey.set(String(newSessionId), key)

  // 分组: 把会话归属到 cwd 对应的工作区(resolveByPath ?? create + attachSession; 可选依赖; headless 环境自动跳过)
  void (async () => {
    try {
      const ws = await ensureWorkspace(ctx, canonical)
      if (ws?.attachSession) await ws.attachSession(newSessionId)
    } catch (e) {
      console.warn('[dsh-ops-mcp] workspace attach failed:', String(e))
    }
  })()

  // title 命名(可选): 创建会话后立即命名(走 sessionTitle 服务的 rename)
  if (title) {
    try {
      const session = handle.agent.session as { id?: unknown }
      const st = ctx.get('sessionTitle') as { rename?: (s: unknown, t: string) => unknown } | undefined
      st?.rename?.(session, title)
    } catch (e) {
      console.warn('[dsh-ops-mcp] session title set failed:', String(e))
    }
  }

  return rec
}

/** 同一 cwd 串行执行, 避免并发 followup 同一会话 */
async function withLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const prev = agentLocks.get(cwd) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  agentLocks.set(cwd, next.catch(() => {}))
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

// ── 结构化结果 ──

/** 结构化任务结果 */
interface TaskResult {
  taskId: string
  sessionId: string
  /** 本次执行实际用的模型选择(接管会话读不到 options 时字段为空; 让调用方知道是谁答的) */
  model: ModelSelection
  assistantText: string
  toolCalls: { name: string; args: string }[]
  toolResults: string[]
  changes: string
  verification: string
  leftovers: string
  /**
   * 失败透出: turn/end 的非 completed 收场(LlmError / 取消 / blocked / max-tokens 等)。
   * E2E 实测教训: 模型调用失败时没有 assistant 输出, 不透出错误的话调用方只拿到一份"成功"的空结果。
   */
  error: string
}

/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
function parseSummary(assistantText: string): { changes: string; verification: string; leftovers: string } {
  const empty = { changes: '', verification: '', leftovers: '' }
  // 收集所有 {...} 候选(agent 被要求输出一行 summary JSON)
  const candidates: string[] = []
  const re = /\{[\s\S]*?\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(assistantText)) !== null) {
    candidates.push(m[0])
  }
  // 从后往前: 最后出现的候选最可能是最终 summary, 逐个尝试解析
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i] as string) as Record<string, unknown>
      const s = (v: unknown) => (typeof v === 'string' ? v : '')
      const changes = s(obj.changes) || s(obj.改动)
      const verification = s(obj.verification) || s(obj.验证)
      const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover)
      // 只要含任一 summary 字段就采纳, 否则继续尝试更早的候选
      if (changes || verification || leftovers) {
        return { changes, verification, leftovers }
      }
    } catch {
      // 非合法 JSON, 继续尝试下一个候选
    }
  }
  return empty
}

// ── 结果投影: token 预算 ──
//
// 本插件的存在意义是省 operator(调用方)的上下文: 内部 TaskResult 始终全量(队列与 sessionId 续接
// 不丢信息), 只在返回前按 detail 级别投影。各级字段上限的总和控制在预算内:
//   summary(默认) ≤ ~3k 字符 ≈ 数百 token: 三行总结 + 回答尾部 + 工具名列表 + 错误
//   normal       ≤ ~9k 字符: 上述 + 截断的工具调用参数与结果
//   full         旧版行为(assistantText 8k / 50×2k / 20×2k), 仅排查时用

/** 结果详略级别 */
type DetailLevel = 'summary' | 'normal' | 'full'

/** 各级别字段上限(字符) */
const DETAIL_CAPS: Record<DetailLevel, {
  summaryField: number
  error: number
  assistantTail: number
  toolCalls: number
  toolCallArgs: number
  toolResults: number
  toolResultChars: number
  assistantText: number
}> = {
  summary: { summaryField: 300, error: 300, assistantTail: 1200, toolCalls: 0, toolCallArgs: 0, toolResults: 0, toolResultChars: 0, assistantText: 0 },
  normal: { summaryField: 400, error: 600, assistantTail: 1200, toolCalls: 15, toolCallArgs: 250, toolResults: 6, toolResultChars: 400, assistantText: 0 },
  full: { summaryField: 2000, error: 2000, assistantTail: 0, toolCalls: 50, toolCallArgs: 2000, toolResults: 20, toolResultChars: 2000, assistantText: 8000 },
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max)
}

const DETAIL_ARG = {
  summary: 'summary(默认): 三行总结 + 回答尾部 + 工具名列表, ~数百 token',
  normal: 'normal: 加上截断的工具调用参数与结果(~2k token)',
  full: 'full: 完整原文(最坏数万 token, 仅排查用)',
} as const

/** 结果里的模型回报: 只保留有值的字段(接管别人建的会话、读不到 options 时为空对象) */
function projectModel(selection: ModelSelectionOverride | undefined): Record<string, string> {
  const o: Record<string, string> = {}
  if (selection?.provider) o.provider = selection.provider
  if (selection?.model) o.model = selection.model
  if (selection?.reasoningEffort) o.reasoningEffort = selection.reasoningEffort
  return o
}

/** 读时投影: 把全量 TaskResult 渲染成对应 detail 级别的返回载荷(空 error/taskId 直接省略字段) */
function renderResult(result: TaskResult, detail: DetailLevel): Record<string, unknown> {
  const caps = DETAIL_CAPS[detail]
  const base = {
    detail,
    ...(result.taskId ? { taskId: result.taskId } : {}),
    sessionId: result.sessionId,
    model: projectModel(result.model),
    toolCallCount: result.toolCalls.length,
    toolResultCount: result.toolResults.length,
    ...(result.error ? { error: clip(result.error, caps.error) } : {}),
    changes: clip(result.changes, caps.summaryField),
    verification: clip(result.verification, caps.summaryField),
    leftovers: clip(result.leftovers, caps.summaryField),
  }
  if (detail === 'summary') {
    // 总结 JSON 在回答末尾, 尾部最有信息量; 工具只报名字不报参数
    return {
      ...base,
      assistantTail: result.assistantText.slice(-caps.assistantTail),
      toolCallNames: result.toolCalls.map((c) => c.name),
    }
  }
  if (detail === 'normal') {
    return {
      ...base,
      assistantTail: result.assistantText.slice(-caps.assistantTail),
      toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
      toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
    }
  }
  return {
    ...base,
    assistantText: result.assistantText.slice(0, caps.assistantText),
    toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
    toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
  }
}

/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果; signal 中止时走官方 cancel */
async function executeTask(ctx: Context, task: string, context: string, cwd: string, resumeSessionId?: string, title?: string, override?: ModelSelectionOverride, signal?: AbortSignal): Promise<TaskResult> {
  // 规范化 cwd: realpath 解析符号链接与 .. 段, 避免 /a、/a/.、相对路径、符号链接成为不同 Map key
  // 导致重复创建会话/并发冲突; 同时也是与 workspace.path 精确比对的唯一 canon
  const workdir = await canonicalCwd(cwd ? resolve(cwd) : process.cwd())
  // cwd 白名单: 配置了 workspaceRoots 时, 只允许在列出的目录(含子目录)下干活(防路径穿越)
  if (runtimeConfig.workspaceRoots.length > 0) {
    const allowed = runtimeConfig.workspaceRoots.some((root) => isWithin(root, workdir))
    if (!allowed) {
      throw new Error(`cwd not allowed (outside workspaceRoots): ${workdir}`)
    }
  }
  // sessionId 用 session 锁, 否则用 cwd 锁——都防同一 agent 会话被并发 followup
  const lockKey = resumeSessionId ? `session:${resumeSessionId}` : workdir
  return withLock(lockKey, async () => {
    // 排队期间已被取消(task_cancel abort): 不投递给 agent, 直接以取消收场
    if (signal?.aborted) {
      return { taskId: '', sessionId: '', model: { provider: '', model: '' }, assistantText: '', toolCalls: [], toolResults: [], changes: '', verification: '', leftovers: '', error: 'cancelled before start' }
    }
    const { sessionId, handle, disposeAfter, selection } = await getAgent(ctx, workdir, resumeSessionId, title, override)
    // 事件基线: 只读本轮新增事件(公开 API snapshotEvents; 旧宿主回退 log 字段)
    const baseline = eventsOf(handle.agent.session).length

    // 组装完整任务文本: 记忆上下文 + 任务 + 结构化输出要求
    const fullTask = [
      context ? `【记忆/上下文(供参考, 来自调用方)】\n${context}\n` : '',
      `【任务】\n${task}\n`,
      `【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
      `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
    ].filter(Boolean).join('\n')

    handle.agent.followup(userMessage(fullTask))
    // 超时门禁(taskTimeoutMs=0 关闭): 到点以 hook 原因走官方 cancel, 与外部取消信号合流到同一 abort
    const taskTimeoutMs = runtimeConfig.taskTimeoutMs
    let timedOut = false
    let cancelCause: unknown = { kind: 'user' }
    const timeoutAbort = new AbortController()
    const onOuterAbort = () => timeoutAbort.abort()
    signal?.addEventListener('abort', onOuterAbort, { once: true })
    const timeoutTimer = taskTimeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        cancelCause = { kind: 'hook', reason: `dsh-ops-mcp: task timeout after ${taskTimeoutMs}ms` }
        timeoutAbort.abort()
      }, taskTimeoutMs)
      : undefined
    try {
      await awaitIdleCancellable(handle.agent, handle.agent.whenIdle(), timeoutAbort.signal, () => cancelCause)
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      signal?.removeEventListener('abort', onOuterAbort)
    }

    // 结构化读输出
    const result: TaskResult = {
      taskId: '', sessionId, model: selection, assistantText: '', toolCalls: [], toolResults: [],
      changes: '', verification: '', leftovers: '', error: '',
    }
    let observedEvents = 0
    try {
      const events = eventsOf(handle.agent.session).slice(baseline)
      observedEvents = events.length
      const extractText = (obj: unknown, outTexts: string[]): void => {
        if (Array.isArray(obj)) { obj.forEach((x) => extractText(x, outTexts)); return }
        if (obj && typeof obj === 'object') {
          const rec = obj as Record<string, unknown>
          if (typeof rec.text === 'string' && rec.text.trim()) outTexts.push(rec.text)
          if (typeof rec.content === 'string' && rec.content.trim()) outTexts.push(rec.content)
          for (const v of Object.values(rec)) extractText(v, outTexts)
        }
      }
      for (const e of events) {
        const ev = e as {
          type?: string
          data?: unknown
        }
        if (ev.type === 'assistant/message') {
          const d = ev.data as { message?: { content?: { type?: string; text?: string }[] } } | undefined
          const content = d?.message?.content
          if (content) {
            const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text)
            if (texts.length) result.assistantText += texts.join('\n') + '\n'
          }
        } else if (ev.type === 'tool/call') {
          const d = ev.data as { name?: string; arguments?: string; input?: unknown } | undefined
          result.toolCalls.push({
            name: d?.name ?? '?',
            args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
          })
        } else if (ev.type === 'tool/result') {
          const texts: string[] = []
          extractText(ev.data ?? ev, texts)
          if (texts.length) result.toolResults.push(texts.join('\n').slice(0, 3000))
        } else if (ev.type === 'turn/end') {
          // 失败透出: turn 的非 completed 收场(LlmError/取消/blocked/max-tokens)进 error 字段。
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
            result.error = (result.error ? `${result.error} | ` : '') + bits.join(' — ')
          }
        }
      }
    } catch (e) {
      result.assistantText = `[读输出异常] ${String(e)}`
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

// ── 异步任务队列 ──

/** 异步任务队列(进程内存; 取消用 task_cancel 或 abort controller) */
interface TaskItem {
  id: string
  task: string
  context: string
  cwd: string
  sessionId?: string
  title?: string
  /** 单次调用的模型覆盖(入队后异步执行时才解析成完整选择) */
  provider?: string
  model?: string
  reasoningEffort?: string
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled'
  /** 取消句柄: task_cancel 触发 abort → executeTask 走官方 agent.cancel */
  controller?: AbortController
  result?: TaskResult
  error?: string
  createdAt: number
  finishedAt?: number
}
const taskQueue = new Map<string, TaskItem>()

/** TTL 清理: 删除已完成/失败/已取消且超时的任务(task_inbox/task_list 入口顺带调用) */
function sweepExpiredTasks(): void {
  const now = Date.now()
  for (const [tid, t] of taskQueue) {
    if ((t.status === 'done' || t.status === 'error' || t.status === 'cancelled') && t.finishedAt && now - t.finishedAt > runtimeConfig.taskTtlMs) {
      taskQueue.delete(tid)
    }
  }
}

// ── 会话查找 ──

/**
 * 从持久化快照列表取 SessionHeader。
 * 0.1.5+ 的 sessionPersistence.list() 返回 SessionPersistenceSnapshot[](header 在 .header 字段),
 * 更早版本直接返回裸 header——两种形状都兼容。
 */
function headerOfSnapshot(snap: unknown): SessionHeader | undefined {
  if (!snap || typeof snap !== 'object') return undefined
  const rec = snap as { header?: SessionHeader } & SessionHeader
  return rec.header ?? rec
}

/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志) */
async function findSessionHeader(ctx: Context, sessionId: SessionId): Promise<SessionHeader | undefined> {
  const sessions = ctx.get('sessions') as { get?: (id: SessionId) => { header: SessionHeader } | undefined } | undefined
  const live = sessions?.get?.(sessionId)
  if (live !== undefined) return live.header
  const persistence = ctx.get('sessionPersistence') as { list?: () => Promise<readonly unknown[]> } | undefined
  for (const snap of (await persistence?.list?.()) ?? []) {
    if (headerOfSnapshot(snap)?.id === sessionId) return headerOfSnapshot(snap)
  }
  return undefined
}

/**
 * 存量捞回: 启动时把现存未分组的会话补挂到已注册工作区。
 * 条件: header.cwd 的 realpath 等于某已注册 workspace.path, 且该 sessionId 不在其花名册里。
 * 只补挂到"已注册"工作区, 不新建(避免把无关目录刷成新工作区); 单会话失败不影响其余。
 */
async function reattachOrphanSessions(ctx: Context): Promise<{ attached: number; failed: number }> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  const byPath = new Map<string, WorkspaceView>()
  for (const ws of registry?.list?.() ?? []) byPath.set(ws.path, ws)
  if (byPath.size === 0) return { attached: 0, failed: 0 }

  // live + 持久化 header 合并(live 优先), 按 id 去重(持久化侧兼容快照/裸 header 两种形状)
  const headers = new Map<string, SessionHeader>()
  const sessions = ctx.get('sessions') as { list?: () => { header: SessionHeader }[] } | undefined
  for (const session of sessions?.list?.() ?? []) headers.set(session.header.id, session.header)
  const persistence = ctx.get('sessionPersistence') as { list?: () => Promise<readonly unknown[]> } | undefined
  for (const snap of (await persistence?.list?.()) ?? []) {
    const header = headerOfSnapshot(snap)
    if (header && !headers.has(header.id)) headers.set(header.id, header)
  }

  let attached = 0
  let failed = 0
  for (const header of headers.values()) {
    if (header.cwd === undefined) continue
    const canonical = await canonicalCwd(header.cwd)
    const ws = byPath.get(canonical)
    if (ws === undefined || !ws.attachSession) continue
    if (ws.sessionIds.includes(header.id)) continue
    try {
      await ws.attachSession(header.id)
      attached++
      console.log(`[dsh-ops-mcp] 存量捞回: session ${header.id} -> workspace ${ws.path}`)
    } catch (e) {
      failed++
      console.warn(`[dsh-ops-mcp] 存量捞回失败 session ${header.id}:`, (e as Error)?.message ?? e)
    }
  }
  return { attached, failed }
}

// ── 模型目录(model_list)与池维护(select_model) ──

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
  const out: Record<string, unknown> = { id, name: m.name ?? id }
  const efforts = (m.reasoning?.efforts ?? []).map((e) => ({ id: e.id ?? '', name: e.name ?? e.id ?? '' }))
  if (efforts.length) out.reasoningEfforts = efforts
  if (m.reasoning?.defaultEffort) out.defaultReasoningEffort = m.reasoning.defaultEffort
  return out
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
        return { id, name, models: models.map((m) => projectCatalogModel(m)) }
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
      provider: runtimeConfig.provider || null,
      model: runtimeConfig.model || null,
      reasoningEffort: runtimeConfig.reasoningEffort || null,
      allowModelOverride: runtimeConfig.allowModelOverride,
    },
  }
}

/**
 * 会话模型切换后的池维护: 池 key 含模型三元组, 模型变了就要把该会话挪到新 key 下。
 * 目标 key 已被同 cwd 的另一个会话占用时不再入池(避免顶掉别人的默认会话): 该会话仍可按
 * sessionId 接管(ctx.agents.get), 只是不再是"该 cwd + 该模型"的默认池会话。
 */
function rekeyPooledSession(sessionId: string, next: ModelSelection): void {
  const key = sessionToPoolKey.get(sessionId)
  if (key === undefined) return
  const rec = liveAgents.get(key)
  sessionToPoolKey.delete(sessionId)
  if (rec === undefined) return
  liveAgents.delete(key)
  const nextKey = poolKey(rec.cwd, next)
  if (liveAgents.has(nextKey)) return
  rec.selection = next
  liveAgents.set(nextKey, rec)
  sessionToPoolKey.set(sessionId, nextKey)
}

// ── MCP 工具注册 ──
//
// 用 registerTool(而非 tool): 带 title 与 annotations(2025-06-18 协议新增字段)。
// annotations 是给调用方/模型的行为提示, 不影响执行:
//   readOnlyHint=true   → 纯查询, 不改变任何状态(echo/dsh_list_tools/model_list/task_result)
//   destructiveHint=false → 有写副作用但不具破坏性(改模型/改名/归组: 历史保留、幂等可重试)

/** 在给定 McpServer 上注册工具 */
function registerTools(mcp: McpServer, ctx: Context): void {
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
      description: '列出宿主全局工具注册表(name + description)。注意: 0.1.5+ 的模型工具挂在 preset/agent 作用域, 全局表通常为空; agent 实际可用的工具以 agent_run 结果里的 toolCalls 为准。',
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
      return out(JSON.stringify(list))
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
    },
    async ({ provider }) => out(JSON.stringify(await collectModelCatalog(ctx, provider), null, 2)),
  )

  // 同步执行任务(简单场景: 调用方下发 → 立即拿结果)
  mcp.registerTool(
    'agent_run',
    {
      title: 'Run agent task (sync)',
      description: '同步执行任务(改代码/分析/跑命令), 返回结构化结果。可传 sessionId 续接已有会话(长任务分多轮投喂)。可用 provider/model/reasoningEffort 指定本次模型(见 model_list; 同 cwd 下不同模型各自一个常驻会话)。默认返回 summary 级(省上下文), 需要 toolCalls 原文时传 detail=full。',
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
      },
      annotations: { readOnlyHint: false },
    },
    async ({ task, context, cwd, sessionId, title, detail, provider, model, reasoningEffort }, extra) => {
      // extra.signal: 客户端发 notifications/cancelled(MCP 规范的请求取消)时中止 → 官方 agent.cancel
      const result = await executeTask(ctx, task, context ?? '', cwd ?? process.cwd(), sessionId, title, selectionOverrideOf({ provider, model, reasoningEffort }), extra?.signal)
      const rendered = JSON.stringify(renderResult(result, detail ?? runtimeConfig.defaultDetail), null, 2)
      // turn 失败透出: 带错误的执行结果按 MCP 规范标 isError, 严格客户端/模型可直接识别为失败
      return result.error ? outError(rendered) : out(rendered)
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
      },
      annotations: { readOnlyHint: false },
    },
    async ({ task, context, cwd, sessionId, title, provider, model, reasoningEffort }) => {
      sweepExpiredTasks()
      // 队列容量上限: 活动任务(排队+执行中)超过上限则拒绝
      let active = 0
      for (const t of taskQueue.values()) if (t.status === 'queued' || t.status === 'running') active++
      if (active >= runtimeConfig.maxQueue) {
        return outError(JSON.stringify({ error: `task queue full (${active}/${runtimeConfig.maxQueue})` }))
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
      }
      taskQueue.set(id, item)
      // 异步执行(不阻塞调用方); task_cancel 经 controller.abort() → executeTask 走官方 agent.cancel
      void (async () => {
        item.status = 'running'
        try {
          // 排队期间已被取消: 不再投递给 agent, 直接收敛(cancel 已由 task_cancel 完成)
          if (item.controller?.signal.aborted) return
          item.result = await executeTask(ctx, item.task, item.context, item.cwd, item.sessionId, item.title, selectionOverrideOf(item), item.controller?.signal)
          item.result.taskId = id
          item.status = item.controller?.signal.aborted ? 'cancelled' : 'done'
        } catch (e) {
          item.error = String(e)
          item.status = item.controller?.signal.aborted ? 'cancelled' : 'error'
        } finally {
          item.finishedAt = Date.now()
        }
      })()
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
      const item = taskQueue.get(taskId)
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
      const rendered = JSON.stringify(renderResult(item.result, detail ?? runtimeConfig.defaultDetail), null, 2)
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
      const item = taskQueue.get(taskId)
      if (!item) return outError(JSON.stringify({ error: `task not found: ${taskId}` }))
      if (item.status === 'done' || item.status === 'error' || item.status === 'cancelled') {
        return out(JSON.stringify({ taskId, status: item.status, cancelled: false, note: 'already finished' }))
      }
      item.controller?.abort()
      item.status = 'cancelled'
      return out(JSON.stringify({ taskId, status: item.status, cancelled: true }))
    },
  )

  // 任务清单(队列可观测; 查单个结果用 task_result, 取消用 task_cancel)
  mcp.registerTool(
    'task_list',
    {
      title: 'List tasks',
      description: '列出队列中的任务(taskId/状态/创建时间/cwd)。排队中(queued)/执行中(running)/已完成(done)/失败(error)/已取消(cancelled)。查询单个任务结果用 task_result; 取消用 task_cancel。',
      inputSchema: {
        status: z.enum(['queued', 'running', 'done', 'error', 'cancelled']).optional().describe('按状态过滤(缺省: 全部)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ status }) => {
      sweepExpiredTasks() // 顺带清一次过期项, 防列表被撑大
      const items = [...taskQueue.values()]
        .filter((t) => !status || t.status === status)
        .map((t) => ({
          taskId: t.id,
          status: t.status,
          createdAt: t.createdAt,
          ...(t.finishedAt ? { finishedAt: t.finishedAt } : {}),
          cwd: t.cwd,
          ...(t.error ? { error: String(t.error).slice(0, 200) } : {}),
        }))
      return out(JSON.stringify(items, null, 2))
    },
  )

  // 会话清单(live + 持久化合并, 只读): 挑选要续接/改名/归组的会话
  mcp.registerTool(
    'session_list',
    {
      title: 'List sessions',
      description: '列出已知会话的元数据(sessionId/创建时间/cwd/preset)。live 与持久化合并、live 优先、按创建时间倒序; 用于挑选要续接(agent_run 的 sessionId)/改名/归组的会话。',
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe('最多返回条数(默认 20)'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ limit }) => {
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
      const items = [...headers.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit ?? 20)
        .map((h) => ({
          sessionId: h.id,
          createdAt: h.createdAt,
          ...(liveTitles.get(h.id) ? { title: liveTitles.get(h.id) } : {}),
          ...(h.cwd ? { cwd: h.cwd } : {}),
          ...(h.agentPreset ? { agentPreset: h.agentPreset } : {}),
        }))
      return out(JSON.stringify({ total: headers.size, sessions: items }))
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
      if (!runtimeConfig.allowModelOverride) {
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
      description: '把会话归组到工作区(补给站: 官方 UI 无移动会话功能)。path 缺省用该会话 header 的 cwd; 归组依赖官方 attachSession 的强校验——realpath(header.cwd) 必须与工作区路径精确相等, 不匹配会返回官方报错。',
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

// ── GUI 控制面（webServer 路由） ──

/** webServer 服务视图(web profile 提供; 可选依赖): GUI 同源 HTTP 路由, 形态对齐 dsh-bottom-info-bar */
interface WebServerView {
  register(options: {
    kind: 'prefix'
    path: string
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>
  }): () => void
}

/** 一条 MCP 客户端连接(transport 会话)的观测记录: 面板与 status RPC 的数据源 */
interface McpConnection {
  sessionId: string
  connectedAt: number
  lastActivity: number
  userAgent: string
  requests: number
}

/** GUI 路由前缀: /_dsh/dsh-ops-mcp/<method>, 与 bottom-info-bar 同约定 */
const WEB_ROUTE_PREFIX = '/_dsh/dsh-ops-mcp'

/** JSON 响应(GUI 路由) */
function webRespond(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/** 变更类 GUI 路由的同源校验(sec-fetch-site / origin 对 host; curl 等无 Origin 客户端放行读) */
function sameOrigin(req: http.IncomingMessage): boolean {
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return fetchSite === 'same-origin' || fetchSite === 'same-site'
  const host = req.headers.host
  if (host === undefined) return false
  try {
    const parsed = new URL(origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host
  } catch {
    return false
  }
}

/** 读 GUI 路由请求体(限字节; 超限 413) */
function webReadBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        const err = new Error('body too large') as Error & { status?: number }
        err.status = 413
        reject(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// ── HTTP 层(认证 / Host 校验 / 路由) ──

/** JSON-RPC 错误响应体 */
function jsonrpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })
}

/** Bearer token 常数时间比较(长度不等直接拒, 相等走 timingSafeEqual) */
function bearerOk(req: http.IncomingMessage): boolean {
  if (!runtimeConfig.authToken) return true
  const got = Buffer.from(String(req.headers['authorization'] ?? ''), 'utf8')
  const want = Buffer.from(`Bearer ${runtimeConfig.authToken}`, 'utf8')
  return got.length === want.length && timingSafeEqual(got, want)
}

/** 从 Host 头提取主机名(去端口; '[::1]:8090' → '::1') */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const end = hostHeader.indexOf(']')
    return hostHeader.slice(1, end === -1 ? undefined : end).toLowerCase()
  }
  const colon = hostHeader.indexOf(':')
  return (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase()
}

/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 dsh 能力。
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  // 每次应用都从 config 重建运行时配置(不跨次泄漏; workspaceRoots 预 resolve)
  runtimeConfig = {
    provider: config.provider ?? DEFAULTS.provider,
    model: config.model ?? DEFAULTS.model,
    reasoningEffort: config.reasoningEffort ?? DEFAULTS.reasoningEffort,
    allowModelOverride: config.allowModelOverride ?? DEFAULTS.allowModelOverride,
    preset: config.preset ?? DEFAULTS.preset,
    maxQueue: config.maxQueue ?? DEFAULTS.maxQueue,
    taskTimeoutMs: config.taskTimeoutMs ?? DEFAULTS.taskTimeoutMs,
    taskTtlMs: config.taskTtlMs ?? DEFAULTS.taskTtlMs,
    maxAgents: config.maxAgents ?? DEFAULTS.maxAgents,
    sessionTtlMs: config.sessionTtlMs ?? DEFAULTS.sessionTtlMs,
    authToken: config.authToken ?? DEFAULTS.authToken,
    workspaceRoots: (config.workspaceRoots ?? []).map((r) => resolve(r)),
    defaultDetail: config.defaultDetail ?? DEFAULTS.defaultDetail,
  }

  const port = config.port ?? 8090
  // 安全默认: 仅监听本机。暴露公网/局域网前必须自行加认证+反代+TLS(见 README 警告)
  const host = config.host ?? '127.0.0.1'

  // Host 头白名单: 绑定地址 + loopback 别名 + 显式 allowedHosts(防 DNS rebinding: 恶意网页把
  // 自己域名 rebinding 到 127.0.0.1 后, Host 头仍是该域名 → 拒)
  const allowedHostSet = new Set<string>()
  for (const h of [host, 'localhost', '127.0.0.1', '::1', ...(config.allowedHosts ?? [])]) {
    allowedHostSet.add(h.toLowerCase())
  }

  /** Origin 头校验: 不带 Origin(非浏览器 MCP 客户端的常态)放行; 带了则主机名必须命中同一白名单 */
  const originOk = (req: http.IncomingMessage): boolean => {
    const origin = req.headers['origin']
    if (origin === undefined) return true
    try {
      const parsed = new URL(String(origin))
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
      return allowedHostSet.has(parsed.hostname.toLowerCase())
    } catch {
      return false // Origin: null 等非法值一律拒(无法证明同源)
    }
  }

  // 存量捞回(默认关闭): 0.1.5 的 workspaceRegistry 已按 header.cwd 自动索引, 该操作只是给手动花名册
  // 补条目——会对用户数据做批量持久化写入, 仅在明确需要时开启。
  if (config.reattachOrphans === true) {
    void (async () => {
      try {
        const r = await reattachOrphanSessions(ctx)
        console.log(`[dsh-ops-mcp] 存量捞回完成: attached=${r.attached} failed=${r.failed}`)
      } catch (e) {
        console.warn('[dsh-ops-mcp] 存量捞回异常:', (e as Error)?.message ?? e)
      }
    })()
  }

  // 标准 cordis 生命周期: 用 ctx.effect 注册清理(卸载时关 server + 清空全部映射/会话/队列)
  ctx.effect(() => {
    return () => {
      liveAgents.clear()
      sessionToPoolKey.clear()
      agentLocks.clear()
      taskQueue.clear()
    }
  }, 'dsh-ops-mcp')

  // ── MCP server 观测与软停启(http:false 时仅保留 GUI 控制面) ──
  const startedAt = Date.now()
  /** MCP 连接登记(sessionId → 观测记录); GUI 面板与 status RPC 的数据源, apply 级生命周期 */
  const connections = new Map<string, McpConnection>()
  const servers = new Map<string, McpServer>()
  const transports = new Map<string, StreamableHTTPServerTransport>()
  let server: http.Server | undefined
  let listening = false

  // 会话空闲 TTL GC: 客户端异常退出时不会发 DELETE, transport/McpServer 会无限累积。
  // 超时无活动的会话由服务端关闭, 客户端下次请求得 404 后按规范重新 initialize。0 = 关闭 GC。
  const sessionTtl = runtimeConfig.sessionTtlMs
  const sessionSweeper = sessionTtl > 0
    ? setInterval(() => {
      const now = Date.now()
      for (const [sid, conn] of connections) {
        if (now - Math.max(conn.lastActivity, conn.connectedAt) <= sessionTtl) continue
        const transport = transports.get(sid)
        try { void transport?.close() } catch { /* 尽力关闭 */ }
        // close 正常会触发 onclose 清理映射; 这里兜底防泄漏
        if (transports.has(sid)) {
          transports.delete(sid)
          servers.delete(sid)
          connections.delete(sid)
        }
      }
    }, Math.max(100, Math.min(60_000, Math.floor(sessionTtl / 2))))
    : undefined
  sessionSweeper?.unref?.()

  /** 监听一次(可重复调用): 端口被占/EADDRNOTAVAIL 时抛错, 调用方决定是否致命 */
  const listenOnce = () => new Promise<void>((resolveListen, rejectListen) => {
    const s = server
    if (s === undefined) {
      rejectListen(new Error('server not created (http disabled?)'))
      return
    }
    const onListenError = (e: Error) => {
      s.off('listening', onListening)
      rejectListen(new Error(`cannot listen on ${host}:${port}: ${e.message}`))
    }
    const onListening = () => {
      s.off('error', onListenError)
      resolveListen()
    }
    s.once('error', onListenError)
    s.once('listening', onListening)
    s.listen(port, host)
  })

  /** 状态快照: 版本/监听/配置摘要/运行指标/活跃连接(GUI 面板与 status RPC 同一数据源) */
  const statusSnapshot = () => {
    let queueActive = 0
    let queueDone = 0
    let queueError = 0
    let queueCancelled = 0
    for (const t of taskQueue.values()) {
      if (t.status === 'queued' || t.status === 'running') queueActive++
      else if (t.status === 'done') queueDone++
      else if (t.status === 'cancelled') queueCancelled++
      else queueError++
    }
    return {
      name,
      version: PLUGIN_VERSION,
      listening,
      httpEnabled: config.http !== false,
      endpoint: `http://${host}:${port}/mcp`,
      startedAt,
      uptimeMs: Date.now() - startedAt,
      config: {
        provider: runtimeConfig.provider || '(跟随宿主默认)',
        model: runtimeConfig.model || '(跟随宿主默认)',
        reasoningEffort: runtimeConfig.reasoningEffort || '(适配器默认)',
        allowModelOverride: runtimeConfig.allowModelOverride,
        preset: runtimeConfig.preset,
        defaultDetail: runtimeConfig.defaultDetail,
        maxAgents: runtimeConfig.maxAgents,
        maxQueue: runtimeConfig.maxQueue,
        taskTimeoutMs: runtimeConfig.taskTimeoutMs,
        sessionTtlMs: runtimeConfig.sessionTtlMs,
        authEnabled: runtimeConfig.authToken !== '',
        workspaceRoots: runtimeConfig.workspaceRoots,
      },
      stats: {
        liveAgents: liveAgents.size,
        queue: { active: queueActive, done: queueDone, error: queueError, cancelled: queueCancelled },
        connections: connections.size,
      },
      connections: Array.from(connections.values(), (c) => ({ ...c })),
    }
  }

  /** 软停止: 关监听 + 切断全部连接/transport。等 close 完成再返回, 软启动 re-listen 才可靠 */
  async function stopMcpServer(): Promise<{ stopped: boolean }> {
    const s = server
    if (s === undefined || !listening) return { stopped: true }
    listening = false
    await new Promise<void>((resolveClose) => { s.close(() => resolveClose()) })
    // 同步切断遗留 keep-alive/SSE 连接, 端口释放不依赖对端空闲超时
    s.closeAllConnections?.()
    for (const transport of transports.values()) {
      try { void transport.close() } catch { /* 尽力清理 */ }
    }
    transports.clear()
    servers.clear()
    connections.clear()
    console.log(`[dsh-ops-mcp] MCP server stopped (soft stop, ${host}:${port})`)
    return { stopped: true }
  }

  /** 软启动: 重新监听同端口(端口被占时返回错误而不抛) */
  async function startMcpServer(): Promise<{ started: boolean; error?: string }> {
    if (config.http === false) return { started: false, error: 'http disabled by config' }
    if (listening) return { started: true }
    try {
      await listenOnce()
      listening = true
      console.log(`[dsh-ops-mcp] MCP server listening on ${host}:${port}/mcp (soft start)`)
      return { started: true }
    } catch (e) {
      return { started: false, error: (e as Error)?.message ?? String(e) }
    }
  }

  // ── GUI 控制面: webServer 路由 /_dsh/dsh-ops-mcp/<method>(设置页面板的数据/操作后端) ──
  const WEB_ROUTES: Record<string, () => unknown> = {
    status: () => statusSnapshot(),
    stop: () => stopMcpServer(),
    start: () => startMcpServer(),
  }
  const WEB_MUTATING = new Set(['stop', 'start'])
  ctx.inject(['webServer'], (webCtx) => {
    const webServer = (webCtx as unknown as { webServer: WebServerView }).webServer
    webCtx.effect(() => {
      const dispose = webServer.register({
        kind: 'prefix',
        path: WEB_ROUTE_PREFIX,
        handler: async (req: http.IncomingMessage, res: http.ServerResponse) => {
          try {
            const path = new URL(req.url ?? '/', 'http://localhost').pathname
            if (!path.startsWith(`${WEB_ROUTE_PREFIX}/`)) {
              webRespond(res, 404, { error: 'not found' })
              return
            }
            const method = decodeURIComponent(path.slice(WEB_ROUTE_PREFIX.length + 1))
            const fn = Object.hasOwn(WEB_ROUTES, method) ? WEB_ROUTES[method] : undefined
            if (typeof fn !== 'function') {
              webRespond(res, 404, { error: `unknown method: ${method}` })
              return
            }
            // 变更类方法要求同源(GUI 按钮发起; 防 CSRF 式启停)
            if (WEB_MUTATING.has(method) && !sameOrigin(req)) {
              webRespond(res, 403, { error: 'cross-origin request rejected' })
              return
            }
            // 读 body(仅为了消费流, 方法本身无参; 限 64k 防滥用)
            if (req.method === 'POST' || req.method === 'PUT') await webReadBody(req, 64 * 1024)
            webRespond(res, 200, await fn())
          } catch (e) {
            const status = (e as { status?: number })?.status ?? 500
            webRespond(res, status, { error: status === 500 ? 'internal error' : String((e as Error)?.message ?? e) })
          }
        },
      })
      return () => { dispose() }
    }, 'dsh-ops-mcp: web routes')
  })

  // http: false 显式关闭 MCP 监听(GUI 控制面仍可用: 面板显示"未监听", 可看配置但不可启动)
  if (config.http === false) {
    console.log('[dsh-ops-mcp] http disabled by config, MCP server not started (web panel still available)')
    return
  }

  server = http.createServer(async (req, res) => {
    // Bearer token 认证(配置了 authToken 时强制所有请求校验, 常数时间比较; 401 带 WWW-Authenticate 挑战)
    if (!bearerOk(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="dsh-ops-mcp"' })
      res.end(jsonrpcError(-32001, 'Unauthorized'))
      return
    }
    // Host 头校验(防 DNS rebinding; HTTP/1.1 必有 Host, 缺失视为非法请求)
    const hostHeader = req.headers.host
    if (hostHeader === undefined) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(jsonrpcError(-32600, 'Missing Host header'))
      return
    }
    if (!allowedHostSet.has(hostnameOf(hostHeader))) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(jsonrpcError(-32001, `Host not allowed: ${hostnameOf(hostHeader)}`))
      return
    }
    // Origin 头校验(MCP 规范: 本地 HTTP 服务校验 Origin 防 DNS rebinding)。浏览器会带 Origin,
    // 非浏览器 MCP 客户端通常不带(放行); 带了但主机名不在白名单(含 Origin: null 等解析失败)一律拒。
    if (!originOk(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(jsonrpcError(-32001, `Origin not allowed: ${String(req.headers.origin)}`))
      return
    }
    // 只服务 /mcp 端点, 其余路径 404(不给扫描器留面)。非 JSON-RPC 场景, 响应体用普通错误对象。
    const pathname = (req.url ?? '').split('?')[0] ?? ''
    if (pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Not found: ${pathname}` }))
      return
    }

    const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? undefined
    // 连接观测: 每个带会话头的请求都记一次活跃(连接身份以 User-Agent 识别)
    if (sessionId) {
      const c = connections.get(sessionId)
      if (c) {
        c.lastActivity = Date.now()
        c.requests++
        const ua = String(req.headers['user-agent'] ?? '')
        if (ua && !c.userAgent) c.userAgent = ua
      }
    }
    const existing = sessionId ? transports.get(sessionId) : undefined

    // 已有 session: GET/POST/DELETE 都路由到对应 transport(支持 SSE 流 + 会话终止)
    if (existing) {
      if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
        await existing.handleRequest(req, res)
        return
      }
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(jsonrpcError(-32600, 'Method not allowed'))
      return
    }

    // 新 session 初始化(仅 POST 且无 session id)
    if (req.method === 'POST' && !sessionId) {
      const mcp = new McpServer({ name, version: PLUGIN_VERSION })
      registerTools(mcp, ctx)
      const initUserAgent = String(req.headers['user-agent'] ?? '')
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport)
          servers.set(sid, mcp)
          // 连接登记: 首个 initialize 请求的 User-Agent 即客户端身份
          connections.set(sid, {
            sessionId: sid,
            connectedAt: Date.now(),
            lastActivity: Date.now(),
            userAgent: initUserAgent,
            requests: 1,
          })
        },
      })
      // 会话关闭时清理映射(避免临时 key 泄漏 + 无效会话累积)
      transport.onclose = () => {
        const sid = transport.sessionId
        if (sid) {
          transports.delete(sid)
          servers.delete(sid)
          connections.delete(sid)
        }
      }
      await mcp.connect(transport)
      await transport.handleRequest(req, res)
      return
    }

    // 未知 session → 404(不新建 transport, 避免遗留对象)
    if (sessionId) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(jsonrpcError(-32001, 'Session not found'))
      return
    }

    // 无 session 的非初始化请求 → 400
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(jsonrpcError(-32600, 'Invalid request'))
  })

  // 等待 listen 完成: 端口被占/EADDRNOTAVAIL 时 apply 直接抛错, 插件启动失败可见(不再静默成功)
  await listenOnce()
  listening = true
  console.log(`[dsh-ops-mcp] MCP server listening on ${host}:${port}/mcp`)
  // 运行期错误(如 socket 异常)记日志不崩进程
  server.on('error', (e) => {
    console.error('[dsh-ops-mcp] HTTP server error:', e.message)
  })

  // 卸载时关 server + 清空 transport/server/连接映射(与上面的池/队列清理同属一个 effect 链)
  ctx.effect(() => {
    return () => {
      if (sessionSweeper) clearInterval(sessionSweeper)
      server?.close()
      // 热重载确定性: HMR 换新实例卸旧 fiber 时同步切断遗留 keep-alive/SSE 连接,
      // 8090 的释放不依赖对端空闲超时; 进行中的请求被 reset(dev 形态可接受)
      server?.closeAllConnections?.()
      for (const transport of transports.values()) {
        try { void transport.close() } catch { /* 尽力清理 */ }
      }
      transports.clear()
      servers.clear()
      connections.clear()
    }
  }, 'dsh-ops-mcp')
}
