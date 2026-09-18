# Codex 会话状态桥

菜单栏角标的实时状态优先读取 Codex App Server 的结构化事件；如果宿主没有开放 App Server Socket，则自动回退到本地 rollout 扫描器。

## 状态优先级

```text
等待批准 / 等待用户输入 > 执行中 > 刚完成 > 空闲
```

状态桥只保留 `threadId`、状态、状态时间和待处理请求 ID，不保存提示词、回复内容、标题或文件路径。

## 连接方式

桥接层会自动查找：

1. `CODEX_APP_SERVER_SOCKET` 指定的 Unix Socket；
2. `$CODEX_HOME/app-server-control/app-server-control.sock`。

找到 Socket 后，使用 `codex app-server proxy` 建立 JSON-RPC 连接，并读取 `thread/status/changed`、审批请求、用户输入请求和 turn 生命周期事件。

当前 ChatGPT 桌面版本使用私有的 stdio/IPC 实例，通常不会暴露上述 Socket。因此当前版本仍会安全地使用 rollout 扫描器；不能通过启动另一个独立 App Server 来获得现有桌面会话的实时状态。

## 可选配置

```bash
export CODEX_APP_SERVER_SOCKET=/absolute/path/to/app-server-control.sock
export CODEX_STATUS_BRIDGE_RECONNECT_MS=5000
export CODEX_STATUS_BRIDGE_DISCOVERY_MS=15000
```

如果关闭桥接层：

```bash
export CODEX_USAGE_STATUS_BRIDGE=off
```

关闭后不会影响 Token 看板和 rollout 扫描器。

## 影响与边界

- 增加一个本机 `codex app-server proxy` 子进程和一条长连接；没有可用 Socket 时不会启动。
- App Server 协议升级时需要同步维护事件解析；未知事件会被忽略，不会阻断看板。
- 连接中断时自动回退到 rollout 扫描器，不会把不确定状态显示成黄色。
- rollout 回退不是实时心跳：明确收到 `task_started` 且尚无完成事件时，连续无新事件最长保留 30 分钟执行状态；只有模糊文件活动时保留 5 分钟。正常 `task_complete` 会立即结束执行状态；异常退出且缺少完成事件时，蓝色可能延迟消失。
- WebSocket 不作为默认传输；本地优先使用 Unix Socket，避免开放网络端口。
