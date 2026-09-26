// Smoke harness (dev-only): 假宿主(桩 Cordis 服务 + 桩 agent)+ 真 HTTP 的 RPC 小工具。
// smoke.ts 的各 Phase 只负责行为断言; 桩的可观测记录(created/resumed/disposed/…)从这里导入。
// 断言集与桩行为是对齐 src/ 的契约: 改桩先看对应 src 模块的注释。
import { realpathSync } from 'node:fs'
import { request as httpRequest } from 'node:http'

// ── 可观测记录数组(跨 Phase 累积, 断言按需读取) ──
export const attachedIds = []
export const created = []
export const resumed = []
export const disposed = []
export const flushed = []
export const mounted = []
export const selectModelCalls = []
export const disposers = []
export const steered = []
export const injected = []

// smoke 文件所在目录的 realpath(win32 反斜杠规范路径) —— 与 workspace.path / fs.realpath 结果同 canon
export const FAKE_CWD = realpathSync(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const fakeWs = {
  id: 'ws-fake',
  title: 'fake',
  path: FAKE_CWD,
  sessionIds: [],
  // 真实跟踪花名册: attach_session 的幂等分支(已挂会话返回 attached:false)才有意义
  attachSession: async (id) => { fakeWs.sessionIds.push(id); attachedIds.push(id) },
}
const wsRegistry = {
  list: () => [fakeWs],
  resolveByPath: async (p) => (p === FAKE_CWD ? fakeWs : undefined),
  create: async () => fakeWs,
}

function makeAgent(id, cwd, options) {
  const events = []
  return {
    options,
    // 状态桩: 普通 agent 的 turn 立即收敛, 观测窗口里恒为 idle
    get status() { return 'idle' },
    steer: (message) => { steered.push({ id, message }) },
    inject: (message) => { injected.push({ id, message }) },
    session: {
      id,
      header: { version: 0, id, createdAt: Date.now(), cwd },
      // 公开 API(0.1.5+): 深冻结快照; 这里给个朴素实现
      snapshotEvents: (from = 0) => events.slice(from),
    },
    followup: (message) => {
      events.push({ type: 'user/message', data: { message } })
      events.push({ type: 'turn/start', data: { turn: 1 } })
      events.push({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } })
      events.push({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'file-a file-b' }] } } })
      events.push({
        type: 'assistant/message',
        // usage 桩(TokenUsage 形状): 验证结果的机会式用量聚合
        data: { message: { content: [{ type: 'text', text: 'done {"changes":"c1","verification":"v1","leftovers":"l1"}' }], usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 } } },
      })
    },
    whenIdle: async () => {},
  }
}

const liveAgent = makeAgent('sess-live', FAKE_CWD, { provider: 'live-p', model: 'live-m' })
const liveSession2 = { id: 'sess-live2', title: 'Live Two', header: { version: 0, id: 'sess-live2', createdAt: 1, cwd: FAKE_CWD } }

// 慢 agent: whenIdle 挂起直到 cancel(模拟宿主 cancel 中止 turn 后收敛), 验证取消链路
const slowCancelCalls = []
export const slowAgents = []
function makeSlowAgent(id, cwd, options) {
  const events = []
  let resolveIdle
  let settled = false
  const agent = {
    options,
    cancelCalls: [],
    // 状态桩: whenIdle 挂起期间(= turn 进行中)为 running, cancel 收敛后为 idle
    get status() { return settled ? 'idle' : 'running' },
    steer: (message) => {
      steered.push({ id, message, running: !settled })
      events.push({ type: 'user/message', data: { message } })
    },
    inject: (message) => { injected.push({ id, message, running: !settled }) },
    cancel: (cause) => {
      agent.cancelCalls.push(cause)
      slowCancelCalls.push({ id, cause })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'canceled', reason: cause?.kind ?? 'user' } } })
      settled = true
      const r = resolveIdle
      resolveIdle = undefined
      r?.()
    },
    session: {
      id,
      header: { version: 0, id, createdAt: Date.now(), cwd },
      snapshotEvents: (from = 0) => events.slice(from),
    },
    followup: (message) => {
      events.push({ type: 'user/message', data: { message } })
      events.push({ type: 'turn/start', data: { turn: 1 } })
    },
    whenIdle: () => new Promise((r) => { resolveIdle = r }),
  }
  slowAgents.push(agent)
  return agent
}
export const slowLiveAgent = makeSlowAgent('sess-slow', FAKE_CWD, { provider: 'live-p', model: 'live-m' })

