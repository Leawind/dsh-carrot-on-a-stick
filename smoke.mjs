// Dev-only smoke test (not shipped): drives apply() with a minimal fake ctx and verifies
// the current feature set against the real MCP protocol round-trips:
//   1. 任意会话续接: live 接管 / 持久化 resume / 明确报错(三级)
//   2. realpath 规范化: create 的 meta.cwd 为 realpath 值; 目录不存在时回退 resolve 不阻断
//   3. attach_session 工具 + 启动存量捞回(workspaceRegistry/sessions/sessionPersistence 三服务路径,
//      持久化侧兼容 0.1.5+ 快照(.header) 与旧版裸 header 两种形状)
//   4. dsh_list_tools 走 ctx.tools.schemas()(0.1.5+), 不再依赖已移除的 keys()
//   5. preset mount 无 scope 预检, 直接调用(混装副本不再导致静默跳过)
//   6. 事件读取走公开 API snapshotEvents()(私有 log 字段仅作旧宿主回退)
//   7. 安全: Bearer 认证 401 / Host 白名单 403(防 DNS rebinding) / workspaceRoots 跨平台子目录匹配
//   8. 模型选择: model_list(sessionController 官方目录 / llm 回退 / provider 过滤 / 投影省上下文)、
//      agent_run+task_inbox 的 provider/model/reasoningEffort 覆盖、池按 cwd+模型分组、
//      select_model 走官方 selectModel 并 re-key、allowModelOverride:false 门禁
//   9. 协议严格性: 工具错误结果带 isError(MCP 规范 SHOULD)、成功结果省略空 error/taskId、
//      工具带 title+annotations(2025-06-18 字段)、401 带 WWW-Authenticate、
//      Origin 白名单(跨域/null 拒, 同源放行)、404 体不再挪用 -32601、会话空闲 TTL GC
//  10. 取消与可观测: agent_run 经 notifications/cancelled 取消(官方 agent.cancel)、
//      task_cancel/task_list 队列观测、session_list/session_history 查询面
//  11. LRU 淘汰跳过活跃会话、并发压力、GUI 控制面路由(status/stop/start 同源门禁)
import { realpathSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { apply } from './lib/index.js'

const attachedIds = []
const created = []
const resumed = []
const disposed = []
const flushed = []
const mounted = []
const selectModelCalls = []
const disposers = []

// smoke 文件所在目录的 realpath(win32 反斜杠规范路径) —— 与 workspace.path / fs.realpath 结果同 canon
const FAKE_CWD = realpathSync(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

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
    session: {
      id,
      header: { version: 0, id, createdAt: Date.now(), cwd },
      // 公开 API(0.1.5+): 深冻结快照; 这里给个朴素实现
      snapshotEvents: (from = 0) => events.slice(from),
    },
    followup: (message) => {
      events.push({ type: 'user/message', data: { message } })
      events.push({ type: 'tool/call', data: { name: 'bash', arguments: '{"command":"ls"}' } })
      events.push({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'file-a file-b' }] } } })
      events.push({
        type: 'assistant/message',
        data: { message: { content: [{ type: 'text', text: 'done {"changes":"c1","verification":"v1","leftovers":"l1"}' }] } },
      })
    },
    whenIdle: async () => {},
  }
}

const liveAgent = makeAgent('sess-live', FAKE_CWD, { provider: 'live-p', model: 'live-m' })
const liveSession2 = { id: 'sess-live2', title: 'Live Two', header: { version: 0, id: 'sess-live2', createdAt: 1, cwd: FAKE_CWD } }

// 慢 agent: whenIdle 挂起直到 cancel(模拟宿主 cancel 中止 turn 后收敛), 验证取消链路
const slowCancelCalls = []
const slowAgents = []
function makeSlowAgent(id, cwd, options) {
  const events = []
  let resolveIdle
  const agent = {
    options,
    cancelCalls: [],
    cancel: (cause) => {
      agent.cancelCalls.push(cause)
      slowCancelCalls.push({ id, cause })
      events.push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'canceled', reason: cause?.kind ?? 'user' } } })
      const r = resolveIdle
      resolveIdle = undefined
      r?.()
    },
    session: {
      id,
      header: { version: 0, id, createdAt: Date.now(), cwd },
      snapshotEvents: (from = 0) => events.slice(from),
    },
    followup: (message) => { events.push({ type: 'user/message', data: { message } }) },
    whenIdle: () => new Promise((r) => { resolveIdle = r }),
  }
  slowAgents.push(agent)
  return agent
}
const slowLiveAgent = makeSlowAgent('sess-slow', FAKE_CWD, { provider: 'live-p', model: 'live-m' })

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

const fakeSessions = {
  get: (id) => (id === 'sess-live' ? liveAgent.session : id === 'sess-live2' ? liveSession2 : id === 'sess-err' ? errAgent.session : undefined),
  list: () => [liveSession2, liveAgent.session],
  flush: async (session) => { flushed.push(session.id); return true },
}
// 0.1.5+ 的 SessionPersistenceSnapshot(header 在 .header) + 一条旧版裸 header 形状
const fakePersistence = {
  list: async () => [
    { header: { version: 0, id: 'sess-persisted', createdAt: 1, cwd: FAKE_CWD } },
    { version: 0, id: 'sess-legacy', createdAt: 2, cwd: FAKE_CWD },
  ],
}

const fakeTools = {
  // 0.1.5+ 面: schemas(); 有意不提供 keys() 以证明不再依赖它
  schemas: () => [
    { name: 'bash', description: 'run a shell command' },
    { name: 'read', description: 'read a file' },
  ],
}

