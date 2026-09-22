# Changelog

## 0.3.0

对齐 dsh 0.1.5-rc.2 的兼容性修复 + 安全加固 + 独立构建。详见 [docs/compat-review-upstream-0.1.10.zh.md](./docs/compat-review-upstream-0.1.10.zh.md)（修复依据）。

### 兼容性（对 dsh 0.1.5-rc.2）

- **移除 `scopeOf` 预检，直接调用 `ctx.agentPresets.mount`**：scope 校验交给宿主服务自身。
  旧预检在插件与宿主持有不同 `@deepseek-ai/dsh-scope` 副本时恒为假（模块私有 Symbol 不匹配），
  导致 preset 挂载被静默跳过、agent 变成无工具裸模型——本项目的头号问题。
- **运行时零 `@deepseek-ai/*` 依赖（“零宿主副本”原则）**：`createUserMessage` / `SessionId`
  改为本地等价实现（纯数据、深冻结、逐字段与宿主一致），`@deepseek-ai/*` 全部退为
  devDependencies（仅编译期类型）。插件从此不可能把新旧依赖副本混进宿主进程。
- `dsh_list_tools` 改走 `ctx.tools.schemas()`（0.1.5+），旧版 `keys()` 仅作回退；现在返回
  `name + description`。
- `sessionPersistence.list()` 兼容 0.1.5+ 的 `SessionPersistenceSnapshot[]`（header 在
  `.header` 字段）与旧版裸 header 两种形状——`attach_session` 与启动存量捞回对持久化会话恢复可用。
- 事件读取改走公开 API `session.snapshotEvents()`（私有 `log` 字段仅作旧宿主回退）。
- `workspaceRegistry` 侧核对确认：`resolveByPath ?? create` + `ws.attachSession` 在 0.1.5
  仍是官方姿势（与 `dsh-api-session-controller` 的 session.create 同款）。

### 修复

- **Windows 下 `workspaceRoots` 子目录匹配失效**：`startsWith(root + '/')` 遇反斜杠路径永远
  不匹配。改为跨平台 `isWithin`（双方 resolve、分隔符统一 `/`、win32 大小写折叠）。
- **`apply()` 现在等待 `listen` 完成**：端口被占用等监听失败会显式 reject，插件启动失败可见
  （旧行为是"成功"但 server 不存在）。

### 安全加固

- Bearer token 改为常数时间比较（`timingSafeEqual`，长度不等直接拒）。
- 新增 **Host 头白名单**（防 DNS rebinding）：默认放行绑定地址与 loopback 别名，可用
  `allowedHosts` 扩展；非白名单主机名 403，缺失 Host 400。
- HTTP 入口只服务 `/mcp`，其余路径 404。

### 工程

- **独立构建**：`tsconfig.json` 去掉对 deepseek-harness 仓库树的相对引用，`npm run build`
  （纯 `tsc`）即可产出 `lib/`；不再依赖 tsdown。
- `package.json`：新增 `exports`（支持 Node 自引用解析，`dsh --patch` 在仓库根目录直接可用）；
  运行时依赖只剩 `@modelcontextprotocol/sdk` + `zod`；版本对齐 devDeps（cordis 4.0.2、
  dsh-* 0.1.5-rc.2、typescript 5.9、@types/node）。
- 运行时配置每次 `apply` 重建，不再跨次泄漏。
- 卸载清理补全：transport 逐个 close。
- 冒烟测试扩到 24 项 + 端口冲突专项（`npm run smoke`）。

### 已知限制（未变）

- 任务队列在进程内存中，重启丢失；`agent_run` 无服务端超时/取消（调用方需自带 MCP 层超时）。
- spawn 出的会话里工具调用走宿主 approval 策略。
- 尚未在真实 `dsh web --patch` 环境做端到端验证（当前以接口核对 + 假 ctx 冒烟为准）。

## 0.2.0

初始独立版本（复制自 `chushixixin/dsh-harness-mcp-server` v0.1.10 并更名）。