// 失败路径: 只产出 turn/end{reason: error} 的 live 会话(模型调用失败的样子)
const errAgent = (() => {
  const events = []
  return {
    session: { id: 'sess-err', header: { version: 0, id: 'sess-err', createdAt: 1, cwd: FAKE_CWD }, snapshotEvents: (from = 0) => events.slice(from) },
    followup: (message) => {
      events.push({ type: 'user/message', data: { message } })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'error', error: { code: 'AUTH', message: 'invalid api key' } } } })
    },
    whenIdle: async () => {},
  }
})()

/** 池新建会话的注册表(模拟真实宿主: create 的会话即进入 sessions 服务) */
const liveCreatedSessions = new Map()

const fakeTools = {
  // 0.1.5+ 面: schemas(); 有意不提供 keys() 以证明不再依赖它
  schemas: () => [
    { name: 'bash', description: 'run a shell command' },
    { name: 'read', description: 'read a file' },
  ],
}

// ── 模型目录假服务(sessionController = 官方口径; llm = 回退口径) ──
const fakeAgentDefaultModel = { currentSelection: () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'host-effort' }) }
export const fakeSessionController = {
  modelCatalog: async () => ({
    default: { provider: 'p1', model: 'm1' },
    routableProviders: ['p1', 'p2'],
    groups: [
      {
        id: 'p1',
        name: 'Provider One',
        models: [
          { id: 'm1', name: 'Model One', description: 'LONG-DESCRIPTION-MUST-NOT-LEAK' },
          { id: 'm2', name: 'Model Two', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' } },
        ],
      },
      { id: 'p2', name: 'Provider Two', models: [{ id: 'm9', name: 'Model Nine' }] },
    ],
    failures: [{ id: 'p3', name: 'Provider Three', message: 'no api key' }],
  }),
  selectModel: async (request) => {
    selectModelCalls.push(request)
    // 宿主对不可路由的模型直接拒绝(切换失败路径)
    if (request.model === 'boom') throw new Error('model boom is not routable')
    return { selected: { ...request, sessionId: undefined } }
  },
}
export const fakeSessionTitle = {
  renamed: [],
  rename: (session, title) => {
    fakeSessionTitle.renamed.push({ id: session?.id, title })
    return { title }
  },
}
export const fakeLlm = {
  listProviders: () => [{ id: 'p1', name: 'Provider One' }, { id: 'p2', name: 'Provider Two' }],
  listModels: async (provider) => {
    if (provider === 'p2') throw new Error('catalog unavailable')
    return [{ provider, id: 'm1', name: 'Model One' }]
  },
}

/**
 * 最小假 ctx: services 里没有的走 undefined。
 * sessionController 只作为同名属性提供(证明 serviceOf 的属性回退可用, 也方便造"没有它"的部署)。
 * 提供假 webServer: 捕获 GUI 控制面注册的 handler, 供 Phase J 直接调用路由(同源校验/启停)。
 * extraSessions: [{id, cwd}] → 合成 live agent+session(cwd 可在白名单外, 供 Phase W);
 * extraPersisted: [{id, cwd}] → 合成持久化-only 会话(进 persistence.list, 不在 agents.get)。
 */
export function makeCtx(opts: {
  sessionController?: any
  llm?: any
  sessionTitle?: any
  tools?: any
  extraSessions?: { id: string; cwd?: string }[]
  extraPersisted?: { id: string; cwd?: string }[]
} = {}): any {
  const { sessionController, llm = {}, sessionTitle, tools = fakeTools, extraSessions = [], extraPersisted = [] } = opts
  const webHandlers = new Map()
  const extraAgents = new Map(extraSessions.map((s) => [s.id, makeAgent(s.id, s.cwd, { provider: 'extra-p', model: 'extra-m' })]))
  const fakeSessions = {
    get: (id) => liveCreatedSessions.get(id)
      ?? (id === 'sess-live' ? liveAgent.session : id === 'sess-live2' ? liveSession2 : id === 'sess-err' ? errAgent.session : undefined)
      ?? extraAgents.get(id)?.session,
    list: () => [liveSession2, liveAgent.session, ...[...extraAgents.values()].map((a) => a.session)],
    flush: async (session) => { flushed.push(session.id); return true },
  }
  // 0.1.5+ 的 SessionPersistenceSnapshot(header 在 .header) + 一条旧版裸 header 形状(+ phase 注入的额外持久化会话)
  const fakePersistence = {
    list: async () => [
      { header: { version: 0, id: 'sess-persisted', createdAt: 1, cwd: FAKE_CWD } },
      { version: 0, id: 'sess-legacy', createdAt: 2, cwd: FAKE_CWD },
      ...extraPersisted.map((s, i) => ({ header: { version: 0, id: s.id, createdAt: 3 + i, cwd: s.cwd } })),
    ],
  }
  const fakeWebServer = {
    register: ({ path, handler }) => {
      webHandlers.set('gui', handler)
      return () => webHandlers.delete('gui')
    },
  }
  const ctx = {
    tools,
    llm,
    sessionController,
    agents: {
      get: (id) => (id === 'sess-live' ? liveAgent : id === 'sess-err' ? errAgent : id === 'sess-slow' ? slowLiveAgent : undefined)
        ?? extraAgents.get(id),
      create: async ({ sessionId, meta, agentOptions, setup }) => {
        const id = String(sessionId)
        created.push({ id, cwd: meta?.cwd, agentOptions, preset: meta?.agentPreset })
        // cwd 含 slow-cwd: 建慢 agent(whenIdle 挂起, 仅 cancel 收敛), 供取消链路测试
        const agent = String(meta?.cwd ?? '').includes('slow-cwd')
          ? makeSlowAgent(id, meta?.cwd, agentOptions)
          : makeAgent(id, meta?.cwd, agentOptions)
        liveCreatedSessions.set(id, agent.session)
        if (setup) await setup({}, agent)
        return { agent, dispose: async () => { disposed.push(id) } }
      },
      resume: async ({ resumeSessionId, agentOptions, setup }) => {
        const id = String(resumeSessionId)
        if (id !== 'sess-persisted') throw new Error(`no persisted session "${id}"`)
        resumed.push({ id, agentOptions })
        const agent = makeAgent(id, FAKE_CWD, agentOptions)
        if (setup) await setup({}, agent)
        return { agent, dispose: async () => { disposed.push(id) } }
      },
    },
    agentPresets: {
      mount: async (agentCtx, id) => { mounted.push(id ?? 'standard'); return { id: id ?? 'standard' } },
      // roster(校验 per-call preset 存在性): standard(默认) + reviewer(测试用自定义人格)
      list: async () => [{ id: 'standard' }, { id: 'reviewer' }],
    },
    sessions: fakeSessions,
    sessionPersistence: fakePersistence,
    workspaceRegistry: wsRegistry,
    effect: (fn) => { const d = fn(); disposers.push(d); return d },
    inject: (deps, fn) => {
      if (deps.includes('webServer')) {
        // 注入的子 ctx 同样要带 effect(GUI 路由的卸载清理经它登记)
        fn({ webServer: fakeWebServer, effect: (fn2) => { const d = fn2(); disposers.push(d); return d } })
      }
    },
    __webHandlers: webHandlers,
    get: (name) => (name === 'workspaceRegistry' ? wsRegistry
      : name === 'sessions' ? fakeSessions
        : name === 'sessionPersistence' ? fakePersistence
: name === 'tools' ? tools
            : name === 'agentDefaultModel' ? fakeAgentDefaultModel
              : name === 'sessionTitle' ? sessionTitle
                : undefined),
  }
  return ctx
}

// ── RPC 小工具(真 HTTP 往返) ──

export const PORT = 8099
export const BASE = `http://127.0.0.1:${PORT}/mcp`

export async function rpc(sessionId, body, extraHeaders = {}) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  })
  const sid = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  return { sid, status: res.status, text }
}

