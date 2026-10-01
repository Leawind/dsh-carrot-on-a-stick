/**
 * dsh-carrot-on-a-stick — 在 Harness 内部启动 MCP server, 把 dsh 的操作能力暴露给任意 MCP 客户端。
 *
 * 本模块只做装配: 插件导出(name/inject/apply)、运行时配置构建、队列持久化接线、
 * Streamable HTTP 传输层(认证/Host/Origin/体上限/会话路由)与 GUI 控制面。
 *
 * 模块布局(职责单一, 依赖自上而下无环):
 *   config     配置接口与默认值
 *   types      跨模块纯数据类型
 *   state      进程内可变状态(config/池/锁/队列/hooks/通知钩子)
 *   paths      cwd 规范化与 workspaceRoots 白名单(安全边界)
 *   persist    队列持久化静态加密(AES-256-GCM)
 *   projection 结果投影(token 预算)与会话纪要投影
 *   host       宿主服务桥接(零宿主副本原则) + 工作区归组/会话查找
 *   engine     执行引擎(模型解析/会话池/三级接管/取消/进度/结构化结果)
 *   data       数据层: 工具面与资源面共享的读实现(同白名单边界) + 资源 URI 构造器
 *   notify     资源订阅枢纽(per-connection 订阅登记/updated 定向推送/list_changed 合并广播)
 *   tools      17 个 MCP 工具注册与模型目录(resourceFirst 形态下只读面 9 个下线)
 *   resources  资源面: 全量只读 URI + resources/subscribe + completion + annotations
 *   onboarding initialize 的 instructions 引导 + dsh_get_started 帮助文档(agent 认知面)
 *
 * 工具集: echo / dsh_list_tools / dsh_status / workspace_list / model_list / agent_run /
 *   agent_steer / task_inbox / task_result / task_cancel / task_list / session_list /
 *   session_history / select_model / rename_session / attach_session / dsh_get_started
 *   (各工具用途见 tools.ts 与 README)
 *
 * 实时干预: agent_steer 对运行中的 agent 转向(steer)/注入上下文(inject);
 *   空闲会话拒绝 steer(避免无人接管的 turn), inject 挂起到下次唤醒。
 *
 * 模型与人格: 优先级 = 单次调用参数 > 插件 config(provider+model / preset) > 宿主默认选择。
 * 常驻会话按 cwd + 模型三元组 + preset 分池; 会话内换模型走 select_model;
 * preset 只对新建会话生效(接管已有会话沿用其原 preset)。
 *
 * 安全: 默认仅监听本机; Bearer 常时比较; Host/Origin 白名单防 DNS rebinding; 10MB 体上限;
 * workspaceRoots 白名单约束执行与内容读取面。暴露公网前必须加反代 + TLS + 认证(README「安全」)。
 *
 * 回路: 调用方上下文 →(context)→ task_inbox → dsh agent 执行 → 结果进队列 → task_result → 调用方持久化
 */
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { resolve } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { DEFAULTS, PLUGIN_NAME, PLUGIN_VERSION, type Config } from './config.js'
import { state } from './state.js'
import { canonicalCwd } from './paths.js'
import { decryptQueuePayload, encryptQueuePayload, PERSIST_MAGIC } from './persist.js'
import { executeTask, selectionOverrideOf } from './engine.js'
import { registerTools } from './tools.js'
import { registerResources } from './resources.js'
import { resUri } from './data.js'
import { createNotifyHub } from './notify.js'
import { serverInstructions } from './onboarding.js'
import { reattachOrphanSessions } from './host.js'
import type { TaskItem } from './types.js'

/** Cordis 插件名 */
export const name = PLUGIN_NAME

/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions']

/** 插件配置类型(从 config.ts 再导出, 供消费方 import type { Config } from 'dsh-carrot-on-a-stick') */
export type { Config } from './config.js'

// ── GUI 控制面(webServer 路由) ──

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

/** GUI 路由前缀: /_dsh/dsh-carrot-on-a-stick/<method>, 与 bottom-info-bar 同约定 */
const WEB_ROUTE_PREFIX = '/_dsh/dsh-carrot-on-a-stick'

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
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > maxBytes) {
        const err = new Error('body too large') as Error & { status?: number }
        err.status = 413
        rejectPromise(err)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', rejectPromise)
  })
}

// ── HTTP 层(认证 / Host 校验 / 路由) ──

/** JSON-RPC 错误响应体 */
function jsonrpcError(code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null })
}

/** MCP POST 请求体上限(字节): 正常任务/上下文远小于此, 413 拒绝失控载荷防进程内存被打爆 */
const MAX_BODY_BYTES = 10 * 1024 * 1024

