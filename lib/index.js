/**
 * dsh-ops-mcp — 在 Harness 内部启动 MCP server, 把 dsh 的操作能力暴露给任意 MCP 客户端。
 *
 * 工具集:
 *   - echo             : 验证 MCP server 连通
 *   - dsh_list_tools   : 列出 dsh 工具注册表(name + description)
 *   - model_list       : 列出当前可路由的 provider/模型/推理档(选模型前先查这里)
 *   - agent_run        : 同步执行任务(改代码/分析/跑命令), 返回结构化结果
 *   - task_inbox       : 调用方 push 结构化任务(任务+上下文)到 dsh 队列, 异步执行, 返回 taskId
 *   - task_result      : 取回任务的结构化结果(changes/verification/leftovers)
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
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import http from 'node:http';
import { resolve, sep } from 'node:path';
/** Cordis 插件名 */
export const name = 'dsh-ops-mcp';
/** 插件版本(MCP server 握手时上报) */
const PLUGIN_VERSION = '0.5.0';
/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export const inject = ['tools', 'llm', 'agents', 'agentPresets', 'workspaceRegistry', 'sessionPersistence', 'sessions'];
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
    taskTtlMs: 10 * 60 * 1000,
    maxAgents: 8,
    authToken: '',
    workspaceRoots: [],
    defaultDetail: 'summary',
};
/** 运行时配置(每次 apply 重新构建, 不跨次泄漏) */
let runtimeConfig = { ...DEFAULTS };
/** 工具回调统一返回 MCP text content */
function out(content) {
    return { content: [{ type: 'text', text: content }] };
}
// ── 零宿主副本: 本地等价实现(与宿主 dsh-llm/dsh-session 的纯数据行为逐字段一致) ──
/** SessionId 品牌转换: 宿主实现同样只是编译期 cast, 运行时原样返回字符串 */
function asSessionId(id) {
    return id;
}
/** 深冻结纯数据(数组/普通对象逐层 Object.freeze) */
function deepFreeze(value) {
    if (Array.isArray(value)) {
        value.forEach(deepFreeze);
        Object.freeze(value);
    }
    else if (value !== null && typeof value === 'object') {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}
/** 等价 dsh-llm 的 createUserMessage: {id, role:'user', content, source} 深冻结的 user 消息(纯数据, 无宿主符号) */
function userMessage(text) {
    return deepFreeze({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: name },
    });
}
/** 读取会话事件快照: 优先公开 API snapshotEvents()(0.1.5+), 回退旧版运行时同形的 log 字段 */
function eventsOf(session) {
    const s = session;
    if (typeof s.snapshotEvents === 'function')
        return s.snapshotEvents();
    return Array.isArray(s.log) ? s.log : [];
}
/**
 * cwd realpath 规范化: 解析符号链接与 .. 段, 使 cwd 能与 workspace.path(存储时为 realpath 规范化值)
 * 精确比对——这是官方 attachSession 强校验通过的前提。目录不存在时回退 resolve 结果, 由调用方告警不阻断。
 */
async function canonicalCwd(raw) {
    try {
        return await realpath(raw);
    }
    catch {
        return resolve(raw);
    }
}
/** 官方 session.create RPC 同款姿势: resolveByPath ?? create, 幂等; 无 workspaceRegistry 时返回 undefined */
async function ensureWorkspace(ctx, canonical) {
    const registry = ctx.get('workspaceRegistry');
    if (!registry)
        return undefined;
    return (await registry.resolveByPath?.(canonical)) ?? (await registry.create?.(canonical));
}
/** 把会话挂名到其 cwd 对应的工作区。attachSession 内部强校验 realpath(header.cwd) 精确等于 workspace.path,
 *  所以 canonical 必须是 header.cwd 的 realpath 规范化值。失败告警不阻断任务(分组是锦上添花)。 */
async function attachToWorkspace(ctx, canonical, sessionId) {
    try {
        const ws = await ensureWorkspace(ctx, canonical);
        if (ws?.attachSession)
            await ws.attachSession(sessionId);
    }
    catch (e) {
        console.warn('[dsh-ops-mcp] workspace attach failed:', e?.message ?? e);
    }
}
/** 按会话 header 的 cwd(realpath 规范化后)补挂工作区; header 无 cwd 时静默跳过 */
async function attachSessionCwd(ctx, sessionId, cwd) {
    if (cwd === undefined)
        return;
    await attachToWorkspace(ctx, await canonicalCwd(cwd), sessionId);
}
// ── cwd 白名单(跨平台) ──
/**
 * 跨平台目录包含判定: 双方 resolve 后统一分隔符为 '/', win32 再做大小写折叠。
 * 修复旧版 `startsWith(root + '/')` 在 Windows(反斜杠路径)下子目录永远不匹配的 bug。
 */
function isWithin(root, dir) {
    const fold = (p) => {
        let s = resolve(p);
        if (sep !== '/')
            s = s.split(sep).join('/');
        return process.platform === 'win32' ? s.toLowerCase() : s;
    };
    const r = fold(root);
    const d = fold(dir);
    return d === r || d.startsWith(`${r}/`);
}
/** 常驻 agent 会话(按 cwd + 模型三元组复用, 省 token: 避免每次全量加载项目上下文) */
const liveAgents = new Map();
/** sessionId → 池 key 索引(支持按 session 续接: 指定 sessionId 时定位到对应常驻会话) */
const sessionToPoolKey = new Map();
/** 每个 cwd 的串行执行锁(防同一 agent 会话被并发 followup 冲突) */
const agentLocks = new Map();
/**
 * 池 key = cwd + 模型三元组。
 * 带上模型是"按调用选模型"的基础: 同一目录下不同模型各占一个常驻会话, 而不是共用一个会话
 * 中途漂移模型——这样"用 A 模型跑任务1、B 模型跑任务2"在同一 cwd 里也可预期
 * (代价: 这两个会话不共享上下文)。想在同一个会话里换模型请用 select_model。
 */
function poolKey(cwd, selection) {
    return [cwd, selection.provider, selection.model, selection.reasoningEffort ?? ''].join('\u0000');
}
/** 取宿主服务: 优先 ctx.get(可选依赖的官方姿势), 回退同名属性(最小假 ctx / 旧宿主) */
function serviceOf(ctx, name) {
    const viaGet = ctx.get?.(name);
    if (viaGet !== undefined)
        return viaGet;
    return ctx[name];
}
/**
 * setup 挂载 preset(含 bash/fs/todo/web 等完整工具)。
 * 直接调用宿主服务 ctx.agentPresets.mount——scope 校验由 mount 自身完成,
 * 不再用插件侧 scopeOf 预检(混装副本的私有 Symbol 不匹配曾让预检恒假, 导致 agent 静默失去全部工具)。
 */
async function mountPreset(ctx, agentCtx) {
    await ctx.agentPresets.mount(agentCtx, runtimeConfig.preset);
}
/**
 * 读宿主默认模型选择(agentDefaultModel; 未挂载该插件时为 undefined)。
 * 与 Web UI 建会话同款来源——插件不自己维护一份"默认模型"。
 */
