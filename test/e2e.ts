// E2E verification against a REAL dsh host (not shipped; dev-only).
// Zero-token phase: initialize(capabilities)/tools/list/echo/dsh_list_tools/model_list/
// task_list/task_cancel wiring/session_list/select_model wiring + resources face
// (resources/list, dsh://presets|agents|models|status/stats read, completion, subscribe rejection).
// Agent phase (E2E_WITH_AGENT=1): the resource-path round trip — task_inbox → subscribe
// dsh://queue/{taskId} → completion arrives as notifications/resources/updated (no polling) →
// read the task resource for the full result (preset toolCalls, summary contract) →
// session history resource. One real turn total.
//
// Usage: E2E_MCP_URL=http://127.0.0.1:8090/mcp [E2E_WITH_AGENT=1] node e2e.ts
// E2E_MODEL_LIST=0 skips the read-only model_catalog legs (host model adapters can be slow cold).
const BASE = process.env.E2E_MCP_URL ?? 'http://127.0.0.1:8090/mcp'
const WITH_AGENT = process.env.E2E_WITH_AGENT === '1'
const CWD = process.env.E2E_CWD ?? process.cwd()
const AGENT_TIMEOUT_MS = Number(process.env.E2E_AGENT_TIMEOUT_MS ?? 180_000)

async function rpc(sessionId, body) {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  })
  const sid = res.headers.get('mcp-session-id') ?? sessionId
  const text = await res.text()
  return { sid, status: res.status, text }
}

/** 打开该会话的 GET SSE 流(StreamableHTTP 服务端→客户端通知通道), 收集 JSON-RPC 消息 */
function openSse(sessionId) {
  const events = []
  const controller = new AbortController()
  const ready = (async () => {
    const res = await fetch(BASE, {
      method: 'GET',
      headers: { Accept: 'text/event-stream', 'Mcp-Session-Id': sessionId },
      signal: controller.signal,
    })
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    ;(async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          for (const line of decoder.decode(value, { stream: true }).split('\n')) {
            const t = line.trim()
            if (t.startsWith('data: ')) {
              try { events.push(JSON.parse(t.slice(6))) } catch { /* 心跳注释等 */ }
            }
          }
        }
      } catch { /* close() 中断: 正常退出 */ }
    })()
  })().catch(() => {})
  return { events, ready, close: () => controller.abort() }
}

function parsePayload(text) {
  // SSE 流里可能先到 notifications/progress 等通知: 响应行带 result/error, 优先取它
  let first
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('data: ')) continue
    const m = JSON.parse(t.slice(6))
    if (m.result !== undefined || m.error !== undefined) return m
    first ??= m
  }
  if (first !== undefined) return first
  return JSON.parse(text)
}

function innerOf(resp) {
  const payload = parsePayload(resp.text)
  if (payload.error) return { error: payload.error.message, raw: payload }
  const r = payload.result
  if (r.isError) return { error: r.content?.[0]?.text ?? 'isError', raw: payload }
  const text = r.content?.[0]?.text
  try { return JSON.parse(text) } catch { return { error: `non-JSON result: ${String(text).slice(0, 200)}`, raw: payload } }
}

/** resources/read 的解析: 出错返回 {error}, 成功返回解析后的 JSON 载荷 */
async function readResource(sid, id, uri) {
  const r = await rpc(sid, { jsonrpc: '2.0', id, method: 'resources/read', params: { uri } })
  if (r.status !== 200) return { error: `HTTP ${r.status}` }
  const p = parsePayload(r.text)
  if (p.error) return { error: String(p.error.message ?? '') }
  const c = p.result?.contents?.[0]
  return c?.text !== undefined ? { mime: c.mimeType, json: JSON.parse(c.text) } : { error: 'no text content' }
}

