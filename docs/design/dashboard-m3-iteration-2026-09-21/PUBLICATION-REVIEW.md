# M3/05：发表评审流程与能力边界

后续 M3 / 06 的草稿选择隔离、字段错误、任务衔接与回执改进见 [LOOP-REVIEW.md](LOOP-REVIEW.md)。本文保留 M3 / 05 的设计与验证历史。

本轮只优化设计与交互原型，未修改 Dashboard 产品或服务端。实现入口为 [publication.js](publication.js)。所有 finding、修复代码、源绑定、回执和来源状态均为 **synthetic fixture**；点击确认不会向 GitHub 或 Worker 发送操作。

## 1. Request changes：先选择内容，再发表结论

流程为 **Select findings → Compose → Preview → Confirm Request changes**，只有最后一次确认表示提交意图。

- 逐条选择要发表的 finding，保留已有明确选择，不自动全选。Request changes 至少选择一条；“Select visible”是用户主动操作，并显示范围与隐藏的已选数量。
- Compose 为每条已选 finding 提供独立发表正文。有已保存替换代码的条目默认包含 suggested change，可编辑 replacement；文件、行范围、head SHA 和原内容绑定不能随意改写。
- 只有修复计划、没有已保存 replacement 的条目只能选择正文发表或移除，不能凭 prose 生成可应用建议。已保存建议的锚点失效时必须明确改为 summary text 或移除；不会自动降级、重定位或跳过。
- `Needs verification` 保留不确定性；发表意见、选择代码建议或收到回执均不把 finding 改为 Confirmed。缺失的运行验证也不会因发表而变成通过。
- 报告反馈后来变化时，用户选择 `Use latest feedback` 或 `Keep publishing text`，再继续预览；不会覆盖已编辑的发表正文。

Preview 展示实际目的地、总结、逐条建议与源绑定。**总结字段与普通 finding 正文只进入 summary 一次；带 suggestion 的正文只进入对应 inline comment 一次**，不会再重复拼入 summary。未选 finding 和私有报告草稿不发表。

## 2. 各动作保持独立含义与草稿

| 界面动作 | 最终内容与边界 |
| --- | --- |
| Request changes | 一份 `REQUEST_CHANGES` review，包含选中的正文及可用建议；至少一条 finding。 |
| Approve | 独立草稿，首次进入默认空总结、空选择；finding 与总结可选。原始报告完整集合中的已确认未解决 P0 仍阻止批准，取消勾选或换页不能消除限制。 |
| Review comments & suggestions | 对应后端 `suggestion-comment`，发表一份 `COMMENT` review，至少包含一条有效 suggested change；不隐含 Approve 或 Request changes。 |
| Conversation comment | 一条 PR/Issue 会话评论，纯文字；可包含明确选中的 finding 正文，不包含行内代码建议。 |
| Close | 只关闭来源；不评论、不合并、不删除分支。Issue 可选 Completed / Not planned。若要先说明，准备独立 Conversation comment。 |
| Merge | 独立合并方法与 payload；不附带 review、finding 正文或建议。合并条件按现有独立 guard 判断，不额外把 P0 变成统一 Merge 禁令。 |
| Run CI | 独立 workflow、ref、inputs；原型要求合法 workflow 文件名及当前评审 PR 的确切 commit。排队不表示检查通过。 |
| Run saved follow-up | 独立 task kind、保存计划引用与确切 source commit；计划、来源兼容性、执行权限及 Worker 准入分别检查。未就绪的 Feature draft 和已关闭来源不能启动该流程。 |

草稿按“来源＋动作”保存；切换动作不携带另一动作的正文或执行字段。权限继续按所选动作的现有规则判断，不因 Request changes 附带 suggestion 再增加一套额外审批。

关闭重复 Issue 需要独立 `close-as-duplicate` 动作和报告证据中已保存、可验证的另一 Issue 目标。本夹具没有这种保存判断，因此不展示任意填写号码即可关闭为重复项的流程。

## 3. 失效、未知与回执

来源变化、guard 过期、权限不足或建议锚点失效时保留草稿，说明需要修正的内容。准备与确认继续分开；摘要、行内建议及合并/执行等操作不会被一次确认隐式串联。

- 含建议的成功或恢复提示仅表示本原型的 **review 级回执**，不能解释为每条 suggestion 都已独立核验。
- Unknown 保留原 intent 与确切 payload，入口为 `Check existing submission`；不重发整份 review，也不提供未经核实的逐 finding 自动补发。
- 本轮没有模拟逐条部分发表恢复，不能用统一成功提示证明每条行内意见均已落地。
- CI Unknown 继续等待 workflow run audit；Close Unknown 继续等待 closure audit。已关闭的来源本身不能证明是这个 intent 关闭的。检查均不授权重发。

## 4. 与现有生产能力的关系