function hostDefaultSelection(ctx) {
    return serviceOf(ctx, 'agentDefaultModel')
        ?.currentSelection?.();
}
/** 调用是否携带了任一模型覆盖字段(用于 allowModelOverride 门禁与"没有覆盖"判定) */
function hasModelOverride(override) {
    return override !== undefined
        && (override.provider !== undefined || override.model !== undefined || override.reasoningEffort !== undefined);
}
/** 把 MCP 工具的可选参数收敛成 override(MCP 客户端可能把空串当"未提供", 一并当没有) */
function selectionOverrideOf(args) {
    const o = {};
    if (args.provider)
        o.provider = args.provider;
    if (args.model)
        o.model = args.model;
    if (args.reasoningEffort)
        o.reasoningEffort = args.reasoningEffort;
    return hasModelOverride(o) ? o : undefined;
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
function resolveAgentOptions(ctx, override) {
    if (!runtimeConfig.allowModelOverride && hasModelOverride(override)) {
        throw new Error('model override is disabled by plugin config (allowModelOverride: false); '
            + 'remove provider/model/reasoningEffort from the call, or enable allowModelOverride in cordis.yml');
    }
    const cfg = { provider: runtimeConfig.provider, model: runtimeConfig.model };
    const host = hostDefaultSelection(ctx);
    const provider = override?.provider || cfg.provider || host?.provider;
    const model = override?.model || cfg.model || host?.model;
    // 推理强度与模型同源: 调用覆盖 > 插件 config > 宿主默认(仅当模型不是被显式钉住时继承)。
    // 若调用方/插件 profile 已显式钉住 provider+model, 就不继承宿主那个"为别的模型选的"档位——
    // 宿主对不支持的显式 effort 是直接拒绝(不做 clamp/别名), 继承反而会把能跑的部署弄挂。
    const pinnedModel = Boolean((override?.provider && override?.model) || (cfg.provider && cfg.model));
    const reasoningEffort = override?.reasoningEffort
        ?? (runtimeConfig.reasoningEffort || (pinnedModel ? undefined : host?.reasoningEffort));
    if (!provider || !model) {
        throw new Error(`cannot determine model for spawned agent: call override has {provider: ${JSON.stringify(override?.provider ?? null)}, model: ${JSON.stringify(override?.model ?? null)}}, `
            + `plugin config has {provider: ${JSON.stringify(cfg.provider || null)}, model: ${JSON.stringify(cfg.model || null)}}, `
            + `host default selection has {provider: ${JSON.stringify(host?.provider ?? null)}, model: ${JSON.stringify(host?.model ?? null)}}. `
            + '请在调用里成对传 provider+model(先用 model_list 查可用值), 或在插件 config 成对配置, 或先在 dsh 设置里选择默认模型.');
    }
    return reasoningEffort ? { provider, model, reasoningEffort } : { provider, model };
}
/** 从 live agent 读它当前实际用的模型选择(接管别人建的会话时回报用; 读不到就留空, 不抛错) */
function selectionOfAgent(agent) {
    const opts = agent?.options;
    const s = (v) => (typeof v === 'string' ? v : '');
    const provider = s(opts?.provider);
    const model = s(opts?.model);
    const reasoningEffort = s(opts?.reasoningEffort);
    return reasoningEffort ? { provider, model, reasoningEffort } : { provider, model };
}
/**
 * 转成宿主 ctx.agents.create/resume 要的 agentOptions。
 * reasoningEffort 在宿主侧是 branded 类型(ReasoningEffortId): 值本身是适配器定义的字符串
 * (来自调用方 / model_list / 适配器默认), 这里只做编译期桥接——零宿主副本原则下不引入宿主的品牌构造函数。
 */
function agentOptionsOf(selection) {
    const opts = { provider: selection.provider, model: selection.model };
    if (selection.reasoningEffort !== undefined) {
        opts.reasoningEffort = selection.reasoningEffort;
    }
    return opts;
}
/** 获取(或创建)指定 cwd 的常驻 agent 会话; 传 sessionId 时接管指定会话; 传 title 时给新会话命名 */
async function getAgent(ctx, cwd, sessionId, title, override) {
    // 指定 sessionId: 接管已有会话(长任务分多轮投喂 / 中断后恢复 / UI 手开的会话)
    if (sessionId) {
        // 先看本进程常驻池(池 key 里含模型, 所以按 sessionId → 池 key 的索引定位; 命中 LRU 移到末尾)
        const poolKeyOfSession = sessionToPoolKey.get(sessionId);
        if (poolKeyOfSession !== undefined) {
            const existing = liveAgents.get(poolKeyOfSession);
            if (existing) {
                liveAgents.delete(poolKeyOfSession);
                liveAgents.set(poolKeyOfSession, existing);
                return existing;
            }
        }
        const sid = asSessionId(sessionId);
        // 不在常驻池: 看 live(UI 手开的、别的插件持有的会话), 直接接管、不持有 dispose(归其 owner)。
        // 这条路不解析模型选择: 沿用该会话原有的选择(只给一边 override 时也不改它, 想改请用 select_model)。
        const live = ctx.agents.get(sid);
        if (live) {
            // live 会话也补挂工作区(幂等): 用户手开的会话若尚未归组, 这里一并挂名
            await attachSessionCwd(ctx, sid, live.session.header.cwd);
            // no-op dispose 兜底: executeTask 只在 disposeAfter 为 true 时调用 dispose
            return { sessionId: sid, handle: { agent: live, dispose: () => Promise.resolve() }, disposeAfter: false, selection: selectionOfAgent(live) };
        }
        // live 也没有: 从持久化会话存储 resume 并接管(进程重启前的会话、LRU 淘汰后被释放的会话)
        // resume 会重建 agent, 所以这里必须现算一份完整模型选择(agent.options.model 是 {{model}} 变量的来源)
        const selection = resolveAgentOptions(ctx, override);
        let handle;
        try {
            handle = await ctx.agents.resume({
                resumeSessionId: sid,
                agentOptions: agentOptionsOf(selection),
                setup: async (agentCtx) => {
                    await mountPreset(ctx, agentCtx);
                },
            });
        }
        catch (e) {
            // 恢复失败返回明确错误(沿用上游错误风格): 不在常驻池、不是 live、持久化里也没有(或 resume 失败)
            throw new Error(`session not found for resume: ${sessionId} (not live and not persisted; ${e?.message ?? e})`);
        }
        await attachSessionCwd(ctx, sid, handle.agent.session.header.cwd);
        return { sessionId: sid, handle, disposeAfter: true, selection };
    }
    // 无 sessionId: 按 cwd + 模型三元组命中/新建常驻会话(不同模型 = 不同会话, 上下文不串联)
    const selection = resolveAgentOptions(ctx, override);
    const key = poolKey(cwd, selection);
    const existing = liveAgents.get(key);
    if (existing) {
        // LRU: 命中则移到末尾(最近使用)
        liveAgents.delete(key);
        liveAgents.set(key, existing);
        // 自愈: 幂等补挂(已在花名册则 no-op; 首次挂名失败的池会话在此被捞回)
        await attachToWorkspace(ctx, await canonicalCwd(cwd), existing.sessionId);
        return existing;
    }
    // LRU 淘汰: 超过上限时逐出最久未用的会话
    while (liveAgents.size >= runtimeConfig.maxAgents) {
        const oldestKey = liveAgents.keys().next().value;
        if (oldestKey === undefined)
            break;
        const old = liveAgents.get(oldestKey);
        liveAgents.delete(oldestKey);
        if (old) {
            sessionToPoolKey.delete(String(old.sessionId));
            try {
                void old.handle?.dispose?.();
            }
            catch { /* 忽略 */ }
        }
    }
    const newSessionId = asSessionId(randomUUID());
    // cwd 先 realpath 规范化: session header 的 cwd 与 workspace.path 必须精确相等,
    // 否则 attachSession 强校验 reject(只会 create 注册而 UI 仍落未分组)
    const canonical = await canonicalCwd(cwd);
    const handle = await ctx.agents.create({
        sessionId: newSessionId,
        // 声明 preset: 当前版本主要靠 setup 里 mount, meta.agentPreset 供未来 Harness 版本直接消费。
        meta: { cwd: canonical, agentPreset: runtimeConfig.preset },
        // 模型选择: 调用覆盖 / 插件 config / 宿主默认补全后的完整选择(agent.options.model 是 {{model}} 变量的来源)
        agentOptions: agentOptionsOf(selection),
        setup: async (agentCtx) => {
            await mountPreset(ctx, agentCtx);
        },
    });
    const rec = { sessionId: newSessionId, handle, cwd, selection };
    liveAgents.set(key, rec);
    sessionToPoolKey.set(String(newSessionId), key);
    // 分组: 把会话归属到 cwd 对应的工作区(resolveByPath ?? create + attachSession; 可选依赖; headless 环境自动跳过)
    void (async () => {
        try {
            const ws = await ensureWorkspace(ctx, canonical);
            if (ws?.attachSession)
                await ws.attachSession(newSessionId);
        }
        catch (e) {
            console.warn('[dsh-ops-mcp] workspace attach failed:', String(e));
        }
    })();
    // title 命名(可选): 创建会话后立即命名(走 sessionTitle 服务的 rename)
    if (title) {
        try {
            const session = handle.agent.session;
            const st = ctx.get('sessionTitle');
            st?.rename?.(session, title);
        }
        catch (e) {
            console.warn('[dsh-ops-mcp] session title set failed:', String(e));
        }
    }
    return rec;
}
/** 同一 cwd 串行执行, 避免并发 followup 同一会话 */
async function withLock(cwd, fn) {
    const prev = agentLocks.get(cwd) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    agentLocks.set(cwd, next.catch(() => { }));
    return next;
}
/** 从 agent 最终回答里解析 changes/verification/leftovers(从后往前找候选, 更可靠) */
function parseSummary(assistantText) {
    const empty = { changes: '', verification: '', leftovers: '' };
    // 收集所有 {...} 候选(agent 被要求输出一行 summary JSON)
    const candidates = [];
    const re = /\{[\s\S]*?\}/g;
    let m;
    while ((m = re.exec(assistantText)) !== null) {
        candidates.push(m[0]);
    }
    // 从后往前: 最后出现的候选最可能是最终 summary, 逐个尝试解析
    for (let i = candidates.length - 1; i >= 0; i--) {
        try {
            const obj = JSON.parse(candidates[i]);
            const s = (v) => (typeof v === 'string' ? v : '');
            const changes = s(obj.changes) || s(obj.改动);
            const verification = s(obj.verification) || s(obj.验证);
            const leftovers = s(obj.leftovers) || s(obj.遗留) || s(obj.leftover);
            // 只要含任一 summary 字段就采纳, 否则继续尝试更早的候选
            if (changes || verification || leftovers) {
                return { changes, verification, leftovers };
            }
        }
        catch {
            // 非合法 JSON, 继续尝试下一个候选
        }
    }
    return empty;
}
/** 各级别字段上限(字符) */
const DETAIL_CAPS = {
    summary: { summaryField: 300, error: 300, assistantTail: 1200, toolCalls: 0, toolCallArgs: 0, toolResults: 0, toolResultChars: 0, assistantText: 0 },
    normal: { summaryField: 400, error: 600, assistantTail: 1200, toolCalls: 15, toolCallArgs: 250, toolResults: 6, toolResultChars: 400, assistantText: 0 },
    full: { summaryField: 2000, error: 2000, assistantTail: 0, toolCalls: 50, toolCallArgs: 2000, toolResults: 20, toolResultChars: 2000, assistantText: 8000 },
};
function clip(text, max) {
    return text.length <= max ? text : text.slice(0, max);
}
const DETAIL_ARG = {
    summary: 'summary(默认): 三行总结 + 回答尾部 + 工具名列表, ~数百 token',
    normal: 'normal: 加上截断的工具调用参数与结果(~2k token)',
    full: 'full: 完整原文(最坏数万 token, 仅排查用)',
};
/** 结果里的模型回报: 只保留有值的字段(接管别人建的会话、读不到 options 时为空对象) */
function projectModel(selection) {
    const o = {};
    if (selection?.provider)
        o.provider = selection.provider;
    if (selection?.model)
        o.model = selection.model;
    if (selection?.reasoningEffort)
        o.reasoningEffort = selection.reasoningEffort;
    return o;
}
/** 读时投影: 把全量 TaskResult 渲染成对应 detail 级别的返回载荷 */
function renderResult(result, detail) {
    const caps = DETAIL_CAPS[detail];
    const base = {
        detail,
        taskId: result.taskId,
        sessionId: result.sessionId,
        model: projectModel(result.model),
        toolCallCount: result.toolCalls.length,
        toolResultCount: result.toolResults.length,
        error: clip(result.error, caps.error),
        changes: clip(result.changes, caps.summaryField),
        verification: clip(result.verification, caps.summaryField),
        leftovers: clip(result.leftovers, caps.summaryField),
    };
    if (detail === 'summary') {
        // 总结 JSON 在回答末尾, 尾部最有信息量; 工具只报名字不报参数
        return {
            ...base,
            assistantTail: result.assistantText.slice(-caps.assistantTail),
            toolCallNames: result.toolCalls.map((c) => c.name),
        };
    }
    if (detail === 'normal') {
        return {
            ...base,
            assistantTail: result.assistantText.slice(-caps.assistantTail),
            toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
            toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
        };
    }
    return {
        ...base,
        assistantText: result.assistantText.slice(0, caps.assistantText),
        toolCalls: result.toolCalls.slice(0, caps.toolCalls).map((c) => ({ name: c.name, args: clip(c.args, caps.toolCallArgs) })),
        toolResults: result.toolResults.slice(0, caps.toolResults).map((r) => clip(r, caps.toolResultChars)),
    };
}
/** 核心执行: 组装任务(注入记忆上下文+结构化要求) → agent 执行 → 读结构化结果 */
async function executeTask(ctx, task, context, cwd, resumeSessionId, title, override) {
    // 规范化 cwd: realpath 解析符号链接与 .. 段, 避免 /a、/a/.、相对路径、符号链接成为不同 Map key
    // 导致重复创建会话/并发冲突; 同时也是与 workspace.path 精确比对的唯一 canon
    const workdir = await canonicalCwd(cwd ? resolve(cwd) : process.cwd());
    // cwd 白名单: 配置了 workspaceRoots 时, 只允许在列出的目录(含子目录)下干活(防路径穿越)
    if (runtimeConfig.workspaceRoots.length > 0) {
        const allowed = runtimeConfig.workspaceRoots.some((root) => isWithin(root, workdir));
        if (!allowed) {
            throw new Error(`cwd not allowed (outside workspaceRoots): ${workdir}`);
        }
    }
    // sessionId 用 session 锁, 否则用 cwd 锁——都防同一 agent 会话被并发 followup
    const lockKey = resumeSessionId ? `session:${resumeSessionId}` : workdir;
    return withLock(lockKey, async () => {
        const { sessionId, handle, disposeAfter, selection } = await getAgent(ctx, workdir, resumeSessionId, title, override);
        // 事件基线: 只读本轮新增事件(公开 API snapshotEvents; 旧宿主回退 log 字段)
        const baseline = eventsOf(handle.agent.session).length;
        // 组装完整任务文本: 记忆上下文 + 任务 + 结构化输出要求
        const fullTask = [
            context ? `【记忆/上下文(供参考, 来自调用方)】\n${context}\n` : '',
            `【任务】\n${task}\n`,
            `【完成后必须】用一行 JSON 总结(不要 markdown 代码块包裹, 直接输出这一行):`,
            `{"changes":"改了什么","verification":"怎么验证的","leftovers":"遗留问题"}`,
        ].filter(Boolean).join('\n');
        handle.agent.followup(userMessage(fullTask));
        await handle.agent.whenIdle();
        // 结构化读输出
        const result = {
            taskId: '', sessionId, model: selection, assistantText: '', toolCalls: [], toolResults: [],
            changes: '', verification: '', leftovers: '', error: '',
        };
        let observedEvents = 0;
        try {
            const events = eventsOf(handle.agent.session).slice(baseline);
            observedEvents = events.length;
            const extractText = (obj, outTexts) => {
                if (Array.isArray(obj)) {
                    obj.forEach((x) => extractText(x, outTexts));
                    return;
                }
                if (obj && typeof obj === 'object') {
                    const rec = obj;
                    if (typeof rec.text === 'string' && rec.text.trim())
                        outTexts.push(rec.text);
                    if (typeof rec.content === 'string' && rec.content.trim())
                        outTexts.push(rec.content);
                    for (const v of Object.values(rec))
                        extractText(v, outTexts);
                }
            };
            for (const e of events) {
                const ev = e;
                if (ev.type === 'assistant/message') {
                    const d = ev.data;
                    const content = d?.message?.content;
                    if (content) {
                        const texts = content.filter((c) => c.type === 'text' && c.text).map((c) => c.text);
                        if (texts.length)
                            result.assistantText += texts.join('\n') + '\n';
                    }
                }
                else if (ev.type === 'tool/call') {
                    const d = ev.data;
                    result.toolCalls.push({
                        name: d?.name ?? '?',
                        args: (d?.arguments ?? JSON.stringify(d?.input ?? null) ?? '').slice(0, 2000),
                    });
                }
                else if (ev.type === 'tool/result') {
                    const texts = [];
                    extractText(ev.data ?? ev, texts);
                    if (texts.length)
                        result.toolResults.push(texts.join('\n').slice(0, 3000));
                }
                else if (ev.type === 'turn/end') {
                    // 失败透出: turn 的非 completed 收场(LlmError/取消/blocked/max-tokens)进 error 字段。
                    // E2E 实测教训: 模型调用失败时没有任何 assistant 输出, 不透出的话调用方只拿到"成功"的空结果。
                    const d = ev.data;
                    const r = d?.reason;
                    if (r && r.kind && r.kind !== 'completed') {
                        const bits = [`turn ${d?.turn ?? '?'} ended: ${r.kind}`];
                        if (r.error)
                            bits.push(`${r.error.code ?? 'ERROR'}: ${r.error.message ?? ''}`);
                        else if (r.reason !== undefined)
                            bits.push(String(r.reason));
                        result.error = (result.error ? `${result.error} | ` : '') + bits.join(' — ');
                    }
                }
            }
        }
        catch (e) {
            result.assistantText = `[读输出异常] ${String(e)}`;
        }
        // 完全无产出且无错误事件时给出可诊断的兜底(而不是一份"成功"的空结果)
        if (!result.assistantText && !result.error) {
            result.error = observedEvents === 0
                ? 'no new session events observed (turn may not have started)'
                : `turn produced no assistant output (observed ${observedEvents} events, none assistant/message)`;
        }
        // 解析结构化 summary
        const summary = parseSummary(result.assistantText);
        result.changes = summary.changes;
        result.verification = summary.verification;
        result.leftovers = summary.leftovers;
        // 持久化同步: 池会话与 resume 会话都在任务后尽力 flush(官方 whenIdle 注释: 消费者自读存储需自行 flush;
        // 不 flush 的话 durable log 只有 header, 进程重启后的续接会丢历史)。失败不阻断结果返回。
        try {
            await ctx.get('sessions')?.flush?.(handle.agent.session);
        }
        catch {
            /* flush 失败不阻断结果返回 */
        }
        // resume 兜底分支: 再释放我们 resume 出来的独占句柄(不留给僵尸 live agent)
        if (disposeAfter) {
            try {
                await handle.dispose();
            }
            catch {
                /* 释放失败不影响结果 */
            }
        }
        return result;
    });
}
const taskQueue = new Map();
// ── 会话查找 ──
/**
 * 从持久化快照列表取 SessionHeader。
 * 0.1.5+ 的 sessionPersistence.list() 返回 SessionPersistenceSnapshot[](header 在 .header 字段),
 * 更早版本直接返回裸 header——两种形状都兼容。
 */
function headerOfSnapshot(snap) {
    if (!snap || typeof snap !== 'object')
        return undefined;
    const rec = snap;
    return rec.header ?? rec;
}
/** 找会话 header: live 优先, 其次持久化 list(轻量元数据扫描, 不加载整日志) */
async function findSessionHeader(ctx, sessionId) {
    const sessions = ctx.get('sessions');
    const live = sessions?.get?.(sessionId);
    if (live !== undefined)
        return live.header;
    const persistence = ctx.get('sessionPersistence');
    for (const snap of (await persistence?.list?.()) ?? []) {
        if (headerOfSnapshot(snap)?.id === sessionId)
            return headerOfSnapshot(snap);
    }
    return undefined;
}
/**
 * 存量捞回: 启动时把现存未分组的会话补挂到已注册工作区。
 * 条件: header.cwd 的 realpath 等于某已注册 workspace.path, 且该 sessionId 不在其花名册里。
 * 只补挂到"已注册"工作区, 不新建(避免把无关目录刷成新工作区); 单会话失败不影响其余。
 */
async function reattachOrphanSessions(ctx) {
    const registry = ctx.get('workspaceRegistry');
    const byPath = new Map();
    for (const ws of registry?.list?.() ?? [])
        byPath.set(ws.path, ws);
    if (byPath.size === 0)
        return { attached: 0, failed: 0 };
    // live + 持久化 header 合并(live 优先), 按 id 去重(持久化侧兼容快照/裸 header 两种形状)
    const headers = new Map();
    const sessions = ctx.get('sessions');
    for (const session of sessions?.list?.() ?? [])
        headers.set(session.header.id, session.header);
    const persistence = ctx.get('sessionPersistence');
    for (const snap of (await persistence?.list?.()) ?? []) {
        const header = headerOfSnapshot(snap);
        if (header && !headers.has(header.id))
            headers.set(header.id, header);
    }
    let attached = 0;
    let failed = 0;
    for (const header of headers.values()) {
        if (header.cwd === undefined)
            continue;
        const canonical = await canonicalCwd(header.cwd);
        const ws = byPath.get(canonical);
        if (ws === undefined || !ws.attachSession)
            continue;
        if (ws.sessionIds.includes(header.id))
            continue;
        try {
            await ws.attachSession(header.id);
            attached++;
            console.log(`[dsh-ops-mcp] 存量捞回: session ${header.id} -> workspace ${ws.path}`);
        }
        catch (e) {
            failed++;
            console.warn(`[dsh-ops-mcp] 存量捞回失败 session ${header.id}:`, e?.message ?? e);
        }
    }
    return { attached, failed };
}
/** 目录里的模型投影: 只留 id/name + 推理档(选 reasoningEffort 要用), 丢掉 description 等长字段省上下文 */
function projectCatalogModel(m) {
    const id = m.id ?? '';
    const out = { id, name: m.name ?? id };
    const efforts = (m.reasoning?.efforts ?? []).map((e) => ({ id: e.id ?? '', name: e.name ?? e.id ?? '' }));
    if (efforts.length)
        out.reasoningEfforts = efforts;
    if (m.reasoning?.defaultEffort)
        out.defaultReasoningEffort = m.reasoning.defaultEffort;
    return out;
}
/**
 * 收集当前可路由的模型目录。两个来源:
 *   1. sessionController.modelCatalog() —— 官方口径(含 default / routableProviders / 各 provider 的加载失败),
 *      与 Web UI 模型选择器同一数据源;
 *   2. 回退: llm.listProviders() + 逐个 listModels() —— 只服务会话控制器缺席的部署(如 headless),
 *      逐个 provider 隔离失败, 且不含推理档元数据(那需要 resolveModelInfo, 这里不逐模型发请求)。
 * 同时回报插件自身的模型配置与 allowModelOverride, 让调用方知道"能不能自己选"。
 */
async function collectModelCatalog(ctx, only) {
    const failures = [];
    let source = 'none';
    let groups = [];
    let routable = [];
    let def;
    const sc = serviceOf(ctx, 'sessionController');
    if (typeof sc?.modelCatalog === 'function') {
        try {
            const cat = await sc.modelCatalog();
            source = 'sessionController';
            def = cat.default;
            routable = [...(cat.routableProviders ?? [])];
            groups = (cat.groups ?? []).map((g) => {
                const id = g.id ?? '';
                return { id, name: g.name ?? id, models: (g.models ?? []).map(projectCatalogModel) };
            });
            for (const f of cat.failures ?? []) {
                failures.push({ id: f.id ?? '', ...(f.name ? { name: f.name } : {}), message: f.message ?? 'unknown failure' });
            }
        }
        catch (e) {
            failures.push({ id: 'sessionController', message: String(e?.message ?? e) });
        }
    }
    const llm = serviceOf(ctx, 'llm');
    if (source !== 'sessionController' && typeof llm?.listProviders === 'function') {
        source = 'llm';
        const providers = llm.listProviders();
        routable = providers.map((p) => p.id ?? '').filter(Boolean);
        groups = await Promise.all(routable.map(async (id) => {
            const name = providers.find((p) => (p.id ?? '') === id)?.name ?? id;
            try {
                const models = typeof llm.listModels === 'function' ? await llm.listModels(id) : [];
                return { id, name, models: models.map((m) => projectCatalogModel(m)) };
            }
            catch (e) {
                failures.push({ id, name, message: String(e?.message ?? e) });
                return { id, name, models: [] };
            }
        }));
    }
    // 缺省选择: 官方目录优先, 其次宿主默认选择(agentDefaultModel)
    if (def === undefined)
        def = hostDefaultSelection(ctx);
    const q = only?.trim();
    const filtered = q ? groups.filter((g) => g.id === q) : groups;
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
    };
}
/**
 * 会话模型切换后的池维护: 池 key 含模型三元组, 模型变了就要把该会话挪到新 key 下。
 * 目标 key 已被同 cwd 的另一个会话占用时不再入池(避免顶掉别人的默认会话): 该会话仍可按
 * sessionId 接管(ctx.agents.get), 只是不再是"该 cwd + 该模型"的默认池会话。
 */
