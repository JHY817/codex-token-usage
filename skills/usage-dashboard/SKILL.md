---
name: usage-dashboard
description: 打开或查询 Codex 本地 Token 使用洞察，包括模型、思考档位、对话、子任务、工具调用、缓存和时间趋势。
---

# Codex 使用洞察

当用户要“打开、查看、展示”Token 看板时，调用 `open_usage_dashboard`。默认周期为 `today`；明确提到最近一周、一个月或累计历史时，分别使用 `7d`、`30d` 或 `all`。累计范围覆盖当前仍保留的本机会话日志，并通过 SQLite rollout 文件索引增量更新。

当用户只问一个简短的用量问题、不需要可视化时，调用 `get_usage_summary`，可将 `range` 设为 `all` 查询累计摘要。

当用户询问某个具体任务的累计 Token，或要比较该任务不同模型与思考档位的今日、累计消耗时，调用 `get_conversation_usage_detail` 并传入任务的 `conversationId`。该结果会按任务 ID 合并今日与累计的模型归因；累计只覆盖当前仍保留的本机会话日志。

当需要为一个任务列表补齐累计 Token 时，调用 `get_conversation_usage_totals` 并一次传入最多 20 个 `conversationIds`，不要逐个调用详情工具。未知任务的累计值返回 0。

不要把本地归因值描述成账单或官方账户日总量。模型和思考档位来自相邻的 `turn_context`，Token 来自本地 `token_count`；两者组合属于本地可验证归因。不要计算或展示美元费用。

系统审查和守护任务只能使用安全的汇总标题，不能把其原始提示内容作为对话标题返回。