/** Bearer token 常数时间比较(长度不等直接拒, 相等走 timingSafeEqual) */
function bearerOk(req: http.IncomingMessage): boolean {
  if (!state.config.authToken) return true
  const got = Buffer.from(String(req.headers['authorization'] ?? ''), 'utf8')
  const want = Buffer.from(`Bearer ${state.config.authToken}`, 'utf8')
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
  // 每次应用都从 config 重建运行时配置(不跨次泄漏; workspaceRoots 预规范化)。
  // 数值做边界钳制: 时长类负数一律按 0(关闭)处理, 容量类下限 1。
  const nonNeg = (n: number | undefined, d: number) => Math.max(0, n ?? d)
  state.config = {
    provider: config.provider ?? DEFAULTS.provider,
    model: config.model ?? DEFAULTS.model,
    reasoningEffort: config.reasoningEffort ?? DEFAULTS.reasoningEffort,
    allowModelOverride: config.allowModelOverride ?? DEFAULTS.allowModelOverride,
    allowPresetOverride: config.allowPresetOverride ?? DEFAULTS.allowPresetOverride,
    preset: config.preset ?? DEFAULTS.preset,
    maxQueue: Math.max(1, config.maxQueue ?? DEFAULTS.maxQueue),
    taskTimeoutMs: nonNeg(config.taskTimeoutMs, DEFAULTS.taskTimeoutMs),
    progressIntervalMs: Math.max(250, config.progressIntervalMs ?? DEFAULTS.progressIntervalMs),
    taskTtlMs: nonNeg(config.taskTtlMs, DEFAULTS.taskTtlMs),
    maxAgents: Math.max(1, config.maxAgents ?? DEFAULTS.maxAgents),
    sessionTtlMs: nonNeg(config.sessionTtlMs, DEFAULTS.sessionTtlMs),
    authToken: config.authToken ?? DEFAULTS.authToken,
    // 白名单根同样 realpath 规范化: 与被校验目录(canonicalCwd)同一 canon, 根路径经符号链接时才不会漏判
    workspaceRoots: await Promise.all((config.workspaceRoots ?? []).map((r) => canonicalCwd(r))),
    // 持久化路径按 cwd 归一化, 相对路径以进程 cwd 为基准, 语义可预期
    queuePersistPath: config.queuePersistPath ? resolve(config.queuePersistPath) : DEFAULTS.queuePersistPath,
    queuePersistKey: config.queuePersistKey ?? DEFAULTS.queuePersistKey,
    defaultDetail: config.defaultDetail ?? DEFAULTS.defaultDetail,
    resourceFirst: config.resourceFirst ?? DEFAULTS.resourceFirst,
  }

  // ── 资源订阅枢纽: 每连接一个 McpServer 实例的架构让订阅按连接隔离; 变更点经 state.hooks 汇入 ──
  const hub = createNotifyHub({ activityThrottleMs: Math.max(250, state.config.progressIntervalMs) })
  state.hooks.notifyTaskChanged = (taskId) => hub.updated(resUri.queueTask(taskId))
  state.hooks.notifySessionActivity = (sessionId) => hub.updatedThrottled(resUri.sessionActivity(sessionId))
  state.hooks.notifySessionHistory = (sessionId) => hub.updated(resUri.sessionHistory(sessionId))
  state.hooks.notifyListChanged = () => hub.listChanged()

  // ── 任务队列持久化(可选): 队列变化串行落盘(最后写入胜出), apply 时恢复 ──
  const persistPath = state.config.queuePersistPath
  let persistChain: Promise<unknown> = Promise.resolve()
  const persistQueue = () => {
    if (!persistPath) return
    // 快照在调用瞬间取, 不在写入执行时: 落盘链有积压时, 卸载(dispose 清空队列)后的迟到写入
    // 若执行时才序列化, 会把空队列写进文件, 重启恢复静默丢掉整个队列(冒烟压测抓到的真实竞态)。
    // "调用语义 = 持久化此刻的队列", 后续调用以更新的快照覆盖, 末次写入必然是最新状态。
    const payload = JSON.stringify([...state.taskQueue.values()])
    const blob = state.config.queuePersistKey
      ? encryptQueuePayload(payload, state.config.queuePersistKey)
      : Buffer.from(payload, 'utf8')
    persistChain = persistChain
      .then(async () => {
        // 原子写: 先落 .tmp 再 rename, persistPath 上的文件永远是完整文件(崩溃不留半截);
        // 配置了 queuePersistKey 时写 AES-256-GCM 密文(magic 'DSHQ1'), 否则 legacy 明文 JSON
        const tmp = `${persistPath}.tmp`
        await writeFile(tmp, blob)
        await rename(tmp, persistPath)
      })
      .catch((e) => console.warn('[dsh-carrot-on-a-stick] queue persist failed:', (e as Error)?.message ?? e))
  }
  state.hooks.persistQueue = persistQueue
  state.hooks.runTaskItem = (item: TaskItem) => {
    void (async () => {
      try {
        // 排队期间已被取消: 不再投递给 agent, 直接收敛(cancel 已由 task_cancel 完成)
        if (item.controller?.signal.aborted) {
          item.status = 'cancelled'
          return
        }
        item.result = await executeTask({
          ctx,
          task: item.task,
          context: item.context,
          cwd: item.cwd,
          resumeSessionId: item.sessionId,
          title: item.title,
          override: selectionOverrideOf(item),
          preset: item.preset,
          signal: item.controller?.signal,
          // running 只在真正拿到 cwd/session 锁开始执行时才标记(排队含锁内等待, 持久化快照才不失真)
          onStart: () => { item.status = 'running'; persistQueue(); state.hooks.notifyTaskChanged(item.id) },
          // 拿到会话即回填(池新建的会话请求参数里没有): 运行中就能被 agent_steer 按 taskId 定位
          onSession: (sid) => {
            if (!item.sessionId) { item.sessionId = sid; persistQueue() }
            state.hooks.notifyTaskChanged(item.id)
          },
        })
        item.result.taskId = item.id
        // 回填实际执行的会话(新建池会话时请求参数里没有), task_list/重启后续接都靠它
        if (!item.sessionId && item.result.sessionId) item.sessionId = item.result.sessionId
        // 终态判定: 取消优先于失败(abort 收场的 turn/end 是 canceled, 不是执行失败);
        // turn 失败(result.error)的任务标 error 而非 done——只轮询状态(detail=status 只回 item.error)
        // 的调用方也能看到失败, 结果本体仍保留在 item.result 可照常取回。
        if (item.controller?.signal.aborted) {
          item.status = 'cancelled'
        } else if (item.result.error) {
          item.status = 'error'
          item.error = item.result.error
        } else {
          item.status = 'done'
        }
      } catch (e) {
        item.error = String(e)
        item.status = item.controller?.signal.aborted ? 'cancelled' : 'error'
      } finally {
        item.finishedAt = Date.now()
        persistQueue()
        // 终态迁移: 订阅 dsh://queue/{taskId} 的客户端在此收到完成/失败推送(免轮询的核心路径)
        state.hooks.notifyTaskChanged(item.id)
      }
    })()
  }

  // 恢复上次进程的队列快照: done/error/cancelled 连结果一起回来, queued 重新执行,
  // running 无法安全续跑半个 turn——如实标记为 interrupted by restart。
  if (persistPath) {
    if (!state.config.queuePersistKey) {
      console.warn('[dsh-carrot-on-a-stick] queue persistence writes plaintext task payloads; set queuePersistKey to encrypt at rest')
    }
    try {
      const raw = await readFile(persistPath)
      // 加密文件(magic 'DSHQ1'): 解密后解析——口令不对/文件被改 → GCM auth 失败, 走下方损坏容忍(告警, 队列从空开始);
      // legacy 明文文件: 直接解析——配置了 key 也能读, 下次落盘自然迁移为密文
      let text: string
      if (raw.subarray(0, PERSIST_MAGIC.length).toString('utf8') === PERSIST_MAGIC) {
        if (!state.config.queuePersistKey) throw new Error('queue file is encrypted but queuePersistKey is not configured')
        text = decryptQueuePayload(raw, state.config.queuePersistKey)
      } else {
        text = raw.toString('utf8')
      }
      const items = JSON.parse(text) as TaskItem[]
      let restored = 0
      for (const item of items) {
        if (state.taskQueue.has(item.id)) continue
        if (item.status === 'running') {
          item.status = 'error'
          item.error = 'interrupted by restart (turn state is not resumable; re-submit if needed)'
          item.finishedAt = item.finishedAt ?? Date.now()
        } else if (item.status === 'queued') {
          item.controller = new AbortController()
        }
        state.taskQueue.set(item.id, item)
        restored++
      }
      for (const item of [...state.taskQueue.values()]) {
        if (item.status === 'queued') state.hooks.runTaskItem(item)
      }
      if (restored > 0) console.log(`[dsh-carrot-on-a-stick] queue restored from ${persistPath}: ${restored} items`)
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        console.warn('[dsh-carrot-on-a-stick] queue restore failed:', (e as Error)?.message ?? e)
      }
    }
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
        console.log(`[dsh-carrot-on-a-stick] 存量捞回完成: attached=${r.attached} failed=${r.failed}`)
      } catch (e) {
        console.warn('[dsh-carrot-on-a-stick] 存量捞回异常:', (e as Error)?.message ?? e)
      }
    })()
  }

  // 标准 cordis 生命周期: 用 ctx.effect 注册清理(卸载时关 server + 清空全部映射/会话/队列)
  ctx.effect(() => {
    return () => {
      state.liveAgents.clear()
      state.sessionToPoolKey.clear()
      state.agentLocks.clear()
      state.taskQueue.clear()
      hub.dispose()
    }
  }, PLUGIN_NAME)

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
  const sessionTtl = state.config.sessionTtlMs
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
          const mcp = servers.get(sid)
          if (mcp) hub.unbind(mcp)
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
    for (const t of state.taskQueue.values()) {
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
        provider: state.config.provider || '(跟随宿主默认)',
        model: state.config.model || '(跟随宿主默认)',
        reasoningEffort: state.config.reasoningEffort || '(适配器默认)',
        allowModelOverride: state.config.allowModelOverride,
        preset: state.config.preset,
        defaultDetail: state.config.defaultDetail,
        maxAgents: state.config.maxAgents,
        maxQueue: state.config.maxQueue,
        taskTimeoutMs: state.config.taskTimeoutMs,
        sessionTtlMs: state.config.sessionTtlMs,
        queuePersist: persistPath !== '',
        queuePersistEncrypted: persistPath !== '' && state.config.queuePersistKey !== '',
        authEnabled: state.config.authToken !== '',
        workspaceRoots: state.config.workspaceRoots,
      },
      stats: {
        liveAgents: state.liveAgents.size,
        queue: { active: queueActive, done: queueDone, error: queueError, cancelled: queueCancelled },
        connections: connections.size,
        // 资源订阅面观测: 绑定连接数 / 订阅总数(跨连接)
        subscriptions: hub.stats(),
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
    console.log(`[dsh-carrot-on-a-stick] MCP server stopped (soft stop, ${host}:${port})`)
    return { stopped: true }
  }

  /** 软启动: 重新监听同端口(端口被占时返回错误而不抛) */
  async function startMcpServer(): Promise<{ started: boolean; error?: string }> {
    if (config.http === false) return { started: false, error: 'http disabled by config' }
    if (listening) return { started: true }
    try {
      await listenOnce()
      listening = true
      console.log(`[dsh-carrot-on-a-stick] MCP server listening on ${host}:${port}/mcp (soft start)`)
      return { started: true }
    } catch (e) {
      return { started: false, error: (e as Error)?.message ?? String(e) }
    }
  }

  // ── GUI 控制面: webServer 路由 /_dsh/dsh-carrot-on-a-stick/<method>(设置页面板的数据/操作后端) ──
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
    }, 'dsh-carrot-on-a-stick: web routes')
  })

  // http: false 显式关闭 MCP 监听(GUI 控制面仍可用: 面板显示"未监听", 可看配置但不可启动)
  if (config.http === false) {
    console.log('[dsh-carrot-on-a-stick] http disabled by config, MCP server not started (web panel still available)')
    return
  }

  server = http.createServer(async (req, res) => {
    // Bearer token 认证(配置了 authToken 时强制所有请求校验, 常数时间比较; 401 带 WWW-Authenticate 挑战)
    if (!bearerOk(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer realm="dsh-carrot-on-a-stick"' })
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
    // 请求体上限: 声明超过上限的 POST 先排空请求体再回 413(不进入传输层读体;
    // 排空是为了客户端拿到完整响应而非连接被重置)
    const contentLength = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      req.resume()
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Payload too large: ${contentLength} bytes > ${MAX_BODY_BYTES}` }))
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
      // instructions 随 initialize result 下发: agent 在拿到工具清单前先读到整体工作流引导
      // resources 能力显式声明(subscribe 由本插件自管登记; listChanged 由 hub 合并广播)
      const mcp = new McpServer({ name, version: PLUGIN_VERSION }, {
        // resourceFirst 部署的引导文本指路资源面; 普通部署指路工具
        instructions: serverInstructions(state.config.resourceFirst),
        capabilities: { resources: { listChanged: true, subscribe: true } },
      })
      registerTools(mcp, ctx, { statusSnapshot })
      registerResources(mcp, ctx, { statusSnapshot, hub })
      const initUserAgent = String(req.headers['user-agent'] ?? '')
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports.set(sid, transport)
          servers.set(sid, mcp)
          // 连接登记: 首个 initialize 请求的 User-Agent 即客户端身份; 订阅枢纽自此收发
          hub.bind(mcp)
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
        hub.unbind(mcp)
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
  console.log(`[dsh-carrot-on-a-stick] MCP server listening on ${host}:${port}/mcp`)
  // 运行期错误(如 socket 异常)记日志不崩进程
  server.on('error', (e) => {
    console.error('[dsh-carrot-on-a-stick] HTTP server error:', e.message)
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
  }, PLUGIN_NAME)
}
