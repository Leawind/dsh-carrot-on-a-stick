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
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { apply } from './lib/index.js'

const attachedIds = []
const created = []
const resumed = []
const disposed = []
const flushed = []
const mounted = []
const disposers = []

// smoke 文件所在目录的 realpath(win32 反斜杠规范路径) —— 与 workspace.path / fs.realpath 结果同 canon
const FAKE_CWD = realpathSync(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))

const fakeWs = {
  id: 'ws-fake',
  title: 'fake',
  path: FAKE_CWD,
  sessionIds: [],
  attachSession: async (id) => { attachedIds.push(id) },
}
const wsRegistry = {
  list: () => [fakeWs],
  resolveByPath: async (p) => (p === FAKE_CWD ? fakeWs : undefined),
  create: async () => fakeWs,
}

function makeAgent(id, cwd) {
  const events = []
  return {
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

const liveAgent = makeAgent('sess-live', FAKE_CWD)
const liveSession2 = { id: 'sess-live2', header: { version: 0, id: 'sess-live2', createdAt: 1, cwd: FAKE_CWD } }

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
  list: () => [liveSession2],
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

const ctx = {
  tools: fakeTools,
  llm: {},
  agents: {
    get: (id) => (id === 'sess-live' ? liveAgent : id === 'sess-err' ? errAgent : undefined),
    create: async ({ sessionId, meta, agentOptions, setup }) => {
      const id = String(sessionId)
      created.push({ id, cwd: meta?.cwd, agentOptions })
      const agent = makeAgent(id, meta?.cwd)
      if (setup) await setup({}, agent)
      return { agent, dispose: async () => { disposed.push(id) } }
    },
    resume: async ({ resumeSessionId, agentOptions, setup }) => {
      const id = String(resumeSessionId)
      if (id !== 'sess-persisted') throw new Error(`no persisted session "${id}"`)
      resumed.push({ id, agentOptions })
      const agent = makeAgent(id, FAKE_CWD)
      if (setup) await setup({}, agent)
      return { agent, dispose: async () => { disposed.push(id) } }
    },
  },
  agentPresets: { mount: async (agentCtx, id) => { mounted.push(id ?? 'standard'); return { id: id ?? 'standard' } } },
  sessions: fakeSessions,
  sessionPersistence: fakePersistence,
  workspaceRegistry: wsRegistry,
  effect: (fn) => { const d = fn(); disposers.push(d); return d },
  get: (name) => (name === 'workspaceRegistry' ? wsRegistry
    : name === 'sessions' ? fakeSessions
      : name === 'sessionPersistence' ? fakePersistence
        : name === 'tools' ? fakeTools
          : name === 'agentDefaultModel' ? { currentSelection: () => ({ provider: 'p1', model: 'm1' }) }
            : undefined),
}

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

  // ── dsh_list_tools 走 schemas() ──
  const listTools = await rpc(init.sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_list_tools', arguments: {} } })
  const listToolsInner = listTools.status === 200 ? innerOf(listTools) : { error: 'bad' }
  checks['dsh_list_tools 经 schemas() 返回 name+description'] = Array.isArray(listToolsInner)
    && listToolsInner.some((t) => t.name === 'bash' && t.description === 'run a shell command')

  // ── attach_session 工具(live / 持久化快照 / 旧版裸 header / 未知 四态) ──
  const attachLive = await rpc(init.sid, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-live' } } })
  checks['attach_session live 会话'] = attachLive.status === 200 && innerOf(attachLive).attached === true

  const attachMissing = await rpc(init.sid, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-nope' } } })
  checks['attach_session 未知会话报错'] = attachMissing.status === 200 && typeof innerOf(attachMissing).error === 'string'

  const attachPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-persisted' } } })
  checks['attach_session 持久化会话(.header 快照)'] = attachPersisted.status === 200 && innerOf(attachPersisted).attached === true

  const attachLegacy = await rpc(init.sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'attach_session', arguments: { sessionId: 'sess-legacy' } } })
  checks['attach_session 旧版裸 header 形状'] = attachLegacy.status === 200 && innerOf(attachLegacy).attached === true

  // ── 任意会话续接三级 ──
  const runLive = await rpc(init.sid, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-live' } } })
  const runLiveInner = runLive.status === 200 ? innerOf(runLive) : { error: 'bad' }
  checks['agent_run 接管 live 会话(不 resume 不 dispose)'] = runLiveInner.sessionId === 'sess-live' && resumed.length === 0 && disposed.length === 0

  const runPersisted = await rpc(init.sid, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-persisted' } } })
  const runPersistedInner = runPersisted.status === 200 ? innerOf(runPersisted) : { error: 'bad' }
  checks['agent_run 持久化会话 resume + flush + dispose'] = runPersistedInner.sessionId === 'sess-persisted'
    && resumed.some((r) => r.id === 'sess-persisted') && flushed.includes('sess-persisted') && disposed.includes('sess-persisted')
  checks['resume 也带完整模型选择(agentDefaultModel 补全)'] = resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.provider === 'p1'
    && resumed.find((r) => r.id === 'sess-persisted')?.agentOptions?.model === 'm1'

  const runUnknown = await rpc(init.sid, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'say ok', sessionId: 'sess-unknown' } } })
  checks['agent_run 未知会话明确报错'] = runUnknown.status === 200 && String(innerOf(runUnknown).error ?? '').includes('session not found for resume')

  // 失败透出: turn/end error 进 result.error(E2E 发现的静默空结果缺陷)
  const runErr = await rpc(init.sid, { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'agent_run', arguments: { task: 'boom', sessionId: 'sess-err' } } })
  const runErrInner = runErr.status === 200 ? innerOf(runErr) : { error: 'bad' }
  checks['agent_run 失败透出(turn/end error)'] = String(runErrInner.error ?? '').includes('AUTH') && String(runErrInner.error ?? '').includes('invalid api key')

  // 事件读取走 snapshotEvents + 结构化解析
  checks['结构化解析(toolCalls/changes/verification)'] = runPersistedInner.toolCalls?.length === 1
    && runPersistedInner.toolCalls[0].name === 'bash'
    && runPersistedInner.changes === 'c1' && runPersistedInner.verification === 'v1' && runPersistedInner.leftovers === 'l1'

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

  const strayPath = await rawRequest(PORT_A, { path: '/other', headers: { Authorization: 'Bearer sekrit-token', Host: '127.0.0.1' } })
  checks['路径门禁: 非 /mcp 路径 404'] = strayPath.status === 404

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