// ── 模型目录假服务(sessionController = 官方口径; llm = 回退口径) ──
const fakeAgentDefaultModel = { currentSelection: () => ({ provider: 'p1', model: 'm1', reasoningEffort: 'host-effort' }) }
const fakeSessionController = {
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
const fakeSessionTitle = {
  renamed: [],
  rename: (session, title) => {
    fakeSessionTitle.renamed.push({ id: session?.id, title })
    return { title }
  },
}
const fakeLlm = {
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
 */
function makeCtx({ sessionController, llm = {}, sessionTitle, tools = fakeTools } = {}) {
  const webHandlers = new Map()
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
      get: (id) => (id === 'sess-live' ? liveAgent : id === 'sess-err' ? errAgent : id === 'sess-slow' ? slowLiveAgent : undefined),
      create: async ({ sessionId, meta, agentOptions, setup }) => {
        const id = String(sessionId)
        created.push({ id, cwd: meta?.cwd, agentOptions })
        // cwd 含 slow-cwd: 建慢 agent(whenIdle 挂起, 仅 cancel 收敛), 供取消链路测试
        const agent = String(meta?.cwd ?? '').includes('slow-cwd')
          ? makeSlowAgent(id, meta?.cwd, agentOptions)
          : makeAgent(id, meta?.cwd, agentOptions)
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
    agentPresets: { mount: async (agentCtx, id) => { mounted.push(id ?? 'standard'); return { id: id ?? 'standard' } } },
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

const ctx = makeCtx({ sessionController: fakeSessionController, llm: fakeLlm, sessionTitle: fakeSessionTitle })

const PORT = 8099
const BASE = `http://127.0.0.1:${PORT}/mcp`

async function rpc(sessionId, body, extraHeaders = {}) {
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
import { request as httpRequest } from 'node:http'
function rawRequest(port, { method = 'POST', path = '/mcp', headers = {}, body = '' }) {
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

function parsePayload(text) {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('data: ')) return JSON.parse(t.slice(6))
  }
  return JSON.parse(text)
}

// 解出 MCP envelope 里的内层 JSON(text content 是 out() 字符串); isError 结果取错误文本
function innerOf(resp) {
  const payload = parsePayload(resp.text)
  if (payload.error) return { error: payload.error.message }
  const r = payload.result
  if (r.isError) return { error: r.content?.[0]?.text ?? 'isError' }
  return JSON.parse(r.content[0].text)
}

const checks = {}
try {
  // ── Phase B(主流程): 无认证、无白名单, 端口 8099; 存量捞回显式开启 ──
  await apply(ctx, { port: PORT, host: '127.0.0.1', reattachOrphans: true })
  await new Promise((r) => setTimeout(r, 400))

  const init = await rpc(undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } },
  })
  checks['initialize 拿到 sessionId'] = Boolean(init.sid)
  await rpc(init.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const echo = await rpc(init.sid, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { text: 'ping-8099' } } })
  checks['echo 通'] = echo.status === 200 && echo.text.includes('ping-8099')

  const toolsList = await rpc(init.sid, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} })
  const toolNames = parsePayload(toolsList.text).result?.tools?.map((t) => t.name) ?? []
  checks['attach_session 在工具清单里'] = toolNames.includes('attach_session')
  checks['model_list / select_model 在工具清单里'] = toolNames.includes('model_list') && toolNames.includes('select_model')
  const echoTool = parsePayload(toolsList.text).result?.tools?.find((t) => t.name === 'echo')
  checks['工具带 title + annotations(2025-06-18 协议字段)'] = echoTool?.title === 'Echo' && echoTool?.annotations?.readOnlyHint === true

  // ── dsh_list_tools 走 schemas() ──
  const listTools = await rpc(init.sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_list_tools', arguments: {} } })
  const listToolsInner = listTools.status === 200 ? innerOf(listTools) : { error: 'bad' }
  checks['dsh_list_tools 经 schemas() 返回 name+description'] = Array.isArray(listToolsInner)
    && listToolsInner.some((t) => t.name === 'bash' && t.description === 'run a shell command')

  // ── attach_session 工具(正面归组 / 幂等 / 持久化快照 / 旧版裸 header / 未知 四态) ──
  const attachErr = await rpc(init.sid, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-err' } } })
  checks['attach_session live 会话(sess-err 正面归组)'] = attachErr.status === 200 && innerOf(attachErr).attached === true

  const attachMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-nope' } } })
  checks['attach_session 未知会话报错'] = attachMissing.status === 200 && typeof innerOf(attachMissing).error === 'string'

  // 存量捞回在启动时已把 sess-persisted / sess-legacy / sess-live 挂到工作区, 重复挂应幂等返回
  const attachPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-persisted' } } })
  checks['attach_session 持久化会话(.header 快照)'] = attachPersisted.status === 200 && innerOf(attachPersisted).attached === false
    && String(innerOf(attachPersisted).note ?? '').includes('already attached')

  const attachLegacy = await rpc(init.sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-legacy' } } })
  checks['attach_session 旧版裸 header 形状'] = attachLegacy.status === 200 && innerOf(attachLegacy).attached === false
    && String(innerOf(attachLegacy).note ?? '').includes('already attached')

  // ── 任意会话续接三级 ──
  const runLive = await rpc(init.sid, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-live' } } })
  const runLiveInner = runLive.status === 200 ? innerOf(runLive) : { error: 'bad' }
  checks['agent_run 接管 live 会话(不 resume 不 dispose)'] = runLiveInner.sessionId === 'sess-live' && resumed.length === 0 && disposed.length === 0
  // 默认 summary 投影: 不泄漏 toolCalls/toolResults 原文, 只给尾部文本 + 工具名
  checks['默认 summary 形状(省上下文)'] = runLiveInner.toolCalls === undefined && runLiveInner.toolResults === undefined
    && Array.isArray(runLiveInner.toolCallNames) && runLiveInner.toolCallNames[0] === 'bash'
    && typeof runLiveInner.assistantTail === 'string' && runLiveInner.assistantTail.includes('c1')
    && runLiveInner.detail === 'summary'
  // 成功结果: 不带 isError, 空 error/taskId 字段直接省略
  checks['成功结果不带 isError'] = parsePayload(runLive.text).result?.isError === undefined
  checks['成功结果省略空 error/taskId 字段'] = runLiveInner.error === undefined && runLiveInner.taskId === undefined

  const runPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-persisted', detail: 'full' } } })
  const runPersistedInner = runPersisted.status === 200 ? innerOf(runPersisted) : { error: 'bad' }
  checks['agent_run 持久化会话 resume + flush + dispose'] = runPersistedInner.sessionId === 'sess-persisted'
    && resumed.some((r) => r.id === 'sess-persisted') && flushed.includes('sess-persisted') && disposed.includes('sess-persisted')
  checks['resume 也带完整模型选择(agentDefaultModel 补全)'] = resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.provider === 'p1'
    && resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.model === 'm1'
  // full 档保留原文(排查用)
  checks['detail=full 保留 toolCalls 原文'] = Array.isArray(runPersistedInner.toolCalls) && runPersistedInner.toolCalls[0]?.name === 'bash'

  const runUnknown = await rpc(init.sid, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-unknown' } } })
  checks['agent_run 未知会话明确报错'] = runUnknown.status === 200 && String(innerOf(runUnknown).error ?? '').includes('session not found for resume')

  // 失败透出: turn/end error 进 result.error(E2E 发现的静默空结果缺陷), 且整个结果带 isError 标记
  const runErr = await rpc(init.sid, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'boom', sessionId: 'sess-err' } } })
  const runErrInner = runErr.status === 200 ? innerOf(runErr) : { error: 'bad' }
  checks['agent_run 失败透出(turn/end error)'] = String(runErrInner.error ?? '').includes('AUTH') && String(runErrInner.error ?? '').includes('invalid api key')
  checks['agent_run 失败结果带 isError 标记'] = parsePayload(runErr.text).result?.isError === true

  // ── 异步队列: status 轮询不注入 payload, 完成后默认 summary ──
  const inbox = await rpc(init.sid, { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'queued job' } } })
  const inboxInner = inbox.status === 200 ? innerOf(inbox) : { error: 'bad' }
  const queuedId = inboxInner.taskId
  checks['task_inbox 返回 taskId'] = typeof queuedId === 'string' && queuedId.length > 0
  await new Promise((r) => setTimeout(r, 300))
  const stPoll = await rpc(init.sid, { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: queuedId, detail: 'status' } } })
  const stPollInner = stPoll.status === 200 ? innerOf(stPoll) : { error: 'bad' }
  checks['task_result status 轮询: 不注入结果 payload'] = stPollInner.status === 'done' && stPollInner.changes === undefined && stPollInner.toolCallNames === undefined && stPollInner.assistantTail === undefined
  const smFetch = await rpc(init.sid, { jsonrpc: '2.0', id: 17, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: queuedId } } })
  const smFetchInner = smFetch.status === 200 ? innerOf(smFetch) : { error: 'bad' }
  checks['task_result 默认 summary 投影'] = smFetchInner.changes === 'c1' && smFetchInner.toolCallNames?.[0] === 'bash' && smFetchInner.toolResults === undefined

  // 未知 taskId: 错误结果带 isError 标记(MCP 规范: 工具执行错误在 result 里表达, 不走协议级错误)
  const missingTask = await rpc(init.sid, { jsonrpc: '2.0', id: 18, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: 'nope' } } })
  checks['错误结果带 isError 标记(task_result 未知 taskId)'] = parsePayload(missingTask.text).result?.isError === true

  // 事件读取走 snapshotEvents + 结构化解析
  checks['结构化解析(toolCalls/changes/verification)'] = runPersistedInner.toolCalls?.length === 1
    && runPersistedInner.toolCalls[0].name === 'bash'
    && runPersistedInner.changes === 'c1' && runPersistedInner.verification === 'v1' && runPersistedInner.leftovers === 'l1'

  // detail=normal: 截断的 toolCalls, 不注入 toolResults/assistantText 原文
  const runNormal = await rpc(init.sid, { jsonrpc: '2.0', id: 78, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-persisted', detail: 'normal' } } })
  const runNormalInner = runNormal.status === 200 ? innerOf(runNormal) : {}
  checks['detail=normal: 截断 toolCalls/toolResults 不注入原文'] = runNormalInner.detail === 'normal'
    && Array.isArray(runNormalInner.toolCalls) && runNormalInner.toolCalls[0]?.name === 'bash'
    && Array.isArray(runNormalInner.toolResults) && runNormalInner.assistantText === undefined

  // ── realpath 规范化 ──
  const runNew = await rpc(init.sid, { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD } } })
  const runNewInner = runNew.status === 200 ? innerOf(runNew) : { error: 'bad' }
  checks['agent_run 池新建: meta.cwd 为 realpath 值'] = Boolean(created[0]) && created[0].cwd === FAKE_CWD && runNewInner.sessionId === created[0].id
  checks['池新建带完整模型选择(agentDefaultModel 补全, {{model}} 变量来源)'] = created[0]?.agentOptions?.provider === 'p1' && created[0]?.agentOptions?.model === 'm1'

  const missingDir = resolve(FAKE_CWD, 'nonexistent-xyz')
  const runMissingCwd = await rpc(init.sid, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: missingDir } } })
  const runMissingInner = runMissingCwd.status === 200 ? innerOf(runMissingCwd) : { error: 'bad' }
  checks['目录不存在: realpath 回退 resolve 且不阻断'] = Boolean(runMissingInner.sessionId) && created[1]?.cwd === missingDir

  // ── preset mount: 无 scope 守卫, 直接调用 ──
  // created[0](池新建)与 created[1](missing)各 create 一次, sess-persisted resume 一次 → mount ≥ 3
  checks['preset mount 直接调用(无 scope 预检)'] = mounted.length >= 3

  // ── 启动存量捞回(sessions.list + sessionPersistence.list 两源, 含快照与裸 header) ──
  await new Promise((r) => setTimeout(r, 500))
  checks['存量捞回: live 列表会话补挂'] = attachedIds.includes('sess-live2')
  checks['存量捞回: 持久化会话补挂(快照形状)'] = attachedIds.includes('sess-persisted')
  checks['存量捞回: 持久化会话补挂(裸 header 形状)'] = attachedIds.includes('sess-legacy')

  // ── 模型选择: model_list / 按调用覆盖 / select_model / 坏输入 ──
  const modelList = await rpc(init.sid, { jsonrpc: '2.0', id: 30, method: 'tools/call', params: { name: 'model_list', arguments: {} } })
  const ml = modelList.status === 200 ? innerOf(modelList) : { error: 'bad' }
  checks['model_list 走 sessionController 官方目录'] = ml.source === 'sessionController'
    && ml.default?.provider === 'p1' && ml.default?.model === 'm1'
    && Array.isArray(ml.routableProviders) && ml.routableProviders.length === 2
  checks['model_list 保留推理档、丢掉 description(省上下文)'] = JSON.stringify(ml).includes('reasoningEfforts')
    && JSON.stringify(ml).includes('defaultReasoningEffort')
    && !JSON.stringify(ml).includes('LONG-DESCRIPTION-MUST-NOT-LEAK')
  checks['model_list 带 provider 失败信息与插件模型配置'] = ml.failures?.[0]?.id === 'p3'
    && ml.config?.allowModelOverride === true && ml.config?.provider === null

  const modelListP2 = await rpc(init.sid, { jsonrpc: '2.0', id: 31, method: 'tools/call', params: { name: 'model_list', arguments: { provider: 'p2' } } })
  const mlP2 = modelListP2.status === 200 ? innerOf(modelListP2) : { error: 'bad' }
  checks['model_list provider 过滤'] = mlP2.providers?.length === 1 && mlP2.providers[0].id === 'p2'
    && mlP2.routableProviders.length === 1

  // 按调用覆盖模型: create 收到覆盖值, 且与默认模型的会话分开(池按 cwd+模型分组)
  const runOverride = await rpc(init.sid, { jsonrpc: '2.0', id: 32, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' } } })
  const runOverrideInner = runOverride.status === 200 ? innerOf(runOverride) : { error: 'bad' }
  const createdOverride = created.find((c) => c.agentOptions?.provider === 'p2')
  checks['agent_run 按调用覆盖模型(create 用覆盖值)'] = Boolean(createdOverride)
    && createdOverride.agentOptions.model === 'm9' && createdOverride.agentOptions.reasoningEffort === undefined
  checks['显式钉住模型时不继承宿主默认推理档(与模型同源)'] = createdOverride?.agentOptions?.reasoningEffort === undefined
    && created.find((c) => c.agentOptions?.provider === 'p1' && c.agentOptions?.model === 'm1')?.agentOptions?.reasoningEffort === 'host-effort'
  checks['结果自报本次用的模型'] = runOverrideInner.model?.provider === 'p2' && runOverrideInner.model?.model === 'm9'
  checks['不同模型各自一个常驻会话(池按模型分组)'] = Boolean(runOverrideInner.sessionId) && runOverrideInner.sessionId !== created[0]?.id

  const createdBefore = created.length
  const runOverrideAgain = await rpc(init.sid, { jsonrpc: '2.0', id: 33, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' } } })
  checks['同模型再调用命中池(不新建会话)'] = created.length === createdBefore
    && innerOf(runOverrideAgain).sessionId === runOverrideInner.sessionId

  // 只给 provider: 用宿主默认选择补 model(与 0.3.1 的补全语义一致)
  const partialCwd = resolve(FAKE_CWD, 'nonexistent-partial-model')
  await rpc(init.sid, { jsonrpc: '2.0', id: 34, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: partialCwd, provider: 'p3' } } })
  checks['只给 provider 时用宿主默认补 model'] = created.find((c) => c.agentOptions?.provider === 'p3')?.agentOptions?.model === 'm1'

  // reasoningEffort 透传(选项在 create 的 agentOptions 里, 不是被丢掉)
  const effortCwd = resolve(FAKE_CWD, 'nonexistent-effort')
  await rpc(init.sid, { jsonrpc: '2.0', id: 35, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: effortCwd, provider: 'p1', model: 'm1', reasoningEffort: 'high' } } })
  checks['reasoningEffort 透传到 agentOptions'] = created.find((c) => c.agentOptions?.reasoningEffort === 'high')?.agentOptions?.provider === 'p1'

  // 接管 live 会话时回报它自己的模型(读 agent.options)
  checks['接管 live 会话回报其原有模型'] = runLiveInner.model?.provider === 'live-p' && runLiveInner.model?.model === 'live-m'

  // select_model: 走官方 selectModel + 池 key 跟随新模型(re-key)
  const selModel = await rpc(init.sid, { jsonrpc: '2.0', id: 36, method: 'tools/call', params: { name: 'select_model', arguments: { sessionId: runOverrideInner.sessionId, provider: 'p2', model: 'm10', reasoningEffort: 'high' } } })
  const selInner = selModel.status === 200 ? innerOf(selModel) : { error: 'bad' }
  checks['select_model 走官方 selectModel 并回报归一化选择'] = selInner.ok === true
    && selectModelCalls.at(-1)?.sessionId === runOverrideInner.sessionId
    && selectModelCalls.at(-1)?.model === 'm10' && selectModelCalls.at(-1)?.reasoningEffort === 'high'
    && selInner.selected?.model === 'm10' && selInner.selected?.reasoningEffort === 'high'

  const createdBeforeRekey = created.length
  const runAfterRekey = await rpc(init.sid, { jsonrpc: '2.0', id: 37, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm10', reasoningEffort: 'high' } } })
  checks['select_model 后池 key 跟随新模型(re-key, 不误开新会话)'] = created.length === createdBeforeRekey
    && innerOf(runAfterRekey).sessionId === runOverrideInner.sessionId

  // 队列侧也带模型覆盖
  const inboxModel = await rpc(init.sid, { jsonrpc: '2.0', id: 38, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'queued with model', cwd: FAKE_CWD, provider: 'p2', model: 'm9' } } })
  const inboxModelId = innerOf(inboxModel).taskId
  await new Promise((r) => setTimeout(r, 300))
  const inboxModelResult = await rpc(init.sid, { jsonrpc: '2.0', id: 39, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: inboxModelId } } })
  checks['task_inbox 的模型覆盖生效(结果自报模型)'] = innerOf(inboxModelResult).model?.model === 'm9'

  // ── 取消链路: agent_run 经 MCP notifications/cancelled → 官方 agent.cancel({kind:'user'}) ──
  // 注意: 规范要求服务端对已取消请求 SHOULD NOT 回响应, 所以这里不 await 响应体,
  // 断言服务端效果(cancel 被调用一次), 最后主动断开连接。
  {
    const ac = new AbortController()
    const slowRunId = 60
    const slowRunFetch = fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': init.sid },
      body: JSON.stringify({ jsonrpc: '2.0', id: slowRunId, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'long job', sessionId: 'sess-slow' } } }),
      signal: ac.signal,
    }).then((res) => res.text()).catch(() => 'aborted')
    await new Promise((r) => setTimeout(r, 200)) // 让请求进入 whenIdle 挂起
    await rpc(init.sid, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: slowRunId } })
    await new Promise((r) => setTimeout(r, 300)) // 让 cancel 链路收敛
    checks['agent_run 可取消(cancelled 通知 → 官方 agent.cancel 一次)'] = slowLiveAgent.cancelCalls.length === 1
      && slowLiveAgent.cancelCalls[0]?.kind === 'user'
    ac.abort() // 服务端不会回响应(规范 SHOULD NOT); 主动断开, 避免 fetch 悬挂
    await slowRunFetch
  }

  // ── task_cancel / task_list: 排队(锁内)与执行中两条取消路 ──
  const slowCwd = resolve(FAKE_CWD, 'slow-cwd')
  const inboxA = await rpc(init.sid, { jsonrpc: '2.0', id: 62, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'slow A', cwd: slowCwd } } })
  const idA = innerOf(inboxA).taskId
  const inboxB = await rpc(init.sid, { jsonrpc: '2.0', id: 63, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'slow B', cwd: slowCwd } } })
  const idB = innerOf(inboxB).taskId
  await new Promise((r) => setTimeout(r, 200)) // A 持锁执行中, B 排队中
  const cancelB = await rpc(init.sid, { jsonrpc: '2.0', id: 64, method: 'tools/call', params: { name: 'task_cancel', arguments: { taskId: idB } } })
  checks['task_cancel: 排队中任务直接取消'] = innerOf(cancelB).cancelled === true
  const taskList1 = await rpc(init.sid, { jsonrpc: '2.0', id: 65, method: 'tools/call', params: { name: 'task_list', arguments: {} } })
  const listArr = taskList1.status === 200 ? innerOf(taskList1) : []
  checks['task_list: 状态快照(A running / B cancelled)'] = Array.isArray(listArr)
    && listArr.find((t) => t.taskId === idA)?.status === 'running'
    && listArr.find((t) => t.taskId === idB)?.status === 'cancelled'
  const cancelA = await rpc(init.sid, { jsonrpc: '2.0', id: 66, method: 'tools/call', params: { name: 'task_cancel', arguments: { taskId: idA } } })
  checks['task_cancel: 执行中任务接受取消'] = innerOf(cancelA).cancelled === true
  await new Promise((r) => setTimeout(r, 300)) // 等 runner 经官方 cancel 收敛
  const resA = await rpc(init.sid, { jsonrpc: '2.0', id: 67, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: idA, detail: 'status' } } })
  const resB = await rpc(init.sid, { jsonrpc: '2.0', id: 68, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: idB, detail: 'status' } } })
  checks['task_result: 两个取消任务均为 cancelled'] = innerOf(resA).status === 'cancelled' && innerOf(resB).status === 'cancelled'
  const resAFull = await rpc(init.sid, { jsonrpc: '2.0', id: 71, method: 'tools/call', params: { name: 'task_result', arguments: { taskId: idA } } })
  checks['取消结果失败透出(error 含 canceled)'] = String(innerOf(resAFull).error ?? '').includes('canceled')
  const slowPoolAgent = slowAgents.find((a) => a.session.header.cwd === slowCwd)
  checks['执行中取消触发官方 agent.cancel(池会话一次)'] = slowPoolAgent?.cancelCalls.length === 1

  // ── session_list: live + 持久化合并(live 优先) ──
  const sessList = await rpc(init.sid, { jsonrpc: '2.0', id: 69, method: 'tools/call', params: { name: 'session_list', arguments: {} } })
  const sl = sessList.status === 200 ? innerOf(sessList) : { total: 0, sessions: [] }
  checks['session_list: live+持久化合并(快照/裸 header)'] = sl.total >= 3
    && sl.sessions.some((s) => s.sessionId === 'sess-live2')
    && sl.sessions.some((s) => s.sessionId === 'sess-persisted')
    && sl.sessions.some((s) => s.sessionId === 'sess-legacy')
    && sl.sessions.find((s) => s.sessionId === 'sess-live2')?.title === 'Live Two'
  checks['session_list: 回报已知会话的当前模型'] = sl.sessions.some((s) => s.sessionId === 'sess-live'
    && s.model?.provider === 'live-p' && s.model?.model === 'live-m')
    && !sl.sessions.some((s) => s.sessionId === 'sess-persisted' && s.model)
  const sessListLim = await rpc(init.sid, { jsonrpc: '2.0', id: 70, method: 'tools/call', params: { name: 'session_list', arguments: { limit: 2 } } })
  const slLim = sessListLim.status === 200 ? innerOf(sessListLim) : { total: 0, sessions: [] }
  checks['session_list: limit 截断且 total 不变'] = slLim.sessions.length === 2 && slLim.total === sl.total

  // ── session_history: live 会话纪要(从最新往回取, 时间正序返回) ──
  const histLive = await rpc(init.sid, { jsonrpc: '2.0', id: 72, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live' } } })
  const hl = histLive.status === 200 ? innerOf(histLive) : { turns: [] }
  checks['session_history: live 会话纪要(assistant+tool_call)'] = Array.isArray(hl.turns) && hl.turns.length >= 3
    && hl.turns.some((t) => t.role === 'assistant' && String(t.text).includes('done'))
    && hl.turns.some((t) => t.role === 'tool_call' && t.name === 'bash')
  const histLim = await rpc(init.sid, { jsonrpc: '2.0', id: 73, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-live', limit: 2 } } })
  const hlim = histLim.status === 200 ? innerOf(histLim) : { turns: [] }
  checks['session_history: limit 截断且时间正序'] = hlim.turns?.length === 2 && hlim.turns[0].index < hlim.turns[1].index
  const histPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 74, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'sess-persisted' } } })
  checks['session_history: 持久化-only 会话明确报不可读'] = parsePayload(histPersisted.text).result?.isError === true
    && String(innerOf(histPersisted).error ?? '').includes('not live')

  // ── rename_session: 成功(走 sessionTitle 服务)与未知会话 ──
  const renameOk = await rpc(init.sid, { jsonrpc: '2.0', id: 75, method: 'tools/call', params: { name: 'rename_session', arguments: { sessionId: 'sess-live', title: 'renamed-live' } } })
  const renameOkInner = renameOk.status === 200 ? innerOf(renameOk) : {}
  checks['rename_session: 成功改名(走 sessionTitle 服务)'] = renameOkInner.ok === true && renameOkInner.title === 'renamed-live'
    && fakeSessionTitle.renamed.at(-1)?.id === 'sess-live'
  const renameMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 76, method: 'tools/call', params: { name: 'rename_session', arguments: { sessionId: 'sess-nope' } } })
  checks['rename_session: 未知会话带 isError'] = parsePayload(renameMissing.text).result?.isError === true

  // select_model 切换失败(宿主 selectModel 抛错) → isError 且透出宿主原因
  const selFail = await rpc(init.sid, { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'select_model', arguments: { sessionId: 'sess-live', provider: 'p2', model: 'boom' } } })
  checks['select_model: 宿主切换失败透出原因(isError)'] = parsePayload(selFail.text).result?.isError === true
    && String(innerOf(selFail).error ?? '').includes('boom is not routable')

  // ── 传输层路由: GET 独立 SSE 流 + DELETE 会话终止(用一次性会话) ──
  const init2 = await rpc(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-sse', version: '1.0' } } })
  await rpc(init2.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
  const getSse = await fetch(BASE, { method: 'GET', headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': init2.sid } })
  checks['GET /mcp: 独立 SSE 流(200 + event-stream)'] = getSse.status === 200
    && String(getSse.headers.get('content-type') ?? '').includes('text/event-stream')
  getSse.body?.cancel()
  const delRes = await fetch(BASE, { method: 'DELETE', headers: { 'Mcp-Session-Id': init2.sid } })
  checks['DELETE /mcp: 会话终止'] = delRes.status === 200 || delRes.status === 204
  await delRes.text().catch(() => '')
  const postDel = await rpc(init2.sid, { jsonrpc: '2.0', id: 90, method: 'tools/list', params: {} })
  checks['DELETE 后旧会话 404'] = postDel.status === 404

  // 卸载 Phase B(清空池/队列/server), 再起 Phase A
  for (const d of disposers.splice(0)) {
    if (typeof d === 'function') d()
    else if (d && typeof d.next === 'function') { /* generator disposer: 尽力跑完 */ }
  }
  await new Promise((r) => setTimeout(r, 200))

  // ── Phase A(安全): authToken + workspaceRoots + Host 白名单, 端口 8098 ──
  const PORT_A = 8098
  const BASE_A = `http://127.0.0.1:${PORT_A}/mcp`
  await apply(ctx, { port: PORT_A, host: '127.0.0.1', authToken: 'sekrit-token', workspaceRoots: [FAKE_CWD] })
  await new Promise((r) => setTimeout(r, 200))

  const unauth = await fetch(BASE_A, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } }),
  })
  checks['authToken: 无 Bearer 被 401'] = unauth.status === 401
  checks['401 带 WWW-Authenticate: Bearer 挑战'] = String(unauth.headers.get('www-authenticate') ?? '').startsWith('Bearer')
  await unauth.text()

  const authOk = await fetch(BASE_A, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer sekrit-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0' } } }),
  })
  checks['authToken: 正确 Bearer 通过'] = authOk.status === 200
  const sidA = authOk.headers.get('mcp-session-id') ?? undefined
  await authOk.text()

  const evilHost = await rawRequest(PORT_A, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: 'evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {}, ...(sidA ? { 'Mcp-Session-Id': sidA } : {}) }),
  })
  checks['Host 白名单: 非 allowlist 主机名被 403'] = evilHost.status === 403

  // Origin 校验(MCP 规范: 本地 HTTP 服务校验 Origin 防 DNS rebinding): 不带 Origin 的 MCP 客户端不受影响
  const evilOrigin = await rawRequest(PORT_A, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: '127.0.0.1', Origin: 'http://evil.example' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/list', params: {}, ...(sidA ? { 'Mcp-Session-Id': sidA } : {}) }),
  })
  checks['Origin 白名单: 跨域 Origin 被 403'] = evilOrigin.status === 403

  const nullOrigin = await rawRequest(PORT_A, {
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: '127.0.0.1', Origin: 'null' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {}, ...(sidA ? { 'Mcp-Session-Id': sidA } : {}) }),
  })
  checks['Origin: null 被拒(无法证明同源)'] = nullOrigin.status === 403

  const sameOriginReq = await fetch(BASE_A, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: 'Bearer sekrit-token', Origin: `http://127.0.0.1:${PORT_A}`,
      ...(sidA ? { 'Mcp-Session-Id': sidA } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/list', params: {} }),
  })
  checks['Origin 同源主机放行(端口不参与比对)'] = sameOriginReq.status === 200
  await sameOriginReq.text()

  // 超大载荷: content-length 声明超限的 POST 直接 413, 不进入传输层
  const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'echo', arguments: { text: 'x'.repeat(10 * 1024 * 1024 + 1) } } })
  const bigPost = await rawRequest(PORT_A, { headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sekrit-token', Host: '127.0.0.1' }, body: bigBody })
  checks['请求体上限: 超大 POST 被 413'] = bigPost.status === 413

  const strayPath = await rawRequest(PORT_A, { path: '/other', headers: { Authorization: 'Bearer sekrit-token', Host: '127.0.0.1' } })
  checks['路径门禁: 非 /mcp 路径 404'] = strayPath.status === 404
  checks['404 体为普通错误对象(不挪用 -32601)'] = (() => {
    try {
      const body = JSON.parse(strayPath.text)
      return body.error === 'Not found: /other' && !strayPath.text.includes('-32601')
    } catch { return false }
  })()

  async function rpcA(sessionId, body) {
    const res = await fetch(BASE_A, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer sekrit-token',
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify(body),
    })
    const sid = res.headers.get('mcp-session-id') ?? sessionId
    const text = await res.text()
    return { sid, status: res.status, text }
  }
  await rpcA(sidA, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const insideDir = resolve(FAKE_CWD, 'sub', 'deeper')
  const runInside = await rpcA(sidA, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: insideDir } } })
  const runInsideInner = runInside.status === 200 ? innerOf(runInside) : { error: 'bad' }
  checks['workspaceRoots: 根下子目录放行(跨平台分隔符)'] = Boolean(runInsideInner.sessionId) && !runInsideInner.error

  const outsideDir = resolve(FAKE_CWD, '..', 'somewhere-else')
  const runOutside = await rpcA(sidA, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', cwd: outsideDir } } })
  const runOutsideInner = runOutside.status === 200 ? innerOf(runOutside) : { error: String(runOutside) }
  checks['workspaceRoots: 白名单外目录拒绝'] = String(runOutsideInner.error ?? '').includes('not allowed')

  // 队列侧同样受限, 且在提交时即拒(不入队, 调用方无需轮询才发现)
  const outsideInbox = await rpcA(sidA, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'task_inbox', arguments: { task: 'x', cwd: outsideDir } } })
  checks['task_inbox: 越界 cwd 提交时即拒(不入队)'] = parsePayload(outsideInbox.text).result?.isError === true
    && String(innerOf(outsideInbox).error ?? '').includes('not allowed')

  // 卸载 Phase A, 再起模型回退/门禁两个 phase(每个 phase 独立端口 + 独立假 ctx)
  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 200))

  /** 起一个独立 phase: 返回调用器(自带 initialize) */
  async function startPhase(port2, ctx2, config) {
    await apply(ctx2, { port: port2, host: '127.0.0.1', ...config })
    await new Promise((r) => setTimeout(r, 200))
    const base = `http://127.0.0.1:${port2}/mcp`
    const post = async (sessionId, body) => {
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify(body),
      })
      return { sid: res.headers.get('mcp-session-id') ?? sessionId, status: res.status, text: await res.text() }
    }
    const init2 = await post(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-phase', version: '1.0' } } })
    await post(init2.sid, { jsonrpc: '2.0', method: 'notifications/initialized' })
    let n = 100
    return { sid: init2.sid, call: (toolName, args) => post(init2.sid, { jsonrpc: '2.0', id: n++, method: 'tools/call', params: { name: toolName, arguments: args } }) }
  }

  // ── Phase C: 没有 sessionController(headless 类部署)——目录回退 llm, 覆盖仍可用, select_model 明确报不可用 ──
  const phaseC = await startPhase(8096, makeCtx({ llm: fakeLlm }), {})
  const mlC = innerOf(await phaseC.call('model_list', {}))
  checks['model_list 回退 llm.listProviders/listModels'] = mlC.source === 'llm'
    && mlC.providers?.length === 2 && mlC.providers.find((p) => p.id === 'p1')?.models?.[0]?.id === 'm1'
  checks['model_list 回退口径: 单 provider 失败被隔离'] = mlC.failures?.some((f) => f.id === 'p2')
    && mlC.providers.find((p) => p.id === 'p2')?.models.length === 0
  checks['model_list 回退口径仍报缺省选择'] = mlC.default?.provider === 'p1' && mlC.default?.model === 'm1'

  const overrideNoSc = await phaseC.call('agent_run', { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' })
  checks['无 sessionController 时按调用覆盖模型仍可用'] = innerOf(overrideNoSc).model?.model === 'm9'

  const selNoSc = innerOf(await phaseC.call('select_model', { sessionId: 'sess-live', provider: 'p2', model: 'm9' }))
  checks['无 sessionController 时 select_model 明确报不可用'] = String(selNoSc.error ?? '').includes('sessionController service unavailable')

  // Phase C 的假 ctx 没有 sessionTitle 服务: rename_session 明确报不可用
  const renameNoSc = innerOf(await phaseC.call('rename_session', { sessionId: 'sess-live', title: 'x' }))
  checks['无 sessionTitle 时 rename_session 明确报不可用'] = String(renameNoSc.error ?? '').includes('sessionTitle service unavailable')

  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 200))

  // ── Phase D: allowModelOverride:false —— 部署锁死模型, 覆盖被明确拒绝, 不覆盖仍可用 ──
  const phaseD = await startPhase(8095, makeCtx({ sessionController: fakeSessionController, llm: fakeLlm }), { allowModelOverride: false })
  const mlD = innerOf(await phaseD.call('model_list', {}))
  checks['allowModelOverride:false 在 model_list 里可见'] = mlD.config?.allowModelOverride === false

  const deniedRun = innerOf(await phaseD.call('agent_run', { task: 'say ok', cwd: FAKE_CWD, provider: 'p2', model: 'm9' }))
  checks['allowModelOverride:false 时按调用选模型被拒'] = String(deniedRun.error ?? '').includes('allowModelOverride')

  const deniedSelResp = await phaseD.call('select_model', { sessionId: 'sess-live', provider: 'p2', model: 'm9' })
  const deniedSel = innerOf(deniedSelResp)
  checks['allowModelOverride:false 时 select_model 被拒'] = String(deniedSel.error ?? '').includes('allowModelOverride')
  checks['被拒结果带 isError 标记(select_model)'] = parsePayload(deniedSelResp.text).result?.isError === true

  const allowedRun = innerOf(await phaseD.call('agent_run', { task: 'say ok', cwd: FAKE_CWD }))
  checks['allowModelOverride:false 不影响不带覆盖的调用'] = Boolean(allowedRun.sessionId) && !allowedRun.error
    && allowedRun.error === undefined // 空 error 字段直接省略(不再是空串)

  // ── Phase E: 会话空闲 TTL GC —— 超时无活动的会话被服务端关闭, 旧 sid 得 404, 重新 initialize 即可恢复 ──
  const phaseE = await startPhase(8094, makeCtx({ llm: fakeLlm }), { sessionTtlMs: 400 })
  const inTtl = await phaseE.call('model_list', {})
  checks['TTL: 会话在 TTL 内可用'] = inTtl.status === 200
  // sweeper 间隔 = min(60s, ttl/2) = 200ms; 等 1.3s 确保 400ms 空闲的会话被清扫
  await new Promise((r) => setTimeout(r, 1300))
  const stale = await phaseE.call('echo', { text: 'after-ttl' })
  checks['TTL: 空闲超时会话被关闭(旧 sid 404)'] = stale.status === 404
  const reInit = await fetch('http://127.0.0.1:8094/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-ttl', version: '1.0' } } }),
  })
  checks['TTL: 客户端可重新 initialize 建新会话'] = reInit.status === 200 && Boolean(reInit.headers.get('mcp-session-id'))
  await reInit.text()

  // ── Phase F: taskTimeoutMs 自动超时 —— turn 超时以 hook 原因走官方 cancel, error 注明 timed out ──
  const phaseF = await startPhase(8093, makeCtx({ llm: fakeLlm }), { taskTimeoutMs: 300 })
  const timeoutRun = innerOf(await phaseF.call('agent_run', { task: 'long job', sessionId: 'sess-slow' }))
  checks['taskTimeoutMs: 超时结果 error 注明 timed out'] = String(timeoutRun.error ?? '').includes('timed out after 300ms')
  checks['taskTimeoutMs: 以 hook 原因触发官方 agent.cancel'] = slowLiveAgent.cancelCalls.at(-1)?.kind === 'hook'
    && String(slowLiveAgent.cancelCalls.at(-1)?.reason ?? '').includes('task timeout')
  // 不带超时的正常 agent_run 不受影响(phaseF 默认任务走快 agent)
  const normalRun = innerOf(await phaseF.call('agent_run', { task: 'quick job' }))
  checks['taskTimeoutMs: 不影响正常完成的任务'] = Boolean(normalRun.sessionId) && !normalRun.error

  // ── Phase G: 队列持久化(queuePersistPath) —— 重启后 done 结果仍可取回 / running 标记被打断 / queued 重新执行 ──
  {
    const persistPath = resolve(FAKE_CWD, '.smoke-queue.json')
    try { unlinkSync(persistPath) } catch { /* 首次不存在 */ }
    const ctxG = makeCtx({ llm: fakeLlm })
    const phaseG = await startPhase(8092, ctxG, { queuePersistPath: persistPath })
    const gA = innerOf(await phaseG.call('task_inbox', { task: 'slow A', cwd: slowCwd }))
    const gB = innerOf(await phaseG.call('task_inbox', { task: 'slow B', cwd: slowCwd }))
    const gC = innerOf(await phaseG.call('task_inbox', { task: 'quick', cwd: FAKE_CWD }))
    await new Promise((r) => setTimeout(r, 400)) // A running(慢), B queued(锁内), C done → 全部落盘
    // 重启: 卸载(关 server + 清内存队列) → 同配置重新 apply(恢复快照)
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 300))
    const phaseG2 = await startPhase(8092, ctxG, { queuePersistPath: persistPath })
    const resC = innerOf(await phaseG2.call('task_result', { taskId: gC.taskId }))
    checks['队列持久化: done 结果重启后仍可取回'] = resC.taskId === gC.taskId && resC.changes === 'c1'
    const resA = innerOf(await phaseG2.call('task_result', { taskId: gA.taskId }))
    checks['队列持久化: running 重启后如实标记 interrupted'] = String(resA.error ?? '').includes('"status":"error"')
      && String(resA.error ?? '').includes('interrupted')
    const gList = innerOf(await phaseG2.call('task_list', { status: 'running' }))
    const gBItem = Array.isArray(gList) ? gList.find((t) => t.taskId === gB.taskId) : undefined
    checks['队列持久化: queued 重启后重新执行'] = gBItem?.status === 'running'
    const gCancel = innerOf(await phaseG2.call('task_cancel', { taskId: gB.taskId }))
    checks['队列持久化: 重启后的任务可取消'] = gCancel.cancelled === true
    await new Promise((r) => setTimeout(r, 200))
    try { unlinkSync(persistPath) } catch { /* 已清理 */ }
  }

  // ── Phase H: 进度通知 —— agent_run 带 _meta.progressToken 时, SSE 流上应先收到 notifications/progress 心跳 ──
  {
    const ctxH = makeCtx({ llm: fakeLlm })
    const PORT_H = 8091
    await apply(ctxH, { port: PORT_H, host: '127.0.0.1', progressIntervalMs: 300 })
    await new Promise((r) => setTimeout(r, 200))
    const baseH = `http://127.0.0.1:${PORT_H}/mcp`
    const postH = async (sessionId, body) => {
      const res = await fetch(baseH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
        body: JSON.stringify(body),
      })
      return { sid: res.headers.get('mcp-session-id') ?? sessionId, res }
    }
    const initH = await postH(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-progress', version: '1.0' } } })
    await initH.res.text()
    const sidH = initH.sid
    await postH(sidH, { jsonrpc: '2.0', method: 'notifications/initialized' })

    // 长任务 + progressToken: for-await 增量读 SSE 流, 收集响应前到达的心跳
    const ac = new AbortController()
    const runId = 200
    const res = await fetch(baseH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sidH },
      body: JSON.stringify({ jsonrpc: '2.0', id: runId, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'long job', sessionId: 'sess-slow' }, _meta: { progressToken: 'tok-progress' } } }),
      signal: ac.signal,
    })
    let buf = ''
    const decoderH = new TextDecoder()
    const deadline = Date.now() + 1500
    try {
      for await (const chunk of res.body) {
        buf += decoderH.decode(chunk, { stream: true })
        if (Date.now() > deadline) break
      }
    } catch { /* 下方 abort 导致的流中断 */ }
    await postH(sidH, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: runId } })
    ac.abort()
    const msgs = buf.split('\n')
      .filter((l) => l.startsWith('data: '))
      .map((l) => { try { return JSON.parse(l.slice(6)) } catch { return null } })
      .filter(Boolean)
    const progresses = msgs.filter((m) => m.method === 'notifications/progress' && m.params?.progressToken === 'tok-progress')
    checks['进度通知: turn 期间在 SSE 流上收到 progress 心跳'] = progresses.length >= 2
    checks['进度通知: progress 单调递增且带 message'] = progresses.every((p, i) => i === 0 || p.params.progress > progresses[i - 1].params.progress)
      && progresses.every((p) => typeof p.params.message === 'string' && p.params.message.includes('session events'))
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase I: 并发压力 —— 不同 cwd 并行执行 / 同 cwd 串行复用同一会话 ──
  {
    const ctxI = makeCtx({ llm: fakeLlm })
    const phaseI = await startPhase(8089, ctxI, {})
    const concCwds = [1, 2, 3, 4, 5, 6].map((n) => resolve(FAKE_CWD, `conc-${n}`))
    const concRuns = await Promise.all(concCwds.map((c, i) => phaseI.call('agent_run', { task: `t${i}`, cwd: c })))
    checks['并发: 6 个不同 cwd 的任务全部成功'] = concRuns.every((r) => Boolean(innerOf(r).sessionId))
    const sameCwd = resolve(FAKE_CWD, 'conc-same')
    const sameRuns = await Promise.all([1, 2, 3].map((i) => phaseI.call('agent_run', { task: `s${i}`, cwd: sameCwd })))
    const sameIds = new Set(sameRuns.map((r) => innerOf(r).sessionId))
    checks['并发: 同 cwd 三任务串行复用同一会话'] = sameIds.size === 1 && Boolean([...sameIds][0])
    const listDuring = await phaseI.call('task_list', {})
    checks['并发: 混合查询不受影响'] = listDuring.status === 200
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase K: LRU 淘汰跳过活跃会话 —— maxAgents:1 时, 忙会话不被淘汰 dispose, 空闲会话才被逐出 ──
  {
    const ctxK = makeCtx({ llm: fakeLlm })
    const PORT_K = 8087
    await apply(ctxK, { port: PORT_K, host: '127.0.0.1', maxAgents: 1 })
    await new Promise((r) => setTimeout(r, 200))
    const baseK = `http://127.0.0.1:${PORT_K}/mcp`
    const postK = async (sessionId, body) => {
      const res = await fetch(baseK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}) },
        body: JSON.stringify(body),
      })
      return { sid: res.headers.get('mcp-session-id') ?? sessionId, res }
    }
    const initK = await postK(undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke-lru', version: '1.0' } } })
    await initK.res.text()
    const sidK = initK.sid
    await postK(sidK, { jsonrpc: '2.0', method: 'notifications/initialized' })

    const cwdA = resolve(FAKE_CWD, 'slow-cwd-evict-A')
    const cwdB = resolve(FAKE_CWD, 'slow-cwd-evict-B')
    const acA = new AbortController()
    const acB = new AbortController()
    const acC = new AbortController()
    const callNoWait = (id, name, args, ac) => {
      const p = fetch(baseK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Mcp-Session-Id': sidK },
        body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
        signal: ac.signal,
      }).then((r) => r.text()).catch(() => 'aborted')
      return p
    }

    const runA = callNoWait(80, 'agent_run', { task: 'hold A', cwd: cwdA }, acA)
    await new Promise((r) => setTimeout(r, 250)) // A 进入活跃标记
    const runB = callNoWait(81, 'agent_run', { task: 'hold B', cwd: cwdB }, acB) // 触发淘汰: A 忙 → 跳过, 池超限建 B
    await new Promise((r) => setTimeout(r, 250))
    const idA = created.find((c) => c.cwd === cwdA)?.id
    const idB = created.find((c) => c.cwd === cwdB)?.id
    console.error('[dbg K] idA=', idA, 'idB=', idB, 'disposed=', JSON.stringify(disposed))
    checks['LRU: 满池时跳过活跃会话(新建不 dispose A)'] = Boolean(idA && idB) && !disposed.includes(idA)

    // 取消 A → 收敛; C 到来时 A 空闲 → 被 LRU 正常淘汰 dispose
    await postK(sidK, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 80 } })
    await new Promise((r) => setTimeout(r, 300))
    const runC = callNoWait(82, 'agent_run', { task: 'quick C', cwd: resolve(FAKE_CWD, 'evict-C') }, acC)
    await new Promise((r) => setTimeout(r, 400))
    checks['LRU: 空闲会话被正常淘汰 dispose'] = disposed.includes(idA)
    acA.abort()
    acB.abort()
    acC.abort()
    await Promise.allSettled([runA, runB, runC])
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase L: 旧宿主 keys() 回退 —— dsh_list_tools 无 schemas() 时退回 keys() ──
  {
    const legacyCtx = makeCtx({ llm: fakeLlm, tools: { keys: () => ['bash', 'read'] } })
    const phaseL = await startPhase(8086, legacyCtx, {})
    const ltLegacy = innerOf(await phaseL.call('dsh_list_tools', {}))
    checks['dsh_list_tools: 旧宿主 keys() 回退'] = Array.isArray(ltLegacy) && ltLegacy.some((t) => t.name === 'bash' && t.description === '')
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  // ── Phase J: GUI 控制面路由 —— status 快照 / stop-start 同源门禁 / 软停启循环 ──
  {
    const { EventEmitter } = await import('node:events')
    const ctxJ = makeCtx({ llm: fakeLlm })
    const gui = ctxJ.__webHandlers
    await apply(ctxJ, { port: 8088, host: '127.0.0.1' })
    const handler = gui.get('gui')
    const callGui = (route, { httpMethod = 'GET', headers = {} } = {}) => {
      const req = new EventEmitter()
      Object.assign(req, { method: httpMethod, url: `/_dsh/dsh-ops-mcp/${route}`, headers })
      const res = {
        status: 0, headers: {}, body: '',
        writeHead(code, h) { this.status = code; Object.assign(this.headers, h || {}) },
        end(b) { this.body = String(b ?? '') },
      }
      const done = handler(req, res)
      setImmediate(() => req.emit('end')) // 消费 POST body 流(GET 无监听者, no-op)
      return done.then(() => res)
    }
    const st = await callGui('status')
    const stBody = st.status === 200 ? JSON.parse(st.body) : {}
    checks['GUI 路由: status 快照(版本/监听/配置)'] = st.status === 200 && typeof stBody.version === 'string'
      && typeof stBody.listening === 'boolean' && typeof stBody.config?.sessionTtlMs === 'number'
      && stBody.stats?.connections === 0 && Array.isArray(stBody.connections)
    const stopCross = await callGui('stop', { httpMethod: 'POST' })
    checks['GUI 路由: 无同源标识的 stop 被 403(CSRF 门禁)'] = stopCross.status === 403
    const stopOk = await callGui('stop', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    checks['GUI 路由: 同源 stop 成功'] = stopOk.status === 200 && JSON.parse(stopOk.body).stopped === true
    const st2 = await callGui('status')
    checks['GUI 路由: stop 后 listening=false'] = JSON.parse(st2.body).listening === false
    const startOk = await callGui('start', { httpMethod: 'POST', headers: { 'sec-fetch-site': 'same-origin' } })
    checks['GUI 路由: 同源 start 重新监听'] = startOk.status === 200 && JSON.parse(startOk.body).started === true
    const st3 = await callGui('status')
    checks['GUI 路由: start 后 listening=true'] = JSON.parse(st3.body).listening === true
    for (const d of disposers.splice(0)) if (typeof d === 'function') d()
    await new Promise((r) => setTimeout(r, 150))
  }

  const failed = Object.entries(checks).filter(([, ok]) => !ok)
  for (const [checkName, ok] of Object.entries(checks)) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${checkName}`)
  console.log('attach_session 路径记录:', JSON.stringify(attachedIds))
  console.log('mount 记录:', JSON.stringify(mounted))
  console.log(failed.length === 0 ? 'SMOKE PASS' : `SMOKE FAIL (${failed.length} 项)`)
  for (const d of disposers.splice(0)) if (typeof d === 'function') d()
  await new Promise((r) => setTimeout(r, 100))
  process.exit(failed.length === 0 ? 0 : 1)
} catch (e) {
  console.error('SMOKE ERROR:', e)
  process.exit(1)
}
