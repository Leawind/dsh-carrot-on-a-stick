# Changelog

开发期间的改动批次记录在 Unreleased 下，发布时整理为版本条目。

## Unreleased

## 0.1.0-rc.1 (2026-10-02)

首个发布版本（预发布档）。

-   MCP 工具 17 个：`dsh_get_started` 入门指南 / `echo` 连通性 / `dsh_status` 状态 / `dsh_list_tools` 宿主工具列举 / `workspace_list` / `model_list` + `select_model` / `agent_run` 同步执行（进度心跳、可取消、按调用覆盖 provider/model/reasoningEffort/preset）/ `agent_steer` 实时干预 / 异步队列 `task_inbox` / `task_result` / `task_list` / `task_cancel`（幂等键去重）/ 会话面 `session_list` / `session_history`（`roles` 过滤）/ `attach_session` / `rename_session`
-   MCP resources + SSE 订阅：status / guide / tools / models / presets / workspaces / sessions / history / events / activity / queue / agents；`resourceFirst` 形态可选（只读工具下线，结果以资源引用返回）
-   安全：默认仅监听 `127.0.0.1`、Bearer 认证、Host/Origin 白名单（防 DNS rebinding）、`workspaceRoots` 目录白名单（同时约束执行与会话读取）、空闲传输会话按 TTL 回收
-   队列持久化：可选落盘 + 口令加密，重启后已完成结果可取回、排队任务重新执行、执行中如实标记被打断
-   Web 设置面板：向 dsh Web UI 注入设置区（状态徽章、端点复制、软停启、连接中的 MCP 客户端列表）
-   兼容宿主 dsh 0.1.5+，已在 0.2.0-rc.2 真机 e2e 验证
