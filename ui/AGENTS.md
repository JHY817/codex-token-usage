# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

## 持久反馈

- 模型 Token、任务列表当前周期/累计 Token、任务详情今日/累计 Token 后展示小号“缓存 xx.x%”；按对应范围汇总缓存输入 Token / 输入 Token，不能平均各记录百分比或称为请求命中率。缺失数据或零分母显示“缓存 —”，说明通过 title 提供，窄屏允许换行，不截断 Token 或缓存值。

- Web 主页采用浅色 macOS 轻量纯色界面：实色浅灰窗口背景、白色卡片、细边框与弱阴影；不使用泛白毛玻璃或 `backdrop-filter`。原生窗口由 native 侧单独保持一致。
- 主列表关注今日任务及其消耗，不做项目汇总；项目仅作为辅助标签。
- 任务进度只能来自可验证的计划或状态事件；没有证据时不推算百分比。
- 以最新确认稿为视觉真值，保持趋势图、模型构成和今日任务表格的布局层级。
- 菜单栏保留 Codex 图标和剩余百分比，不增加计量轨道；Web 摘要使用实色白卡片。
- 主图 hover/click 摘要通过 body portal + fixed 定位呈现，在窗口范围内翻转与夹紧，不能被图表或分栏容器裁切。
- 摘要与详情展示完整的非零模型与思考档位列表，不合并成不透明的“其他模型”；采用相同稳定配色和万 Token 单位，列表自然撑开，不加内部滚动条。
- 账户 credits 无真实数值时，隐藏其卡片与切换入口；任务今日与累计 credits 独立判断，仅展示实际返回的数值，累计估计值标明估计。
- 详情图表支持悬浮摘要与点击固定；详情打开时置前但不永久 floating。

## 2026-09-07 已确认组合

- 主界面真值：`../docs/REDESIGN-2026-09-07-02.png`。顶部并列 credits / Token / 剩余额度，中部左趋势右模型用量，下方任务表。
- 摘要真值：`../docs/REDESIGN-2026-09-07-01.png` 右侧面板。额度、今日 credits 与 Token、模型 Token 横条、刷新与打开详情。
- 趋势和右侧模型用量共享 Token / Credits 切换；时间粒度必须符合真实来源，不伪造小时级 credits。
- 任务图标使用统一的图标库对话图标，替换终端字符；不根据标题猜测不同业务图标。
- 任务详情保留今日/累计 Token，增加今日/累计 credits 卡及模型 × 思考档位条形对比。
- credits 仅展示来源返回的数据；未知为 null/暂不可用，不当作 0，不按 Token 换算。任务接口若只返回累计估计值，必须标明估计，不能当作完整今日消耗。
- Token 本机日志口径与官方套餐额度分开说明；无总额度真值时不显示虚构分母。