**后端已经支持多 suggestion review；本轮补足内容选择、编辑和预览的 UX，并非新增一项服务端发表能力。** 原型的 `binding()` 只提供明确标记的示例，不读取真实 diff、不生成真实源绑定，也不证明替换代码能编译或修复问题。生产实现仍须使用保存 draft 及既有源校验。

以下是当前代码中的对接依据；原型 payload 展示不是实际 API 请求，也不能省略真实 preparation / intent 的外层绑定与权限检查。

| 对接内容 | 现有依据 |
| --- | --- |
| `feedback` 包含 `body`、`findingIds`、`drafts[]`；每个 draft 为 `id/body/suggestion`，suggestion 含 subject、路径、行范围、head、原内容 digest 和 replacement | [investigation.ts](../../../packages/contracts/src/investigation.ts)，366–380、929–935 行 |
| task、close、merge、trigger-ci 为分开的 payload；Close 没有 comment body；计划引用含 id/version/digest | [investigation.ts](../../../packages/contracts/src/investigation.ts)，937–960 行 |
| 选择与保存 draft 匹配、原始 anchor 不变、范围不重叠；普通 comment 禁止 suggestion，suggestion-comment 至少一条 | [actions.ts](../../../apps/server/src/investigation/actions.ts)，1168–1266 行 |
| summary 排除 suggestion draft；一份 review 的 `comments[]` 分别携带替换代码，事件映射为 APPROVE / REQUEST_CHANGES / COMMENT | [github-transport.ts](../../../apps/server/src/investigation/github-transport.ts)，89–101、1039–1083 行 |
| suggestion 源校验和数量/文本限制；CI ref 必须解析为 expected head | [github-transport.ts](../../../apps/server/src/investigation/github-transport.ts)，574–655、1140–1155 行 |
| duplicate 目标须匹配保存报告；follow-up 须匹配保存 action 与 plan | [actions.ts](../../../apps/server/src/investigation/actions.ts)，966–1005 行 |
| Close / CI 的 Unknown 不自动重发；review 回执与评论核验有各自粒度 | [github-transport.ts](../../../apps/server/src/investigation/github-transport.ts)，742–755、805–815、868–874 行 |

GitHub 官方说明也区分评审结论与行内评论，允许作者决定是否接受建议代码：[评审操作](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/reviewing-proposed-changes-in-a-pull-request)、[创建 review](https://docs.github.com/en/rest/pulls/reviews#create-a-review-for-a-pull-request)、[评论定位](https://docs.github.com/en/rest/pulls/comments#create-a-review-comment-for-a-pull-request)。

## 5. 本轮验证与修正

继续使用 `ui-ux-pro-max`。`bulk selection feedback --domain ux` 匹配 Web / Data Entry / Bulk Actions，采纳复选框与明确批量范围；无关的移动振动结果未采用。Material 3 沿用已有 token、状态层和原生对话框。长清单只滚动对话框内容，底部操作始终可达；没有新增固定或 sticky 页面层。

实际浏览器完成以下检查：

- Request changes 零选择不可继续；一个 review 可混合一条 inline suggestion 和一条 summary finding；两个不同位置/文件的建议各自进入预览。
- 替换代码与发表正文可编辑；未选条目不进入预览。锚点失效的 #5 被拦截，明确改为 summary 后才可继续。
- #2102 的第26项 P0 即使未选也阻止 Approve。Approve 首次进入为空总结、空选择，不带 Request changes 的草稿。
- 报告反馈变化触发复核；明确 Keep publishing text 后保留手写发布正文。纯 Conversation comment 不出现 replacement 字段，准备者可预览但不能确认执行。
- Unicode 超长 summary 和含正文的完整超长 inline suggestion 均被拒绝；41字符 commit 被拒绝，40字符示例可进入 Bug follow-up 预览。
- Close 预览无反馈正文；确认后来源显示 Closed，Closed 筛选可见。Merge commit 正确映射为 merge；未知 Merge 的既有回执检查后显示 Merged。
- CI 非法 workflow 被拒绝；未知 CI 检查后仍保留 unknown。Feature Needs decision 的 draft plan 不能启动 implementation。
- 账号切换只显示他人未决摘要，并清空隐藏对话框中的旧发布正文。未发送或重发任何真实操作。
- 26项清单按 finding ID 统计隐藏选择；两项已选、过滤到一项时显示1项隐藏，键盘清除过滤后显示完整集合且不再提示隐藏项。复选框重绘后保留焦点。

320 / 390 / 1024 / 1440px 四种宽度，共 **40组**选择、编辑、预览、动作选择、Close、Merge和长清单检查：页面、对话框和内容无横向溢出，底部操作位于可见区域。抽查桌面与390px截图；浏览器未记录 JavaScript error。`node --check` 和静态拼接通过。未运行产品 build，也没有安装依赖。

这些结果是合成原型的交互验证，不能替代真实 API、GitHub 投递、屏幕阅读器或实际触屏验收。最终独立契约复查未发现本轮范围内新的可执行问题。
