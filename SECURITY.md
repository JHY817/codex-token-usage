# Security Policy

## 支持范围

安全修复只保证覆盖最新 GitHub Release。

## 报告安全问题

请不要公开提交包含本地会话数据、账户信息或可复现密钥的 Issue。仓库启用后，请使用 GitHub 仓库的 **Security → Report a vulnerability** 私密报告入口。

Codex Token Usage 只读取本机 Codex 日志并监听 `127.0.0.1`。任何改变这一边界的修改都必须在 PR 中单独说明并经过审查。
