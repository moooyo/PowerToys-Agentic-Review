# Material 3 · 新版 Dashboard 交互原型

后续代码已按本最终稿落实到 `apps/dashboard`，见 [代码落地与验证](IMPLEMENTATION.md)。下文保留当时仅设计和原型迭代的范围记录。

当前为 **M3 / 06，更新于2026-09-22**。本轮继续 loop，修正草稿与报告选择、字段错误、焦点、权限及 Follow-up 子任务衔接，最终复审未发现本轮范围内的新可执行问题。仍只修改设计与原型。M3 / 05 预览保存在 [history/m3-05-preview.zip](history/m3-05-preview.zip)，其余旧版本保留在 history；最初原型保留在 [dashboard-ux-review-2026-09-21](../dashboard-ux-review-2026-09-21/README.md)。

- [新版交互原型](index.html)
- [按最终设计落地的 Dashboard 代码与验证](IMPLEMENTATION.md)
- [M3 / 06：loop 发现、修正、退出依据与验证](LOOP-REVIEW.md)
- [M3 / 05：逐 finding 发表流程、动作边界与验证](PUBLICATION-REVIEW.md)
- [M3 / 04：结论、GitHub 入口、行动规则与验证](DECISION-REVIEW.md)
- [设计规则与官方依据](DESIGN.md)
- [逐轮评审、修改与复查](ITERATIONS.md)
- [本轮功能变化与产品落地影响](FUNCTIONAL-CHANGES.md)
- [M3 / 03 验证结果与证据边界](VALIDATION-2026-09-22.md)
- [上一轮验证记录](VALIDATION.md)

原型覆盖 Pull requests、Issues、Tasks、Reports、Comments、Webhook events、Workers、Repositories、Accounts、My account 和登录。界面沿用产品英文，设计文档使用中文。

顶部“原型设置”可切换角色、加载/空/失败/陈旧数据/冲突/未知结果等状态；“流程地图”直达关键路径。应用顶部提供仓库范围、搜索、明暗切换及账户入口。所有业务操作仅使用本地合成数据。

## 主要改善

- 发布选择与报告勾选分开；错误可定位到具体字段并保持稳定名称；局部操作保留焦点。回执可回看，相同内容再次发表有明确提示。
- Follow-up 建立可查看的独立排队 Task，保留正确 SHA、父报告和原结果队列；权限变更与未知提交核对保持一致。
- Request changes 从选择 findings 开始；有效保存建议默认作为 Suggested change，逐条编辑正文与代码，一次预览整份 review。
- Approve、review comments、conversation comment、Close、Merge、CI、Follow-up 各自保持草稿与确切效果；失效建议、未知回执和具体权限均有对应处理。
- 来源、Task、Report、Comment 和 Webhook 详情提供 GitHub PR / Issue 入口；合成目标明确标记。
- 结论、验证缺口和建议下一步前置；列表直接显示结论。推荐动作保留精确预览、独立确认和具体权限检查。
- 连续审阅队列跨Source / Task / Report保留原结果、页码与原行焦点；视图URL可恢复finding、attempt及允许的筛选状态。
- 报告按结论、建议、依据排列；末尾保存当前私稿并进入下一项；完整已选集合可集中复核与逐项移除。
- 准备正文检测选中反馈的变化，重新生成需明确确认；跨账号只能看到他人未决动作的状态摘要。
- Task默认最新attempt；取消等待仍可见，清理回执、当前任务状态和旧报告保持独立。
- 恢复流程区分检查、重发与新重试；保留尝试历史；无净变化不触发保存或版本增加。

- M3 语义色彩、清晰交互边界、状态层、字级、形状和单一 SVG 图标系统。
- 来源单行入口、保留上下文的返回、键盘焦点恢复和具体字段错误。
- 首次加载失败与刷新失败分开；保留可读旧数据并约束需要最新状态的操作。
- 报告完整集合检索、P0 定位、独立草稿、精确来源预览与可恢复的未知提交。
- 窄屏完整筛选采用渐进展开；表格按标签重排，重要动作仍可达。
- 账户 grants 与实际动作一致，会话转换清理私有草稿，Worker/事件/评论状态保持独立。

## 后续修改

| 源文件 | 内容 |
| --- | --- |
| shell.html | 外壳、M3 rail、仓库、工具条和对话框容器 |
| prototype.css | 继承的基础组件结构与响应式规则 |
| material3.css | 最终 M3 token、状态、尺寸、响应式优化，覆盖基础层 |
| workflow.css | 连续审阅、正文优先、队列和反馈面板的组件布局 |
| outcome.css | 保存结论、当前下一步、GitHub 来源链接和响应式层级 |
| publication.js / publication.css | 逐 finding 选择、发送方式、编辑、精确预览及各动作独立流程 |
| followup.js | 独立的合成 Follow-up Task、来源绑定、列表与只读进度 |
| core.js | 来源、任务、报告、导航、全局状态与动作流程 |
| operations.js | 评论、事件、Worker、仓库、账户与登录 |
| vendor/lucide.min.js | 本机已有的 Lucide 1.8.0，仅独立页面内嵌，许可证同目录 |
| compose.mjs | 拼接静态原型，不是产品 build，无依赖安装 |

修改后执行 `node docs/design/dashboard-m3-iteration-2026-09-21/compose.mjs` 更新 `index.html` 和 `prototype.fragment.html`。独立版本内嵌图标，对话内片段使用宿主 Lucide。没有业务API调用；刷新恢复URL中的视图状态，模拟操作和私稿不会跨刷新保存。复制链接不会包含密码、正文或Action payload。

产品实现仍以实际 API、授权、幂等与执行协议为准。没有真实媒体字节的 evidence 明确显示不可用。本原型不是生产鉴权或运行验收。
