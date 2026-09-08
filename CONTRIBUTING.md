# Contributing

感谢你改进 Codex Token Usage。

## 本地开发

需要 macOS 13+、Xcode Command Line Tools、Node.js 22+，以及已安装并登录的 Codex。

```bash
npm install
npm --prefix ui install
npm run check
```

`npm run check` 会从干净目录构建 UI、执行服务端、前端与原生壳测试，并生成 MCP 前端包。提交代码前也运行同一命令：

```bash
npm run check
```

## 版本发布

维护者使用一个版本号作为唯一来源：

```bash
npm run release:prepare -- 0.2.0
git add .
git commit -m "release: v0.2.0"
git tag v0.2.0
git push origin main --follow-tags
```

`v*` 标签会触发 GitHub Actions，自动测试、构建 Apple Silicon 与 Intel 安装包并创建 GitHub Release。

## 数据与隐私

不要在 Issue、PR、截图或测试样本中提交真实提示词、回复、账户标识、完整本机路径、Token、Cookie 或密钥。测试只使用合成的 rollout 事件。