/** 原始 HTTP 请求(fetch 会规范化 Host 头, 伪造 Host 必须走 http.request) */
export function rawRequest(port: number, { method = 'POST', path = '/mcp', headers = {}, body = '' }: { method?: string; path?: string; headers?: Record<string, string | undefined>; body?: string } = {}): Promise<{ status: number | undefined; text: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const r = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => resolvePromise({ status: res.statusCode, text: data }))
    })
    r.on('error', rejectPromise)
    r.end(body)
  })
}

export function parsePayload(text) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data: ')) return JSON.parse(t.slice(6))
  }
  return JSON.parse(text)
}

// 解出 MCP envelope 里的内层 JSON(带 outputSchema 的工具优先取 SDK 校验过的 structuredContent; 其余回退 text JSON); isError 结果取错误文本
export function innerOf(resp) {
  const payload = parsePayload(resp.text)
  if (payload.error) return { error: payload.error.message }
  const r = payload.result
  if (r.isError) return { error: r.content?.[0]?.text ?? 'isError' }
  if (r.structuredContent !== undefined) return r.structuredContent
  return JSON.parse(r.content[0].text)
}

// 断言登记处(键 = 断言名, 值 = 是否通过); 各 Phase 写入, smoke.ts 末尾统一汇报
export const checks: Record<string, boolean> = {}

/** 轮询等待条件成立(默认 5s 超时); 时序敏感断言统一走它, 不依赖固定 sleep */
export async function waitFor(fn, timeoutMs = 5000, step = 100) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (fn()) return true
    if (Date.now() > deadline) return false
    await new Promise((r) => setTimeout(r, step))
  }
}
