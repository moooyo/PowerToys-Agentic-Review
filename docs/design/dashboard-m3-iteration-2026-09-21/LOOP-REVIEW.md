# M3 / 06 · UI/UX 闭环复审

2026-09-22。继续只修改交互设计和合成原型，沿用 ui-ux-pro-max 与 Material 3。上一版保存在 [history/m3-05-preview.zip](history/m3-05-preview.zip)。产品 Dashboard、Server 和 contracts 未改动。

## Loop 与退出依据

依次进行独立问题扫描、修复后的契约与状态复审、浏览器路径/错误状态复查、最终独立复审。每个问题都需要明确触发路径和用户影响；不把未经验证的假设当作缺陷，也不以扩充无关功能延长循环。

最后一轮对本次覆盖的发布、草稿、字段错误、权限、回执、任务及关联导航路径未再提出新的可执行修改。已关闭已知问题并停止本轮 loop；这不是对所有未来用例或生产系统作无缺陷保证。

## 已修正

| 问题 | 修改后的交互 |
| --- | --- |
| 保存旧 Request changes 草稿会覆盖报告的新勾选，空 Approve 会清空报告选择 | 各动作的选择完全独立。报告变化有提示；通过 Use report selection 或 Prepare selected feedback 明确导入最新选择，保留已编辑正文。保存发布草稿不会写回报告勾选。 |
| 多条 finding 的错误只有页首文案，无法定位或清除 | 正文、发送方式、replacement 使用稳定字段 ID；错误摘要链接到字段，保留 inline error 与 aria-describedby。修正字段后清除对应错误，键盘焦点可直接进入要修正的位置。 |
| 行内错误改变字段可访问名称 | 字段使用与可见标签一致的稳定名称，错误保留为独立描述；密码重置确认框也覆盖该处理。 |
| 局部重绘把长列表焦点拉回顶部 | Show 筛选保持焦点；Selected 视图取消当前项后进入相邻项，清空后回到 Show；Remove、Use latest、Keep publishing text 保留相关条目的位置与焦点。真正切换步骤仍回到步骤开头。 |
| 已知不可用动作到填写后才被拒绝 | 动作入口提前显示来源关闭、P0、计划未就绪或权限原因。Issue 页面不再显示无关的 PR review 说明。 |
| 发表之后仍反复推荐相同发布操作，关闭回执后无法回看 | 成功后可 View last submission；回执保存独立内容快照，并按来源和原操作人限定访问。编辑新草稿时可查看上次提交并返回；相同内容明确显示 Confirm another。 |
| Follow-up 确认没有可打开的后续 Task | 创建独立、幂等的合成 Queued Task，回执带 Open queued task；Tasks、来源 Investigations 和推荐下一步均可进入。父 Task 和保存报告保持不变。 |
| 计划页重新选择 SHA，准备页却沿用旧草稿 SHA | 从已复核计划进入准备时明确采用刚选择的 SHA。PR Follow-up 的可读预览展示实际 sourceCommit，而不是原 PR head。 |
| 子 Task 与父 Report/Source 跳转丢失队列 | 队列保留 originMemberId，关联导航按 sourceId 识别父子关系。返回原 Tasks/Reports 结果时恢复筛选、位置和原行焦点。 |
| 撤销执行权限后仍可把 unknown 标成已解决 | 原操作人仍可读回执，检查/解决需要重新满足 Execute actions 与对应 capability；权限恢复后才能继续核对原 intent。 |
| 权限字段 ID 中的冒号导致事件处理异常 | core 和 operations 的动态 ID 查询统一转义；focus-field 保留完整 ID。勾选变化可保存，恢复原值仍是无净变化，不增加版本。 |
| 320px 下长 SHA 错误轻微横向溢出 | 行内错误及摘要按钮可折行，摘要按阅读方向对齐；错误状态和底部操作都保持可达。 |

## 实际验证

- 报告先选 #1、保存发布草稿后改为 #2：重开旧草稿及保存不会覆盖 #2；显式导入后发布清单使用 #2。保存空 Approve 后报告选择也不变。
- 同时制造空 finding 正文和不合法代码围栏：两个字段均有错误关联，摘要按钮获得焦点；修改字段后对应错误被清除。
- 在 Selected 视图取消 #1，焦点进入 #2；取消最后一项后进入 Show。在长 Compose 中移除 #26，焦点保留在相邻 #2，而非跳回 summary。
- Bug 计划先选 A 再选 B：准备、精确预览和新 Task 均使用 B。PR Follow-up 选择 C：可读预览与 payload 一致。
- Follow-up 确认可打开新排队 Task；没有伪造 Worker、attempt、执行输出或通过的验证结果。子任务深链不包含不存在的 attempt。
- Tasks 的 Active + 搜索3101 → 子 Task → 父 Report → 子 Task → 返回：过滤与原行焦点恢复。Reports 结果 → 子 Task → Issue → 返回也保留 Reports 上下文。
- 实际在模拟账号表单撤销 Execute actions：dirty/保存可用，未知回执的 Check 被禁用且保持 unknown；恢复权限后可核对原提交。勾选恢复原值时 Save 禁用，不写入新版本。
- 已提交内容可以回看，回到当前草稿不丢编辑；相同内容再次准备时出现明确重复提示。
- 320 / 390 / 1024 / 1440px 共 **28组**最终布局检查，覆盖 finding 错误、review 预览、动作可用性、任务回执、子 Task 与绑定详情、长 commit 错误：页面和对话框无横向溢出，底部操作可见。另检查深色窄屏截图。
- 修正后的最终浏览器路径未记录 JavaScript error。core.js、operations.js、publication.js、followup.js 语法检查和静态拼接通过；未运行产品 build，未安装依赖。

ui-ux-pro-max 的 `error summary validation` 检索命中 Focusable Error Summary、Error Messages 与 Error Placement，采纳字段关联、错误摘要和失败后焦点处理。使用原生按钮作为可聚焦的摘要入口，没有新增 tabindex。

## 边界

所有操作只改变本地合成状态，不写入 GitHub。子 Task 在本原型中保持 Queued，刷新会重置会话模拟数据；没有完整 Worker 生命周期或真实投递验证。真实服务端仍负责来源、计划、权限、并发与幂等。

逐条建议的投递粒度限制继续见 [PUBLICATION-REVIEW.md](PUBLICATION-REVIEW.md)：review 级回执不等于每条建议独立核验，Close/CI unknown 不自动重发。布局与键盘路径检查也不等同完整屏幕阅读器或实际触屏认证。
