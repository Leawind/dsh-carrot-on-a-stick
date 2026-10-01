// Dev-only UI smoke harness: 最小宿主桩, 把 client/client.js 注入的面板真实渲染到浏览器。
// 不依赖 dsh 宿主——stub __ModuleLoader__/slots, mock GUI 路由(status/stop/start), 状态形状与
// src/index.ts 的 statusSnapshot() 逐字段对齐。用法:
//   node test/ui-harness.mjs [--port 8096]   # 打开 http://127.0.0.1:<port>/
// 测试控制面(供自动化驱动, 也可 curl 手动翻转):
//   GET  /__test/state   → mock 状态 + RPC 调用计数 + 面板启动错误
//   POST /__test/mode    → body JSON: { statusError?, listening?, connections? }
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PORT = Number(process.argv.includes('--port') ? process.argv[process.argv.indexOf('--port') + 1] : 8096)

// ── mock 状态(与 statusSnapshot 同形) ──
const startedAt = Date.now()
const now = () => Date.now()
const DEFAULT_CONNS = () => [
  { sessionId: 'b1a2c3d4e5f60718293a4b5c6d7e8f90', userAgent: 'smoke-driver/1.0 (chromium)', connectedAt: now() - 125_000, lastActivity: now() - 4_000, requests: 42 },
  { sessionId: '0f9e8d7c6b5a4321fedcba9876543210', userAgent: 'claude-cli/1.0.33', connectedAt: now() - 60_000, lastActivity: now() - 45_000, requests: 7 },
]
const state = {
  name: 'dsh-carrot-on-a-stick',
  version: '0.1.0',
  listening: true,
  httpEnabled: true,
  endpoint: `http://127.0.0.1:8090/mcp`,
  startedAt,
  config: {
    provider: '(跟随宿主默认)', model: '(跟随宿主默认)', reasoningEffort: '(适配器默认)',
    allowModelOverride: true, preset: 'standard', defaultDetail: 'summary',
    maxAgents: 8, maxQueue: 100, taskTimeoutMs: 0, sessionTtlMs: 86400000,
    queuePersist: false, queuePersistEncrypted: false, authEnabled: false, workspaceRoots: undefined,
  },
  connections: DEFAULT_CONNS(),
}
const rpcCounts = { status: 0, stop: 0, start: 0 }
const boot = { errors: [] }
const mode = { statusError: false, actionDelayMs: 0 }

function snapshot() {
  let queueActive = 1, queueDone = 3, queueError = 1, queueCancelled = 1
  return {
    ...state,
    uptimeMs: now() - startedAt,
    stats: {
      liveAgents: 2,
      queue: { active: queueActive, done: queueDone, error: queueError, cancelled: queueCancelled },
      connections: state.connections.length,
      subscriptions: { connections: state.connections.length, subscriptions: 3 },
    },
    connections: state.connections.map((c) => ({ ...c })),
  }
}

function json(res, code, body) {
  const raw = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(raw) })
  res.end(raw)
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}

const PAGE = `<!doctype html>
<html lang="zh">
<head><meta charset="utf-8"><title>dsh-carrot-on-a-stick UI smoke harness</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;background:#fafafa;color:#222}</style>
</head>
<body>
<div id="root"></div>
<script src="/vendor/react.js"><\/script>
<script src="/vendor/react-dom.js"><\/script>
<script>
window.__boot = { errors: [], registered: [], applied: false };
window.__ModuleLoader__ = {
  load: function (_spec) {
    try {
      var module = _spec.factory(function (name) {
        if (name === 'react') return window.React;
        throw new Error('harness require: unknown module ' + name);
      });
      window.__boot.registered.push(_spec.id);
      var slots = {
        inject: function (_name, setup) { setup(); },
        register: function (meta, render) {
          window.__boot.registered.push('slot:' + meta.id);
          window.__boot.render = render;
          renderPanel();
          return function () {};
        },
      };
      var ctx = { get: function (name) { return name === 'slots' ? slots : undefined; } };
      Promise.resolve(module.apply(ctx)).then(
        function () { window.__boot.applied = true; },
        function (e) { window.__boot.errors.push(String(e && e.message || e)); });
    } catch (e) { window.__boot.errors.push(String(e && e.message || e)); }
  },
};
function renderPanel() {
  try {
    var el = window.__boot.render();
    window.__root = ReactDOM.createRoot(document.getElementById('root'));
    window.__root.render(el);
  } catch (e) { window.__boot.errors.push(String(e && e.message || e)); }
}
<\/script>
<script src="/client.js"><\/script>
</body>
</html>`

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const raw = PAGE
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(raw)
    }
    if (req.method === 'GET' && url.pathname === '/client.js') {
      const raw = readFileSync(resolve(ROOT, 'client/client.js'))
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      return res.end(raw)
    }
    if (req.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      const raw = readFileSync(resolve(ROOT, 'test/ui', url.pathname.slice(1)))
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' })
      return res.end(raw)
    }
    if (req.method === 'POST' && url.pathname.startsWith('/_dsh/dsh-carrot-on-a-stick/')) {
      const method = url.pathname.slice('/_dsh/dsh-carrot-on-a-stick/'.length)
      if (method === 'status') {
        rpcCounts.status++
        if (mode.statusError) return json(res, 500, { error: '模拟故障(statusError)' })
        return json(res, 200, snapshot())
      }
      if (method === 'stop' || method === 'start') {
        rpcCounts[method]++
        const apply = () => {
          if (method === 'stop') { state.listening = false; state.connections = [] }
          else { state.listening = true; state.connections = DEFAULT_CONNS() }
        }
        if (mode.actionDelayMs > 0) {
          await new Promise((r) => setTimeout(r, mode.actionDelayMs))
          if (res.writableEnded) return // 期间页面已离开/重载则不再响应
        }
        apply()
        return json(res, 200, method === 'stop' ? { stopped: true } : { started: true })
      }
      return json(res, 404, { error: 'unknown method ' + method })
    }
    if (url.pathname === '/__test/state') {
      return json(res, 200, { state: snapshot(), rpcCounts, boot })
    }
    if (req.method === 'POST' && url.pathname === '/__test/mode') {
      const body = await readBody(req)
      if (typeof body.statusError === 'boolean') mode.statusError = body.statusError
      if (typeof body.actionDelayMs === 'number') mode.actionDelayMs = body.actionDelayMs
      if (typeof body.listening === 'boolean') state.listening = body.listening
      if (typeof body.httpEnabled === 'boolean') state.httpEnabled = body.httpEnabled
      if (Array.isArray(body.connections)) state.connections = body.connections
      return json(res, 200, { ok: true, mode })
    }
    json(res, 404, { error: 'not found' })
  } catch (e) {
    json(res, 500, { error: String((e && e.message) || e) })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ui-harness] http://127.0.0.1:${PORT}/  (Ctrl+C 退出)`)
})
