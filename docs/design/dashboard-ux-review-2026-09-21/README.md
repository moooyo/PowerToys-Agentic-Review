# Dashboard UI/UX 评审与交互原型

基于当前提交 `238b1c3` 的现行 Dashboard 源码，以及仓库保留的 2026-09-20 生产构建合成数据截图。产品界面沿用英文与 Material 色彩体系，评审说明使用中文。

- [打开完整交互原型](index.html)：可直接在浏览器打开，无需安装依赖或启动后端。
- [阅读评审报告](REVIEW.md)：7 项 P2/P3 发现、源码依据、改进优先级与后续验收标准。
- [检查本次交付验证](VALIDATION.md)：原型验证范围及尚未验证的产品行为。

## 原型范围

覆盖现行 10 个目的地与登录页：Pull requests、Issues、Tasks、Reports、Comments、Webhook events、Repositories、Workers、Accounts、My account、Sign in。没有额外虚构一个数据总览首页。

顶部“流程地图”可以直接进入各条任务路径；角色和状态选项属于原型评审工具，不建议作为产品 UI 实现。

| 入口 | 可体验的流程 |
| --- | --- |
| Pull requests / Issues | 搜索和筛选、返回保留条件、全局仓库范围、来源概览/调查/讨论、快照、模拟导入、创建调查与 Issue SHA 校验 |
| Tasks | 运行/中断/阻塞、进度/证据/详情、输出检索与类型筛选、attempt、跟随暂停、导出、取消与等待清理、提高预算后恢复 |
| Reports | 目录、Findings/Evidence/Details、完整集合搜索与优先级筛选、25 条数据分页、跨页选择、独立反馈草稿、JSON 导出 |
| Action | 选择操作、精确预览、独立确认、P0 阻止 Approve、只准备角色、过期来源、冲突、未知结果检查原 intent |
| Comments / Webhooks | 列表与详情、保留正文/历史、始终可见完整筛选、投递核对、同步预览、事件处理恢复、关联 Task 与评论 |
| Workers | 联系状态、E2E 准入、有效能力、停用确认、保留 ownership、等待清理、合成清理回执 |
| Repositories | Overview / Intake / Replies / Scheduling、保存/丢弃草稿、冲突对照、模板预览、全局并发设置 |
| Accounts / My account | 创建/编辑、独立仓库与动作权限、停用、重设密码、修改密码、会话返回登录 |
| 全局 | 加载/错误/空/无权限场景、角色切换、主题、Ctrl/Cmd+K、未保存离开保护、窄屏布局 |

所有业务操作均为合成数据的本地状态变化；页面不会发送 API、GitHub 或 Worker 请求。原型的登录不是认证机制，权限选项不是安全边界，示例 receipt 不是生产执行凭证。文件刷新会重置所有模拟状态。

## 建议体验顺序

1. 在 PR 列表搜索 `settings` → 打开记录 → 返回筛选结果，观察搜索和范围保留。
2. 流程地图 → `26 findings → off-page P0` → 定位 P0 → 清掉优先级筛选 → 下一页；勾选与草稿跨页保留，Approve 始终受完整集合约束。
3. 编辑反馈并保存 → Prepare action → 填写内容 → Prepare exact preview → 检查目标、来源和精确内容 → 单独确认。将顶部状态切为“提交结果未知”体验原 intent 恢复。
4. 流程地图 → `Interrupted → raise budget → resume`；不增加耗尽预算会收到校验提示。
5. Comments → More filters；Worker 停用 E2E 后刷新，观察等待清理不会变成成功。
6. 切换只读/只准备角色、加载失败、版本冲突与窄窗口，检查异常和权限路径。

## 设计重点与后续实现

- 保留现有 Review / Tasks / Activity / Workspace 分组，增加一致的仓库范围入口。
- 使用“执行 / 报告 / 交付 / 验证”明确的语义标签，不用单个绿色成功状态概括整个流程。
- 减少报告顶部的重复信息；手机改用可选择的 finding 目录，避免先滚过完整 25 条目录。
- 完整集合搜索/筛选是设计提案。接入生产时应扩展分页 API/read model，不能只过滤客户端已加载的一页。合成原型内的 26 条数据已全量保留。
- 管理表格在窄屏可横向滚动；核心审阅流程会自动堆叠。原型外层由对话或浏览器滚动，正式产品可继续使用现有滚动容器。
- 控制尺寸、权限矩阵、服务端幂等与版本校验仍须按生产契约实现；本次未修改 `apps/dashboard`。

## 修改原型

| 文件 | 用途 |
| --- | --- |
| `shell.html` | 原型工具条、应用外壳、主导航、仓库入口与对话框容器 |
| `prototype.css` | Material 颜色、字级、间距、组件与响应式布局 |
| `core.js` | PR / Issue / Task / Report 页面、导航、全局状态与动作流程 |
| `operations.js` | 评论、Webhook、Worker、仓库和账户流程 |
| `compose.mjs` | 将源文件拼接为独立页面和对话内片段；不编译或构建应用 |
| `index.html` | 已生成的完整独立原型，可直接打开 |
| `prototype.fragment.html` | 已生成的对话内预览片段 |

修改源文件后，可运行 `node docs/design/dashboard-ux-review-2026-09-21/compose.mjs` 重新拼接静态原型。无需 package install、产品 build 或任何真实服务。
