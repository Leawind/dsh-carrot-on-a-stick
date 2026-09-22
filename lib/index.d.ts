/**
 * dsh-ops-mcp — 在 Harness 内部启动 MCP server, 把 dsh 的操作能力暴露给任意 MCP 客户端。
 *
 * 工具集:
 *   - echo             : 验证 MCP server 连通
 *   - dsh_list_tools   : 列出 dsh 工具注册表(name + description)
 *   - agent_run        : 同步执行任务(改代码/分析/跑命令), 返回结构化结果
 *   - task_inbox       : 调用方 push 结构化任务(任务+上下文)到 dsh 队列, 异步执行, 返回 taskId
 *   - task_result      : 取回任务的结构化结果(changes/verification/leftovers)
 *   - attach_session   : 把会话归组到其 cwd 对应的工作区(手动补给站)
 *   - rename_session   : 给已有会话改名
 *
 * sessionId 续接: 指定 sessionId 时按 本进程池 → live 会话(UI 手开)→ 持久化 resume 三级接管,
 * 前两者都找不到才报错, 所以进程重启前/UI 手开的会话也能续接。
 * 工作区分组: cwd 先 realpath 规范化再 `workspaceRegistry.resolveByPath ?? create` + attachSession;
 * 启动时对存量未分组会话补挂一次(存量捞回)。
 *
 * ── 零宿主副本原则 ──
 * 运行时对 `@deepseek-ai/*` 零依赖: 所有 dsh 能力都经注入的宿主服务(ctx.agents/ctx.tools/…)访问,
 * 类型只做编译期声明合并(import type, 构建后擦除)。这样插件自带的新旧依赖副本永远不会与
 * 宿主进程内的私有 Symbol/类标识错位(上游 0.1.x 时代 scopeOf 副本不匹配导致 agent 无工具的根因)。
 *
 * 回路: 调用方上下文 →(context)→ task_inbox → dsh agent 执行 → 结果进队列 → task_result → 调用方持久化
 */
import type { Context } from '@deepseek-ai/cordis';
/** Cordis 插件名 */
export declare const name = "dsh-ops-mcp";
/**
 * 声明依赖的核心服务。
 * workspaceRegistry/sessionPersistence/sessions 是续接/归组三个增量用到的服务——
 * 漏声明会在真实启动时拿不到服务(本插件曾经踩过, 务必与代码里的 ctx.get 对齐)。
 */
export declare const inject: string[];
/** 插件配置 */
export interface Config {
    /** 是否启动 HTTP MCP server(默认 true; 显式 false 时不监听, 仅保留生命周期钩子) */
    http?: boolean;
    port?: number;
    host?: string;
    /** 后端 provider(默认 deepseek-official) */
    provider?: string;
    /** 执行任务的模型(空/缺省 = 跟随 dsh 用户/默认设置) */
    model?: string;
    /** 挂载的 agent preset(默认 standard) */
    preset?: string;
    /** 任务队列容量上限(默认 100) */
    maxQueue?: number;
    /** 已完成任务保留毫秒数(默认 10 分钟) */
    taskTtlMs?: number;
    /** 常驻 agent 会话上限(默认 8, LRU 淘汰) */
    maxAgents?: number;
    /** Bearer token 认证(设置后所有请求必须带 Authorization: Bearer <token>, 常数时间比较) */
    authToken?: string;
    /** cwd 白名单(设置后 agent 只能在列出的目录下干活; 跨平台分隔符/大小写安全) */
    workspaceRoots?: string[];
    /** Host 头白名单(除绑定地址与 loopback 别名外额外放行的主机名; 对外暴露时按需配置) */
    allowedHosts?: string[];
}
/**
 * 插件入口: 启动 MCP server(StreamableHTTP, 跨网), 通过 ctx 桥接 dsh 能力。
 */
export declare function apply(ctx: Context, config?: Config): Promise<void>;
//# sourceMappingURL=index.d.ts.map