const findings = []
function report(name, ok, detail = '') {
  findings.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
function finish() {
  const failed = findings.filter((f) => !f.ok)
  console.log(failed.length === 0 ? (WITH_AGENT ? '\nE2E PASS' : '\nE2E PASS (zero-token phase)') : `\nE2E FAIL (${failed.length} 项)`)
  process.exitCode = failed.length === 0 ? 0 : 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

try {
  const init = await rpc(undefined, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } },
  })
  const initPayload = init.status === 200 ? parsePayload(init.text).result : undefined
  report('initialize(MCP 握手)', init.status === 200 && Boolean(init.sid), `server=${initPayload?.serverInfo?.name ?? '?'}`)
  report('initialize 携带 server instructions(工作流引导)', typeof initPayload?.instructions === 'string'
    && initPayload.instructions.length > 200 && initPayload.instructions.includes('dsh_get_started'),
    `${typeof initPayload?.instructions === 'string' ? initPayload.instructions.length : 0} chars`)
  report('initialize 声明 resources 能力(listChanged+subscribe)', initPayload?.capabilities?.resources?.listChanged === true
    && initPayload?.capabilities?.resources?.subscribe === true)
  const sid = init.sid
  await rpc(sid, { jsonrpc: '2.0', method: 'notifications/initialized' })

  const toolsList = await rpc(sid, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  const names = parsePayload(toolsList.text).result?.tools?.map((t) => t.name) ?? []
  const expected = ['echo', 'dsh_list_tools', 'dsh_status', 'workspace_list', 'model_list', 'agent_run', 'agent_steer', 'task_inbox', 'task_result', 'task_list', 'task_cancel', 'session_list', 'session_history', 'select_model', 'attach_session', 'rename_session', 'dsh_get_started']
  report('tools/list 十七工具齐(含 dsh_status/agent_steer/dsh_get_started)', expected.every((n) => names.includes(n)), names.join(','))

  const guide = await rpc(sid, { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'dsh_get_started', arguments: { section: 'errors' } } })
  const guideText = guide.status === 200 ? (parsePayload(guide.text).result?.content?.[0]?.text ?? '') : ''
  report('dsh_get_started(section=errors) 返回替代路径对照', guideText.includes('Error → alternative path') && guideText.includes('agent_run'),
    `${guideText.length} chars`)

  const echo = await rpc(sid, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'echo', arguments: { text: 'e2e-ping' } } })
  report('echo 往返', echo.status === 200 && echo.text.includes('e2e-ping'))

  // ── 资源面(零 token): 全量静态清单 + 关键读 + completion + 订阅拒绝语义 ──
  const resList = await rpc(sid, { jsonrpc: '2.0', id: 20, method: 'resources/list', params: {} })
  const resUris = resList.status === 200 ? (parsePayload(resList.text).result?.resources ?? []).map((r) => r.uri) : []
  report('resources/list 静态资源全集', ['dsh://status', 'dsh://status/config', 'dsh://status/stats', 'dsh://status/connections',
    'dsh://guide', 'dsh://guide/errors', 'dsh://tools', 'dsh://models', 'dsh://presets', 'dsh://workspaces',
    'dsh://sessions', 'dsh://queue', 'dsh://agents'].every((u) => resUris.includes(u)),
    `${resUris.length} 个静态资源`)
  const tmplList = await rpc(sid, { jsonrpc: '2.0', id: 21, method: 'resources/templates/list', params: {} })
  const tmplUris = tmplList.status === 200 ? (parsePayload(tmplList.text).result?.resourceTemplates ?? []).map((t) => t.uriTemplate) : []
  report('resources/templates/list 模板全集', ['dsh://queue/{taskId}', 'dsh://sessions/{sessionId}', 'dsh://sessions/{sessionId}/history',
    'dsh://sessions/{sessionId}/history/{before}', 'dsh://sessions/{sessionId}/events/{after}', 'dsh://sessions/{sessionId}/activity',
    'dsh://models/{provider}', 'dsh://workspaces/{id}'].every((u) => tmplUris.includes(u)),
    `${tmplUris.length} 个模板`)
  const rStats = await readResource(sid, 22, 'dsh://status/stats')
  report('resources/read dsh://status/stats', rStats.json?.listening === true && typeof rStats.json?.uptimeMs === 'number',
    `uptime=${Math.round((rStats.json?.uptimeMs ?? 0) / 1000)}s`)
  const rPresets = await readResource(sid, 23, 'dsh://presets')
  report('resources/read dsh://presets(preset 花名册)', !rPresets.error && Number.isInteger(rPresets.json?.total),
    rPresets.error ? String(rPresets.error).slice(0, 120) : `total=${rPresets.json?.total}: ${(rPresets.json?.presets ?? []).map((p) => p.id).join(',')}`)
  const rAgents = await readResource(sid, 24, 'dsh://agents')
  report('resources/read dsh://agents(常驻池明细)', !rAgents.error && Array.isArray(rAgents.json?.agents),
    rAgents.error ? String(rAgents.error).slice(0, 120) : `pool=${rAgents.json?.total}`)
  const rSessions = await readResource(sid, 25, 'dsh://sessions')
  report('resources/read dsh://sessions(会话清单)', !rSessions.error && Number.isInteger(rSessions.json?.total),
    rSessions.error ? String(rSessions.error).slice(0, 120) : `total=${rSessions.json?.total}`)
  const rNope = await readResource(sid, 26, 'dsh://no-such-resource')
  report('resources/read 未知资源 → -32602 not found', String(rNope.error ?? '').includes('not found'),
    String(rNope.error ?? '').slice(0, 100))
  const subNope = await rpc(sid, { jsonrpc: '2.0', id: 27, method: 'resources/subscribe', params: { uri: 'dsh://queue/e2e-nonexistent' } })
  report('resources/subscribe 不可读目标 → -32602', String(parsePayload(subNope.text).error?.message ?? '').includes('task not found'),
    String(parsePayload(subNope.text).error?.message ?? '').slice(0, 100))
  if (process.env.E2E_MODEL_LIST !== '0') {
    const complete = await rpc(sid, {
      jsonrpc: '2.0', id: 28, method: 'completion/complete',
      params: { ref: { type: 'ref/resource', uri: 'dsh://models/{provider}' }, argument: { name: 'provider', value: '' } },
    })
    const values = complete.status === 200 ? (parsePayload(complete.text).result?.completion?.values ?? []) : []
    report('completion/complete provider 补全', Array.isArray(values) && values.length > 0, values.join(','))
  }

  const listTools = await rpc(sid, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dsh_list_tools', arguments: {} } })
  const lt = innerOf(listTools)
  report('dsh_list_tools 返回全局注册表(source/note/tools)', lt?.source === 'global-registry'
    && typeof lt?.note === 'string' && Array.isArray(lt?.tools),
    Array.isArray(lt?.tools)
      ? `${lt.tools.length} 个全局工具: ${lt.tools.slice(0, 8).map((t) => t.name).join(',')}${lt.tools.length > 8 ? '…' : ''}; note=${String(lt.note).slice(0, 60)}`
      : String(lt.error).slice(0, 120))

  // ── model_list(只读): 真机模型目录 ──
  if (process.env.E2E_MODEL_LIST !== '0') {
    const mlT0 = Date.now()
    const modelList = await rpc(sid, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'model_list', arguments: {} } })
    const ml = innerOf(modelList)
    const secs = ((Date.now() - mlT0) / 1000).toFixed(1)
    const modelCount = (ml.providers ?? []).reduce((n, p) => n + (p.models?.length ?? 0), 0)
    report('model_list 返回目录', !ml.error && Array.isArray(ml.providers), ml.error
      ? String(ml.error).slice(0, 160)
      : `${secs}s source=${ml.source} providers=${ml.providers.length} models=${modelCount} default=${JSON.stringify(ml.default)}`)
    report('model_list 报出可用模型 id', modelCount > 0 || (ml.failures?.length ?? 0) > 0,
      modelCount > 0
        ? (ml.providers.flatMap((p) => (p.models ?? []).map((m) => `${p.id}/${m.id}`)).slice(0, 6).join(', '))
        : `failures=${JSON.stringify(ml.failures ?? []).slice(0, 160)}`)
    report('model_list 报出插件模型配置与覆盖开关', typeof ml.config?.allowModelOverride === 'boolean',
      `config=${JSON.stringify(ml.config ?? null)}`)
  }

  // ── select_model 接线(只读式探针): 用一个不存在的会话 id, 期望宿主拒绝而不是"服务不可用" ──
  const probe = await rpc(sid, {
    jsonrpc: '2.0', id: 6, method: 'tools/call',
    params: { name: 'select_model', arguments: { sessionId: 'e2e-nonexistent-session', provider: 'x', model: 'y' } },
  })
  const probeInner = innerOf(probe)
  const probeErr = String(probeInner.error ?? '')
  report('select_model 已接上官方 sessionController(不存在会话被拒)', probeInner.ok !== true && probeErr !== ''
    && !probeErr.includes('sessionController service unavailable'),
  probeErr.slice(0, 160))

  // ── 队列/会话查询面(只读) + task_cancel 接线探针 ──
  const taskList = await rpc(sid, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'task_list', arguments: {} } })
  const tl = innerOf(taskList)
  // 结构化输出约定: task_list 包成 { tasks: [...] }(与 dsh://queue 资源同源)
  const tasks = tl?.tasks
  report('task_list 返回 { tasks: [...] }', Array.isArray(tasks), Array.isArray(tasks) ? `${tasks.length} 个任务` : String(tl.error).slice(0, 120))

  const cancelProbe = await rpc(sid, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'task_cancel', arguments: { taskId: 'e2e-nonexistent-task' } } })
  const cancelPayload = parsePayload(cancelProbe.text).result
  const cancelInner = innerOf(cancelProbe)
  report('task_cancel 未知 taskId 以 isError 拒绝', cancelPayload?.isError === true && String(cancelInner.error ?? '').includes('task not found'),
    String(cancelInner.error ?? '').slice(0, 120))

  const sessionList = await rpc(sid, { jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'session_list', arguments: { limit: 5 } } })
  const sl = innerOf(sessionList)
  report('session_list 返回清单', !sl.error && Number.isInteger(sl.total) && Array.isArray(sl.sessions),
    sl.error ? String(sl.error).slice(0, 120) : `total=${sl.total} 最新: ${sl.sessions.slice(0, 3).map((s) => String(s.sessionId).slice(0, 8)).join(',')}`)

  const histProbe = await rpc(sid, { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'session_history', arguments: { sessionId: 'e2e-nonexistent-session' } } })
  const histPayload = parsePayload(histProbe.text).result
  report('session_history 不存在会话以 isError 拒绝', histPayload?.isError === true,
    String(innerOf(histProbe).error ?? '').slice(0, 120))

  if (!WITH_AGENT) {
    console.log('\n(zero-token phase done; set E2E_WITH_AGENT=1 for the live resource-path agent leg)')
    finish()
  } else {

  // ── agent 阶段(资源路径): task_inbox → 订阅 dsh://queue/{taskId} → 完成推送 → 读资源拿全量结果。
  // 一次真实 turn, 覆盖: preset 挂载(toolCalls)/事件提取/summary 合同/免轮询推送/任务与会话资源读。 ──
  console.log(`\nagent leg (resource path): cwd=${CWD} (timeout ${AGENT_TIMEOUT_MS}ms)`)
  const sse = openSse(sid)
  await sse.ready
  await sleep(200) // 等 SSE 流在传输层就位
  let reqId = 50
  const subscribeRes = async (uri) => {
    const r = await rpc(sid, { jsonrpc: '2.0', id: ++reqId, method: 'resources/subscribe', params: { uri } })
    const p = parsePayload(r.text)
    return p.error ? String(p.error.message ?? '') : ''
  }
  const inbox = await rpc(sid, { jsonrpc: '2.0', id: 30, method: 'tools/call', params: {
    name: 'task_inbox',
    arguments: {
      task: '用一条命令列出当前目录下的文件名(只要文件名, 不要内容), 然后输出总结。',
      cwd: CWD,
      title: 'dsh-carrot-on-a-stick e2e resources',
    },
  } })
  const inboxInner = innerOf(inbox)
  const taskId = String(inboxInner.taskId ?? '')
  report('task_inbox 返回 taskId + 资源引用', taskId !== '' && inboxInner.resource === `dsh://queue/${taskId}`,
    `taskId=${taskId.slice(0, 8)}… resource=${inboxInner.resource ?? '(无)'}`)
  const t0 = Date.now()
  const subErr = await subscribeRes(`dsh://queue/${taskId}`)
  report('resources/subscribe 受理(任务资源)', subErr === '', subErr.slice(0, 120))

  const taskUri = `dsh://queue/${taskId}`
  // 推送语义: 任务的每次状态迁移都推一次 updated(queued→running→session 已认领→终态)。
  // updated 只是"该重读了"的信号, 终态以资源内容为准 → 循环: 等新推送 → 读 → 非终态继续等。
  const deadline = Date.now() + AGENT_TIMEOUT_MS
  const pushCount = () => sse.events.filter((e) => e.method === 'notifications/resources/updated' && e.params?.uri === taskUri).length
  let seen = 0
  let taskJson: any = {}
  let firstPushMs = ''
  while (Date.now() < deadline) {
    let grew = false
    while (pushCount() > seen && Date.now() < deadline) { grew = true; break }
    if (!grew) { await sleep(200); continue }
    seen = pushCount()
    if (firstPushMs === '') firstPushMs = `${((Date.now() - t0) / 1000).toFixed(1)}s`
    const r = await readResource(sid, 31, taskUri)
    taskJson = r.json ?? {}
    if (taskJson.status === 'done' || taskJson.status === 'error' || taskJson.status === 'cancelled') break
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  report('状态迁移推送到达(首次 <2s, 免轮询)', firstPushMs !== '', `first=${firstPushMs}`)
  report('终态推送到达并以资源内容收敛', taskJson.status === 'done', `${secs}s status=${taskJson.status ?? '(timeout)'}`)
  report('任务资源读取: status=done + full 投影结果', taskJson.status === 'done' && taskJson.result?.detail === 'full',
    `status=${taskJson.status} result.detail=${taskJson.result?.detail ?? '(无)'}`)
  report('sessionId 回填且会话资源可读', typeof taskJson.sessionId === 'string' && taskJson.sessionId !== ''
    && (await readResource(sid, 32, `dsh://sessions/${taskJson.sessionId}`)).json?.historyReadable === true,
    String(taskJson.sessionId ?? '').slice(0, 40))
  report('preset 挂载成功(toolCalls 非空)', Array.isArray(taskJson.result?.toolCalls) && taskJson.result.toolCalls.length > 0,
    `calls=${(taskJson.result?.toolCalls ?? []).map((c) => c.name).join(',')}`)
  report('summary 合同(changes/verification)', Boolean(taskJson.result?.changes || taskJson.result?.verification),
    `changes="${String(taskJson.result?.changes ?? '').slice(0, 80)}"`)
  const histRes = await readResource(sid, 33, `dsh://sessions/${taskJson.sessionId}/history`)
  report('会话纪要资源读到真实轮次', !histRes.error && Array.isArray(histRes.json?.turns) && histRes.json.turns.length > 0,
    histRes.error ? String(histRes.error).slice(0, 120)
      : `turns=${histRes.json.turns.length} roles=${histRes.json.turns.map((t) => t.role).join(',')}`)
  report('list_changed 广播到达', sse.events.some((e) => e.method === 'notifications/resources/list_changed'))
  await rpc(sid, { jsonrpc: '2.0', id: ++reqId, method: 'resources/unsubscribe', params: { uri: taskUri } })
  sse.close()
  finish()
  }
} catch (e) {
  console.error('E2E ERROR:', e)
  process.exitCode = 1
}