function rekeyPooledSession(sessionId, next) {
    const key = sessionToPoolKey.get(sessionId);
    if (key === undefined)
        return;
    const rec = liveAgents.get(key);
    sessionToPoolKey.delete(sessionId);
    if (rec === undefined)
        return;
    liveAgents.delete(key);
    const nextKey = poolKey(rec.cwd, next);
    if (liveAgents.has(nextKey))
        return;
    rec.selection = next;
    liveAgents.set(nextKey, rec);
    sessionToPoolKey.set(sessionId, nextKey);
}
// ── MCP 工具注册 ──
/** 在给定 McpServer 上注册工具 */
function registerTools(mcp, ctx) {
    mcp.tool('echo', '回显输入, 验证 MCP server 连通', { text: z.string() }, async ({ text }) => {
        return out(`收到: ${text} @ ${Date.now()}`);
    });
    mcp.tool('dsh_list_tools', '列出宿主全局工具注册表(name + description)。注意: 0.1.5+ 的模型工具挂在 preset/agent 作用域, 全局表通常为空; agent 实际可用的工具以 agent_run 结果里的 toolCalls 为准。', {}, async () => {
        // 0.1.5+: ctx.tools.schemas() 投影全局可见工具; 更早版本的 keys() 作为回退
        const tools = ctx.tools;
        let list;
        if (tools && typeof tools.schemas === 'function') {
            list = tools.schemas().map((s) => ({ name: s.name, description: s.description ?? '' }));
        }
        else if (tools && typeof tools.keys === 'function') {
            list = Array.from(tools.keys(), (n) => ({ name: n, description: '' }));
        }
        else {
            list = [];
        }
        return out(JSON.stringify(list));
    });
    // 模型目录: 选模型前先查这里(provider route / 模型 id / 推理档 / 缺省选择)
    mcp.tool('model_list', '列出当前可路由的 provider、模型 id 与推理档(reasoningEfforts), 以及缺省模型选择。agent_run/task_inbox 的 provider/model/reasoningEffort 与 select_model 都取自这里。source=sessionController 为官方口径(与 Web UI 模型选择器同源); source=llm 为回退(不含推理档)。', {
        provider: z.string().optional().describe('只看某个 provider route(缺省: 全部)'),
    }, async ({ provider }) => out(JSON.stringify(await collectModelCatalog(ctx, provider), null, 2)));
    // 同步执行任务(简单场景: 调用方下发 → 立即拿结果)
    mcp.tool('agent_run', '同步执行任务(改代码/分析/跑命令), 返回结构化结果。可传 sessionId 续接已有会话(长任务分多轮投喂)。可用 provider/model/reasoningEffort 指定本次模型(见 model_list; 同 cwd 下不同模型各自一个常驻会话)。默认返回 summary 级(省上下文), 需要 toolCalls 原文时传 detail=full。', {
        task: z.string().describe('要 Harness 执行的自然语言任务'),
        context: z.string().optional().describe('调用方记忆/上下文, 注入给 agent 参考(续接同一 sessionId 时建议只发增量)'),
        cwd: z.string().optional().describe('工作目录(默认当前)'),
        sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果里的 sessionId 字段)'),
        title: z.string().optional().describe('新会话的标题(创建时命名, 便于会话列表归档)'),
        detail: z.enum(['summary', 'normal', 'full']).optional().describe(`结果详略: ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
        provider: z.string().optional().describe('模型 provider route(见 model_list; 需与 model 成对; 缺省走插件配置/宿主默认)'),
        model: z.string().optional().describe('模型 id(见 model_list; 需与 provider 成对; 缺省走插件配置/宿主默认)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
    }, async ({ task, context, cwd, sessionId, title, detail, provider, model, reasoningEffort }) => {
        const result = await executeTask(ctx, task, context ?? '', cwd ?? process.cwd(), sessionId, title, selectionOverrideOf({ provider, model, reasoningEffort }));
        return out(JSON.stringify(renderResult(result, detail ?? runtimeConfig.defaultDetail), null, 2));
    });
    // 异步 push 任务到队列(调用方 → dsh 任务入口)
    mcp.tool('task_inbox', '把结构化任务(任务+上下文)推入 dsh 队列, 异步执行, 返回 taskId。可用 provider/model/reasoningEffort 指定本次模型(见 model_list)。', {
        task: z.string().describe('任务内容'),
        context: z.string().optional().describe('调用方记忆/上下文, 随任务注入给 agent'),
        cwd: z.string().optional().describe('工作目录'),
        sessionId: z.string().optional().describe('续接已有会话的 sessionId(来自上次 agent_run 结果)'),
        title: z.string().optional().describe('新会话的标题(创建时命名)'),
        provider: z.string().optional().describe('模型 provider route(见 model_list; 需与 model 成对)'),
        model: z.string().optional().describe('模型 id(见 model_list; 需与 provider 成对)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts)'),
    }, async ({ task, context, cwd, sessionId, title, provider, model, reasoningEffort }) => {
        const now = Date.now();
        // TTL 清理: 删除已完成/失败且超时的任务
        for (const [tid, t] of taskQueue) {
            if ((t.status === 'done' || t.status === 'error') && t.finishedAt && now - t.finishedAt > runtimeConfig.taskTtlMs) {
                taskQueue.delete(tid);
            }
        }
        // 队列容量上限: 活动任务(排队+执行中)超过上限则拒绝
        let active = 0;
        for (const t of taskQueue.values())
            if (t.status === 'queued' || t.status === 'running')
                active++;
        if (active >= runtimeConfig.maxQueue) {
            return out(JSON.stringify({ error: `task queue full (${active}/${runtimeConfig.maxQueue})` }));
        }
        const id = randomUUID();
        const item = {
            id, task, context: context ?? '', cwd: cwd ?? process.cwd(), status: 'queued', createdAt: now,
            ...(sessionId ? { sessionId } : {}),
            ...(title ? { title } : {}),
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
            ...(reasoningEffort ? { reasoningEffort } : {}),
        };
        taskQueue.set(id, item);
        // 异步执行(不阻塞调用方)
        void (async () => {
            item.status = 'running';
            try {
                item.result = await executeTask(ctx, item.task, item.context, item.cwd, item.sessionId, item.title, selectionOverrideOf(item));
                item.result.taskId = id;
                item.status = 'done';
            }
            catch (e) {
                item.error = String(e);
                item.status = 'error';
            }
            item.finishedAt = Date.now();
        })();
        return out(JSON.stringify({ taskId: id, status: 'queued' }));
    });
    // 取回任务结果(结构化 changes/verification/leftovers; 轮询用 status 档避免重复注入 payload)
    mcp.tool('task_result', '取回 task_inbox 提交任务的结构化结果。轮询请传 detail=status(只返回状态, 不注入结果 payload, 完成后再取一次默认 summary)。', {
        taskId: z.string().describe('task_inbox 返回的 taskId'),
        detail: z.enum(['status', 'summary', 'normal', 'full']).optional().describe(`结果详略: status=只查状态(轮询); ${DETAIL_ARG.summary}; ${DETAIL_ARG.normal}; ${DETAIL_ARG.full}`),
    }, async ({ taskId, detail }) => {
        const item = taskQueue.get(taskId);
        if (!item)
            return out(JSON.stringify({ error: `task not found: ${taskId}` }));
        // status 档 / 任务未完成: 轻量返回, 不带结果字段(避免轮询把 payload 重复灌进调用方上下文)
        if (detail === 'status' || !item.result) {
            return out(JSON.stringify({
                taskId: item.id,
                status: item.status,
                ...(item.error ? { error: String(item.error).slice(0, 400) } : {}),
            }));
        }
        return out(JSON.stringify(renderResult(item.result, detail ?? runtimeConfig.defaultDetail), null, 2));
    });
    // 会话内换模型(官方 selectModel 路径: 校验 + 持久通知, 下一个 step 生效; 历史不丢)
    mcp.tool('select_model', '切换一个已存在会话使用的模型(走官方 sessionController.selectModel: 校验后写一条持久通知, 在下一个 step 生效, 对话历史保留)。需要 web profile 的 sessionController; 不可用时改用 agent_run 的 provider/model 参数。', {
        sessionId: z.string().describe('要换模型的会话 id'),
        provider: z.string().describe('目标 provider route(见 model_list)'),
        model: z.string().describe('目标模型 id(见 model_list)'),
        reasoningEffort: z.string().optional().describe('推理强度 id(见 model_list 的 reasoningEfforts; 缺省 = 适配器默认)'),
    }, async ({ sessionId, provider, model, reasoningEffort }) => {
        if (!runtimeConfig.allowModelOverride) {
            return out(JSON.stringify({ error: 'model override is disabled by plugin config (allowModelOverride: false)' }));
        }
        const sc = serviceOf(ctx, 'sessionController');
        if (typeof sc?.selectModel !== 'function') {
            return out(JSON.stringify({
                error: 'sessionController service unavailable (select_model needs the web profile session controller); '
                    + 'use agent_run with provider/model to run on another model instead',
            }));
        }
        try {
            const requested = reasoningEffort ? { provider, model, reasoningEffort } : { provider, model };
            const res = await sc.selectModel({ sessionId: asSessionId(sessionId), ...requested });
            const selected = res?.selected ?? requested;
            // 池 key 含模型: 切完要把该会话挪到新 key 下, 否则下次同模型调用会误开一个新会话
            rekeyPooledSession(sessionId, selected);
            return out(JSON.stringify({ ok: true, sessionId, selected: projectModel(selected) }));
        }
        catch (e) {
            return out(JSON.stringify({ error: `select_model failed: ${e?.message ?? String(e)}` }));
        }
    });
    // 给已有会话改名(走 sessionTitle 服务, 便于会话列表归档)
    mcp.tool('rename_session', '给已有会话改名(走 sessionTitle 服务的 rename), 便于会话列表归档区分。', {
        sessionId: z.string().describe('要改名的会话 id(来自 agent_run 结果里的 sessionId 字段)'),
        title: z.string().describe('新标题'),
    }, async ({ sessionId, title }) => {
        try {
            const sessions = ctx.get('sessions');
            const session = sessions?.get?.(sessionId);
            if (!session)
                return out(JSON.stringify({ error: `session not found: ${sessionId}` }));
            const st = ctx.get('sessionTitle');
            if (!st?.rename)
                return out(JSON.stringify({ error: 'sessionTitle service unavailable' }));
            const snapshot = st.rename(session, title);
            return out(JSON.stringify({ ok: true, sessionId, title: snapshot?.title ?? title }));
        }
        catch (e) {
            return out(JSON.stringify({ error: String(e) }));
        }
    });
    // 手动归组补给站: 官方 UI 没有"移动会话到工作区"功能, 本工具供随时归组
    mcp.tool('attach_session', '把会话归组到工作区(补给站: 官方 UI 无移动会话功能)。path 缺省用该会话 header 的 cwd; 归组依赖官方 attachSession 的强校验——realpath(header.cwd) 必须与工作区路径精确相等, 不匹配会返回官方报错。', {
        sessionId: z.string().describe('要归组的会话 id(live 或已持久化)'),
        path: z.string().optional().describe('目标工作区目录(缺省: 会话 header 的 cwd)'),
    }, async ({ sessionId, path }) => {
        const sid = asSessionId(sessionId);
        const header = await findSessionHeader(ctx, sid);
        if (header === undefined) {
            return out(JSON.stringify({ error: `session not found: ${sessionId}(live 与持久化里都没有)` }));
        }
        const target = path ?? header.cwd;
        if (target === undefined) {
            return out(JSON.stringify({ error: `session ${sessionId} 的 header 没有 cwd, 官方 attachSession 无法校验, 不能归组` }));
        }
        try {
            const canonical = await canonicalCwd(target); // 目录不存在时回退 resolve, 由官方校验给出明确报错
            const ws = await ensureWorkspace(ctx, canonical);
            if (!ws?.attachSession)
                return out(JSON.stringify({ error: 'workspaceRegistry unavailable' }));
            if (ws.sessionIds.includes(sid)) {
                return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: false, note: 'already attached' }));
            }
            await ws.attachSession(sid);
            return out(JSON.stringify({ sessionId, workspaceId: ws.id, workspacePath: ws.path, attached: true }));
        }
        catch (e) {
            return out(JSON.stringify({ error: `attach failed: ${e?.message ?? String(e)}` }));
        }
    });
}
/** GUI 路由前缀: /_dsh/dsh-ops-mcp/<method>, 与 bottom-info-bar 同约定 */
const WEB_ROUTE_PREFIX = '/_dsh/dsh-ops-mcp';
/** JSON 响应(GUI 路由) */
function webRespond(res, status, payload) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    res.end(body);
}
/** 变更类 GUI 路由的同源校验(sec-fetch-site / origin 对 host; curl 等无 Origin 客户端放行读) */
function sameOrigin(req) {
    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite === 'cross-site')
        return false;
    const origin = req.headers.origin;
    if (origin === undefined)
        return fetchSite === 'same-origin' || fetchSite === 'same-site';
    const host = req.headers.host;
    if (host === undefined)
        return false;
    try {
        const parsed = new URL(origin);
        return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.host === host;
    }
    catch {
        return false;
    }
}
/** 读 GUI 路由请求体(限字节; 超限 413) */
function webReadBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
                const err = new Error('body too large');
                err.status = 413;
                reject(err);
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
// ── HTTP 层(认证 / Host 校验 / 路由) ──
/** JSON-RPC 错误响应体 */
function jsonrpcError(code, message) {
    return JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null });
}
/** Bearer token 常数时间比较(长度不等直接拒, 相等走 timingSafeEqual) */
function bearerOk(req) {
    if (!runtimeConfig.authToken)
        return true;
    const got = Buffer.from(String(req.headers['authorization'] ?? ''), 'utf8');
    const want = Buffer.from(`Bearer ${runtimeConfig.authToken}`, 'utf8');
    return got.length === want.length && timingSafeEqual(got, want);
}
/** 从 Host 头提取主机名(去端口; '[::1]:8090' → '::1') */
function hostnameOf(hostHeader) {
    if (hostHeader.startsWith('[')) {
        const end = hostHeader.indexOf(']');
        return hostHeader.slice(1, end === -1 ? undefined : end).toLowerCase();
    }
    const colon = hostHeader.indexOf(':');
    return (colon === -1 ? hostHeader : hostHeader.slice(0, colon)).toLowerCase();
}
/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 dsh 能力。
 */
export async function apply(ctx, config = {}) {
    // 每次应用都从 config 重建运行时配置(不跨次泄漏; workspaceRoots 预 resolve)
    runtimeConfig = {
        provider: config.provider ?? DEFAULTS.provider,
        model: config.model ?? DEFAULTS.model,
        reasoningEffort: config.reasoningEffort ?? DEFAULTS.reasoningEffort,
        allowModelOverride: config.allowModelOverride ?? DEFAULTS.allowModelOverride,
        preset: config.preset ?? DEFAULTS.preset,
        maxQueue: config.maxQueue ?? DEFAULTS.maxQueue,
        taskTtlMs: config.taskTtlMs ?? DEFAULTS.taskTtlMs,
        maxAgents: config.maxAgents ?? DEFAULTS.maxAgents,
        authToken: config.authToken ?? DEFAULTS.authToken,
        workspaceRoots: (config.workspaceRoots ?? []).map((r) => resolve(r)),
        defaultDetail: config.defaultDetail ?? DEFAULTS.defaultDetail,
    };
    const port = config.port ?? 8090;
    // 安全默认: 仅监听本机。暴露公网/局域网前必须自行加认证+反代+TLS(见 README 警告)
    const host = config.host ?? '127.0.0.1';
    // Host 头白名单: 绑定地址 + loopback 别名 + 显式 allowedHosts(防 DNS rebinding: 恶意网页把
    // 自己域名 rebinding 到 127.0.0.1 后, Host 头仍是该域名 → 拒)
    const allowedHostSet = new Set();
    for (const h of [host, 'localhost', '127.0.0.1', '::1', ...(config.allowedHosts ?? [])]) {
        allowedHostSet.add(h.toLowerCase());
    }
    // 存量捞回(默认关闭): 0.1.5 的 workspaceRegistry 已按 header.cwd 自动索引, 该操作只是给手动花名册
    // 补条目——会对用户数据做批量持久化写入, 仅在明确需要时开启。
    if (config.reattachOrphans === true) {
        void (async () => {
            try {
                const r = await reattachOrphanSessions(ctx);
                console.log(`[dsh-ops-mcp] 存量捞回完成: attached=${r.attached} failed=${r.failed}`);
            }
            catch (e) {
                console.warn('[dsh-ops-mcp] 存量捞回异常:', e?.message ?? e);
            }
        })();
    }
    // 标准 cordis 生命周期: 用 ctx.effect 注册清理(卸载时关 server + 清空全部映射/会话/队列)
    ctx.effect(() => {
        return () => {
            liveAgents.clear();
            sessionToPoolKey.clear();
            agentLocks.clear();
            taskQueue.clear();
        };
    }, 'dsh-ops-mcp');
    // ── MCP server 观测与软停启(http:false 时仅保留 GUI 控制面) ──
    const startedAt = Date.now();
    /** MCP 连接登记(sessionId → 观测记录); GUI 面板与 status RPC 的数据源, apply 级生命周期 */
    const connections = new Map();
    const servers = new Map();
    const transports = new Map();
    let server;
    let listening = false;
    /** 监听一次(可重复调用): 端口被占/EADDRNOTAVAIL 时抛错, 调用方决定是否致命 */
    const listenOnce = () => new Promise((resolveListen, rejectListen) => {
        const s = server;
        if (s === undefined) {
            rejectListen(new Error('server not created (http disabled?)'));
            return;
        }
        const onListenError = (e) => {
            s.off('listening', onListening);
            rejectListen(new Error(`cannot listen on ${host}:${port}: ${e.message}`));
        };
        const onListening = () => {
            s.off('error', onListenError);
            resolveListen();
        };
        s.once('error', onListenError);
        s.once('listening', onListening);
        s.listen(port, host);
    });
    /** 状态快照: 版本/监听/配置摘要/运行指标/活跃连接(GUI 面板与 status RPC 同一数据源) */
    const statusSnapshot = () => {
        let queueActive = 0;
        let queueDone = 0;
        let queueError = 0;
        for (const t of taskQueue.values()) {
            if (t.status === 'queued' || t.status === 'running')
                queueActive++;
            else if (t.status === 'done')
                queueDone++;
            else
                queueError++;
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
                authEnabled: runtimeConfig.authToken !== '',
                workspaceRoots: runtimeConfig.workspaceRoots,
            },
            stats: {
                liveAgents: liveAgents.size,
                queue: { active: queueActive, done: queueDone, error: queueError },
                connections: connections.size,
            },
            connections: Array.from(connections.values(), (c) => ({ ...c })),
        };
    };
    /** 软停止: 关监听 + 切断全部连接/transport。不卸载插件行——GUI 控制面(3080)仍在, 可再启动 */
    async function stopMcpServer() {
        const s = server;
        if (s === undefined || !listening)
            return { stopped: true };
        listening = false;
        s.close();
        // 同步切断遗留 keep-alive/SSE 连接, 端口释放不依赖对端空闲超时
        s.closeAllConnections?.();
        for (const transport of transports.values()) {
            try {
                void transport.close();
            }
            catch { /* 尽力清理 */ }
        }
        transports.clear();
        servers.clear();
        connections.clear();
        console.log(`[dsh-ops-mcp] MCP server stopped (soft stop, ${host}:${port})`);
        return { stopped: true };
    }
    /** 软启动: 重新监听同端口(端口被占时返回错误而不抛) */
    async function startMcpServer() {
        if (config.http === false)
            return { started: false, error: 'http disabled by config' };
        if (listening)
            return { started: true };
        try {
            await listenOnce();
            listening = true;
            console.log(`[dsh-ops-mcp] MCP server listening on ${host}:${port}/mcp (soft start)`);
            return { started: true };
        }
        catch (e) {
            return { started: false, error: e?.message ?? String(e) };
        }
    }
    // ── GUI 控制面: webServer 路由 /_dsh/dsh-ops-mcp/<method>(设置页面板的数据/操作后端) ──
    const WEB_ROUTES = {
        status: () => statusSnapshot(),
        stop: () => stopMcpServer(),
        start: () => startMcpServer(),
    };
    const WEB_MUTATING = new Set(['stop', 'start']);
    ctx.inject(['webServer'], (webCtx) => {
        const webServer = webCtx.webServer;
        webCtx.effect(() => {
            const dispose = webServer.register({
                kind: 'prefix',
                path: WEB_ROUTE_PREFIX,
                handler: async (req, res) => {
                    try {
                        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
                        if (!path.startsWith(`${WEB_ROUTE_PREFIX}/`)) {
                            webRespond(res, 404, { error: 'not found' });
                            return;
                        }
                        const method = decodeURIComponent(path.slice(WEB_ROUTE_PREFIX.length + 1));
                        const fn = Object.hasOwn(WEB_ROUTES, method) ? WEB_ROUTES[method] : undefined;
                        if (typeof fn !== 'function') {
                            webRespond(res, 404, { error: `unknown method: ${method}` });
                            return;
                        }
                        // 变更类方法要求同源(GUI 按钮发起; 防 CSRF 式启停)
                        if (WEB_MUTATING.has(method) && !sameOrigin(req)) {
                            webRespond(res, 403, { error: 'cross-origin request rejected' });
                            return;
                        }
                        // 读 body(仅为了消费流, 方法本身无参; 限 64k 防滥用)
                        if (req.method === 'POST' || req.method === 'PUT')
                            await webReadBody(req, 64 * 1024);
                        webRespond(res, 200, await fn());
                    }
                    catch (e) {
                        const status = e?.status ?? 500;
                        webRespond(res, status, { error: status === 500 ? 'internal error' : String(e?.message ?? e) });
                    }
                },
            });
            return () => { dispose(); };
        }, 'dsh-ops-mcp: web routes');
    });
    // http: false 显式关闭 MCP 监听(GUI 控制面仍可用: 面板显示"未监听", 可看配置但不可启动)
    if (config.http === false) {
        console.log('[dsh-ops-mcp] http disabled by config, MCP server not started (web panel still available)');
        return;
    }
    server = http.createServer(async (req, res) => {
        // Bearer token 认证(配置了 authToken 时强制所有请求校验, 常数时间比较)
        if (!bearerOk(req)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(jsonrpcError(-32001, 'Unauthorized'));
            return;
        }
        // Host 头校验(防 DNS rebinding; HTTP/1.1 必有 Host, 缺失视为非法请求)
        const hostHeader = req.headers.host;
        if (hostHeader === undefined) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(jsonrpcError(-32600, 'Missing Host header'));
            return;
        }
        if (!allowedHostSet.has(hostnameOf(hostHeader))) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(jsonrpcError(-32001, `Host not allowed: ${hostnameOf(hostHeader)}`));
            return;
        }
        // 只服务 /mcp 端点, 其余路径 404(不给扫描器留面)
        const pathname = (req.url ?? '').split('?')[0] ?? '';
        if (pathname !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(jsonrpcError(-32601, `Not found: ${pathname}`));
            return;
        }
        const sessionId = req.headers['mcp-session-id'] ?? undefined;
        // 连接观测: 每个带会话头的请求都记一次活跃(连接身份以 User-Agent 识别)
        if (sessionId) {
            const c = connections.get(sessionId);
            if (c) {
                c.lastActivity = Date.now();
                c.requests++;
                const ua = String(req.headers['user-agent'] ?? '');
                if (ua && !c.userAgent)
                    c.userAgent = ua;
            }
        }
        const existing = sessionId ? transports.get(sessionId) : undefined;
        // 已有 session: GET/POST/DELETE 都路由到对应 transport(支持 SSE 流 + 会话终止)
        if (existing) {
            if (req.method === 'GET' || req.method === 'POST' || req.method === 'DELETE') {
                await existing.handleRequest(req, res);
                return;
            }
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(jsonrpcError(-32600, 'Method not allowed'));
            return;
        }
        // 新 session 初始化(仅 POST 且无 session id)
        if (req.method === 'POST' && !sessionId) {
            const mcp = new McpServer({ name, version: PLUGIN_VERSION });
            registerTools(mcp, ctx);
            const initUserAgent = String(req.headers['user-agent'] ?? '');
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => randomUUID(),
                onsessioninitialized: (sid) => {
                    transports.set(sid, transport);
                    servers.set(sid, mcp);
                    // 连接登记: 首个 initialize 请求的 User-Agent 即客户端身份
                    connections.set(sid, {
                        sessionId: sid,
                        connectedAt: Date.now(),
                        lastActivity: Date.now(),
                        userAgent: initUserAgent,
                        requests: 1,
                    });
                },
            });
            // 会话关闭时清理映射(避免临时 key 泄漏 + 无效会话累积)
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid) {
                    transports.delete(sid);
                    servers.delete(sid);
                    connections.delete(sid);
                }
            };
            await mcp.connect(transport);
            await transport.handleRequest(req, res);
            return;
        }
        // 未知 session → 404(不新建 transport, 避免遗留对象)
        if (sessionId) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(jsonrpcError(-32001, 'Session not found'));
            return;
        }
        // 无 session 的非初始化请求 → 400
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(jsonrpcError(-32600, 'Invalid request'));
    });
    // 等待 listen 完成: 端口被占/EADDRNOTAVAIL 时 apply 直接抛错, 插件启动失败可见(不再静默成功)
    await listenOnce();
    listening = true;
    console.log(`[dsh-ops-mcp] MCP server listening on ${host}:${port}/mcp`);
    // 运行期错误(如 socket 异常)记日志不崩进程
    server.on('error', (e) => {
        console.error('[dsh-ops-mcp] HTTP server error:', e.message);
    });
    // 卸载时关 server + 清空 transport/server/连接映射(与上面的池/队列清理同属一个 effect 链)
    ctx.effect(() => {
        return () => {
            server?.close();
            // 热重载确定性: HMR 换新实例卸旧 fiber 时同步切断遗留 keep-alive/SSE 连接,
            // 8090 的释放不依赖对端空闲超时; 进行中的请求被 reset(dev 形态可接受)
            server?.closeAllConnections?.();
            for (const transport of transports.values()) {
                try {
                    void transport.close();
                }
                catch { /* 尽力清理 */ }
            }
            transports.clear();
            servers.clear();
            connections.clear();
        };
    }, 'dsh-ops-mcp');
}
//# sourceMappingURL=index.js.map