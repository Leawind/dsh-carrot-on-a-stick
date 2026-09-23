window.__ModuleLoader__.load({ id: 'dsh-ops-mcp', factory: (require) => {
  var module = { exports: {} }; var exports = module.exports;
  // dsh-ops-mcp — client half(浏览器, 静态 bundle 形态)
  // - 数据/操作全部经 GUI 同源路由: POST /_dsh/dsh-ops-mcp/{status|stop|start}(host 半注册)
  // - 注册 settings.section 设置页面板: 状态查看 / 软停启 / 连接中的 MCP 客户端列表
  // - React 由模块系统种子提供; 不依赖其它 client 包(纯内联样式, 双主题中性配色)
  'use strict';

  const React = require('react');
  const RPC_BASE = '/_dsh/dsh-ops-mcp';

  function rpc(method, args) {
    return fetch(RPC_BASE + '/' + method, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(args || {}),
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (raw) {
          let body = null;
          try { body = JSON.parse(raw); } catch (e) { /* 非 JSON 错误体 */ }
          throw new Error((body && body.error) || ('HTTP ' + res.status));
        });
      }
      return res.text().then(function (raw) {
        try { return JSON.parse(raw); } catch (e) { throw new Error('响应解析失败'); }
      });
    });
  }

  function fmtDur(ms) {
    if (!(ms >= 0)) return '—';
    const s = Math.floor(ms / 1000);
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 时 ' + (m % 60) + ' 分';
    return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 时';
  }

  function fmtAgo(ts, now) {
    if (!ts) return '—';
    return fmtDur(now - ts) + '前';
  }

  function fmtClock(ts) {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  function shortId(s) { return s ? String(s).slice(0, 8) + '…' : '—'; }

  // 中性内联样式(不引主题变量, 深浅主题均可读)
  const S = {
    box: { display: 'flex', flexDirection: 'column', gap: '10px', padding: '12px', border: '1px solid rgba(128,128,128,.35)', borderRadius: '8px' },
    header: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
    title: { fontWeight: 600, fontSize: '15px' },
    version: { opacity: 0.6, fontSize: '12px' },
    badge: { display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', padding: '2px 10px', borderRadius: '999px', border: '1px solid rgba(128,128,128,.4)' },
    dot: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block' },
    btn: { cursor: 'pointer', padding: '4px 14px', borderRadius: '6px', border: '1px solid rgba(128,128,128,.45)', background: 'transparent', color: 'inherit', fontSize: '13px' },
    btnDanger: { borderColor: 'rgba(192,57,43,.55)', color: '#c0392b' },
    btnPrimary: { borderColor: 'rgba(31,136,61,.55)', color: '#1f883d' },
    meta: { display: 'flex', flexWrap: 'wrap', gap: '4px 18px', fontSize: '13px', opacity: 0.9 },
    metaKey: { opacity: 0.55 },
    endpoint: { cursor: 'pointer', fontVariantNumeric: 'tabular-nums', textDecoration: 'underline dotted', textDecorationColor: 'rgba(128,128,128,.5)' },
    sectionTitle: { fontSize: '13px', fontWeight: 600, opacity: 0.75, marginTop: '4px' },
    connRow: { display: 'grid', gridTemplateColumns: '90px 1fr 90px 110px 80px', gap: '8px', fontSize: '12.5px', padding: '5px 8px', borderRadius: '6px', alignItems: 'center' },
    connHead: { opacity: 0.55, background: 'rgba(128,128,128,.08)' },
    connUa: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.85 },
    mono: { fontVariantNumeric: 'tabular-nums' },
    empty: { fontSize: '12.5px', opacity: 0.55, padding: '6px 8px' },
    error: { fontSize: '12.5px', color: '#c0392b' },
    copied: { fontSize: '12px', opacity: 0.6 },
  };

  function Badge(props) {
    const ok = props.ok;
    const warn = props.warn;
    const color = ok ? '#1f883d' : warn ? '#b8860b' : '#c0392b';
    const text = ok ? '运行中' : warn ? '已停止' : '监听关闭';
    return React.createElement(
      'span',
      { style: S.badge },
      React.createElement('span', { style: Object.assign({}, S.dot, { background: color }) }),
      text,
    );
  }

  function StatusPanel() {
    const [state, setState] = React.useState(null);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [copied, setCopied] = React.useState(false);

    const refresh = React.useCallback(function () {
      return rpc('status')
        .then(function (s) { setState(s); setError(''); })
        .catch(function (e) { setError(String((e && e.message) || e)); });
    }, []);

    React.useEffect(function () {
      refresh();
      const timer = window.setInterval(refresh, 10000);
      return function () { window.clearInterval(timer); };
    }, [refresh]);

    function toggle() {
      if (!state || busy) return;
      const target = state.listening ? 'stop' : 'start';
      setBusy(true);
      rpc(target)
        .then(function () { return refresh(); })
        .catch(function (e) { setError(String((e && e.message) || e)); })
        .finally(function () { setBusy(false); });
    }

    function copyEndpoint() {
      if (state && state.endpoint && navigator.clipboard) {
        navigator.clipboard.writeText(state.endpoint).then(function () {
          setCopied(true);
          window.setTimeout(function () { setCopied(false); }, 1500);
        }, function () { /* 剪贴板被拒即静默 */ });
      }
    }

    if (!state) {
      return React.createElement('div', { style: S.box },
        error ? React.createElement('div', { style: S.error }, '⚠ ', error) : '载入中…');
    }

    const now = Date.now();
    const cfg = state.config || {};
    const stats = state.stats || {};
    const conns = state.connections || [];

    return React.createElement('div', { style: S.box },
      // 头部: 状态徽章 + 标题/版本 + 操作
      React.createElement('div', { style: S.header },
        React.createElement(Badge, { ok: !!state.listening, warn: state.httpEnabled !== false }),
        React.createElement('span', { style: S.title }, 'dsh-ops-mcp'),
        React.createElement('span', { style: S.version }, 'v' + (state.version || '?')),
        React.createElement('span', { style: { flex: 1 } }),
        state.listening
          ? React.createElement('button', { style: Object.assign({}, S.btn, S.btnDanger), onClick: toggle, disabled: busy }, busy ? '处理中…' : '停止')
          : (state.httpEnabled !== false
              ? React.createElement('button', { style: Object.assign({}, S.btn, S.btnPrimary), onClick: toggle, disabled: busy }, busy ? '处理中…' : '启动')
              : null),
        React.createElement('button', { style: S.btn, onClick: refresh }, '刷新'),
      ),
      // 元信息
      React.createElement('div', { style: S.meta },
        React.createElement('span', null,
          React.createElement('span', { style: S.metaKey }, '端点 '),
          React.createElement('span', { style: S.endpoint, title: '点击复制', onClick: copyEndpoint }, state.endpoint),
          copied ? React.createElement('span', { style: S.copied }, ' ✓ 已复制') : null),
        React.createElement('span', null, React.createElement('span', { style: S.metaKey }, '运行 '), fmtDur(state.uptimeMs)),
        React.createElement('span', null, React.createElement('span', { style: S.metaKey }, '模型 '), (cfg.provider || '?') + ' / ' + (cfg.model || '?')),
        React.createElement('span', null, React.createElement('span', { style: S.metaKey }, 'Preset '), cfg.preset || '?'),
        React.createElement('span', null, React.createElement('span', { style: S.metaKey }, '认证 '), cfg.authEnabled ? 'Bearer 已启用' : '未设置(仅本机)'),
        React.createElement('span', null, React.createElement('span', { style: S.metaKey }, '会话 TTL '), cfg.sessionTtlMs === 0 ? '不淘汰' : (cfg.sessionTtlMs ? fmtDur(cfg.sessionTtlMs) : '?')),
        React.createElement('span', null, React.createElement('span', { style: S.metaKey }, '常驻 Agent '), String(stats.liveAgents ?? 0)),
        React.createElement('span', null, React.createElement('span', { style: S.metaKey }, '队列 '), ((stats.queue && stats.queue.active) || 0) + ' 活跃 / ' + ((stats.queue && stats.queue.done) || 0) + ' 完成'),
      ),
      error ? React.createElement('div', { style: S.error }, '⚠ ', error) : null,
      // 连接列表
      React.createElement('div', null,
        React.createElement('div', { style: S.sectionTitle }, '连接中的 MCP 客户端 (' + conns.length + ')'),
        conns.length === 0
          ? React.createElement('div', { style: S.empty }, state.listening ? '暂无连接——MCP 客户端接入后此处实时显示。' : '服务已停止, 不接受连接。')
          : React.createElement('div', null,
              React.createElement('div', { style: Object.assign({}, S.connRow, S.connHead) },
                React.createElement('span', null, '会话'),
                React.createElement('span', null, '客户端 (User-Agent)'),
                React.createElement('span', { style: S.mono }, '连接于'),
                React.createElement('span', { style: S.mono }, '最近活跃'),
                React.createElement('span', { style: S.mono }, '请求数')),
              conns.map(function (c) {
                return React.createElement('div', { key: c.sessionId, style: S.connRow },
                  React.createElement('span', { style: S.mono, title: c.sessionId }, shortId(c.sessionId)),
                  React.createElement('span', { style: S.connUa, title: c.userAgent || '' }, c.userAgent || '(未报告)'),
                  React.createElement('span', { style: S.mono }, fmtClock(c.connectedAt)),
                  React.createElement('span', { style: S.mono }, fmtAgo(c.lastActivity, now)),
                  React.createElement('span', { style: S.mono }, String(c.requests ?? 0)),
                );
              })),
      ),
    );
  }

  module.exports = {
    inject: ['slots'],
    async apply(ctx) {
      // slots 服务可能晚于 apply 就绪(与官方设置区插件同型等待姿势)
      let slots = ctx.slots || ctx.get('slots');
      for (let i = 0; slots === undefined && i < 80; i++) {
        await new Promise(function (resolve) { window.setTimeout(resolve, 500); });
        slots = ctx.slots || ctx.get('slots');
      }
      if (slots === undefined) {
        console.warn('[dsh-ops-mcp] slots 服务 40s 内未就绪, 设置面板未注册');
        return;
      }
      slots.inject('settings.section', function () {
        return slots.register(
          { name: 'settings.section', id: 'dsh-ops-mcp', order: 110, label: function () { return 'dsh-ops-mcp（MCP 服务）'; } },
          function () { return React.createElement(StatusPanel); },
        );
      });
    },
  };
  return module.exports;
}});
