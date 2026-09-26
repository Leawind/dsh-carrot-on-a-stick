/**
 * 宿主服务桥接 —— 零宿主副本原则。
 * 运行时对 `@deepseek-ai/*` 零依赖: 所有 dsh 能力都经注入的宿主服务(ctx.agents/ctx.tools/…)访问,
 * 类型只做编译期声明合并(import type, 构建后擦除)。这样插件自带的新旧依赖副本永远不会与
 * 宿主进程内的私有 Symbol/类标识错位(上游 0.1.x 时代 scopeOf 副本不匹配导致 agent 无工具的根因)。
 * 本模块集中放置: 类型声明合并、与宿主逐字段一致的本地等价实现、可选服务视图、
 * 工作区归组与会话查找。
 */
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId, UserMessage } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { PLUGIN_NAME } from './config.js'
import { canonicalCwd } from './paths.js'

/** SessionId 品牌转换: 宿主实现同样只是编译期 cast, 运行时原样返回字符串 */
export function asSessionId(id: string): SessionId {
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
export function userMessage(text: string): UserMessage {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: PLUGIN_NAME },
  }) as UserMessage
}

/** 读取会话事件快照: 优先公开 API snapshotEvents()(0.1.5+), 回退旧版运行时同形的 log 字段 */
export function eventsOf(session: unknown): readonly unknown[] {
  const s = session as { snapshotEvents?: (from?: number) => readonly unknown[]; log?: readonly unknown[] }
  if (typeof s.snapshotEvents === 'function') return s.snapshotEvents()
  return Array.isArray(s.log) ? s.log : []
}

/** 取宿主服务: 优先 ctx.get(可选依赖的官方姿势), 回退同名属性(最小假 ctx / 旧宿主) */
export function serviceOf<T>(ctx: Context, name: string): T | undefined {
  const viaGet = (ctx as { get?: (n: string) => unknown }).get?.(name)
  if (viaGet !== undefined) return viaGet as T
  return (ctx as unknown as Record<string, unknown>)[name] as T | undefined
}

// ── 工作区归组 ──

/** 工作区视图(ctx.get('workspaceRegistry')): 可选依赖, headless/无 workspace 插件的环境自动跳过 */
export interface WorkspaceView {
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

/** 官方 session.create RPC 同款姿势: resolveByPath ?? create, 幂等; 无 workspaceRegistry 时返回 undefined */
export async function ensureWorkspace(ctx: Context, canonical: string): Promise<WorkspaceView | undefined> {
  const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryView | undefined
  if (!registry) return undefined
  return (await registry.resolveByPath?.(canonical)) ?? (await registry.create?.(canonical))
}

/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
 *  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。 */
export async function attachToWorkspace(ctx: Context, canonical: string, sessionId: SessionId): Promise<void> {
  try {
    const ws = await ensureWorkspace(ctx, canonical)
    if (ws?.attachSession) await ws.attachSession(sessionId)
  } catch (e) {
    console.warn('[dsh-carrot-on-a-stick] workspace attach failed:', (e as Error)?.message ?? e)
  }
}

/** 按会话 header 的 cwd(realpath 规范化后)补挂工作区; header 无 cwd 时静默跳过 */
export async function attachSessionCwd(ctx: Context, sessionId: SessionId, cwd: string | undefined): Promise<void> {
  if (cwd === undefined) return
  await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId)
}

// ── 会话查找 ──

/**
 * 从持久化快照列表取 SessionHeader。
 * 0.1.5+ 的 sessionPersistence.list() 返回 SessionPersistenceSnapshot[](header 在 .header 字段),
 * 更早版本直接返回裸 header——两种形状都兼容。
 */
export function headerOfSnapshot(snap: unknown): SessionHeader | undefined {
  if (!snap || typeof snap !== 'object') return undefined
  const rec = snap as { header?: SessionHeader } & SessionHeader
  return rec.header ?? rec
}

/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志) */
export async function findSessionHeader(ctx: Context, sessionId: SessionId): Promise<SessionHeader | undefined> {
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
export async function reattachOrphanSessions(ctx: Context): Promise<{ attached: number; failed: number }> {
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
      console.log(`[dsh-carrot-on-a-stick] 存量捞回: session ${header.id} -> workspace ${ws.path}`)
    } catch (e) {
      failed++
      console.warn(`[dsh-carrot-on-a-stick] 存量捞回失败 session ${header.id}:`, (e as Error)?.message ?? e)
    }
  }
  return { attached, failed }
}
