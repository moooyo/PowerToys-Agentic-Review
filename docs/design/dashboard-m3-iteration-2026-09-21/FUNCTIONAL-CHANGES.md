# Dashboard 原型功能变更与产品落地影响

本轮日期：2026-09-22。目录名称保留原型最初创建日期 2026-09-21。

**M3 / 06 更新：** [闭环复审](LOOP-REVIEW.md) 补齐独立发布选择、可定位错误、稳定可访问名称、授权后核对回执及 Follow-up → 新 Task → 父报告/原结果的完整可浏览链路。

**M3 / 05 更新：** [逐 finding 发表流程](PUBLICATION-REVIEW.md) 取代通用 Operation＋单正文的准备界面。Request changes / Approve 可包含多条已有源绑定的建议；Close、Merge、CI 和 Follow-up 使用独立字段与预览。后端多 suggestion review 能力已经存在；新增“Request changes 至少选一条”属于本轮产品交互规则。

**M3 / 04 更新：** GitHub 来源入口、保存结论、当前推荐动作及具体权限要求见 [DECISION-REVIEW.md](DECISION-REVIEW.md)。该更新优先于下文 M3 / 03 的“正文优先”层级目标；保存结论与 next action 现在置于证据正文之前。

本轮在 Material 3 原型中调整连续审阅、视图恢复、反馈准备和运维恢复流程，重点是减少重复定位，让“当前看到什么、准备了什么、实际发生了什么”保持一致。改动只位于本原型目录，**没有修改 `apps/dashboard`、Server 或 contracts**。现行 10 个目的地与登录入口保留；没有新增统计首页，也没有引入批量 Approve 或跨工作项一次确认。

本文依据当前 [core.js](core.js)、[operations.js](operations.js) 及产品提交 `238b1c3` 的源码和契约，记录本轮目标、实现方式与落地边界。原型仍使用本地合成数据，不连接 API、GitHub 或 Worker。本轮实现与收尾复查已完成；下文是验收标准，具体已测路径和限制见 [2026-09-22验证记录](VALIDATION-2026-09-22.md)，不将每个组合自动声明为已验证。旧 [UI/UX 审计](../dashboard-ux-review-2026-09-21/REVIEW.md) 保留，不被本文改写为产品修复记录。

## 1. 本轮功能变化

### F-01 · 从筛选结果连续审阅，保留最初来源

从 PR、Issue、Task 或 Report 列表打开记录时，捕获当前筛选结果的有序 ID 集合、来源列表、仓库范围、筛选条件和列表位置。详情顶部显示当前在结果中的位置，并提供 Previous result、Next result 和返回来源结果的入口。在同一对象的 Source → Task → Report 之间跳转，仍返回最初的结果列表，而不是总回到当前页面所属目录。

原型将其作为**本次审阅的结果快照**：任务状态后来变化，不应悄悄重排已经开始的审阅顺序。切换仓库、身份或开始无关导航时清除不适用的队列；无来源的深链回退到对应目录。它不等于调度队列，不改变任务优先级，也不触发下一条记录的任何业务动作。

实现位置：[core.js](core.js) 的 `matchedSources`、`nav`、`queueBar`、`back`、`recordViews`。原型 fixture 用共同的编号连接 Source/Task/Report，**产品不能照搬这一身份假设**：实际必须使用各自的 `workItem.id`、`task.id`、`report.id/version` 以及返回的关联关系。一个来源可能有多个 Task，一个 Task 也可能留下多个报告版本。

### F-02 · 白名单视图 URL 与 Copy view

筛选、页码、页签、当前 finding、attempt 和部分运营页视图参数可以恢复。`Copy view link` 在 HTTP(S) 地址下复制当前原型地址及 hash；直接文件或嵌入环境使用 `Copy view state`，只复制可在同一原型中恢复的片段。剪贴板不可用时提供可复制的只读字段。

URL 使用显式白名单，不序列化整个 `state`：

| 可恢复内容 | 保留在本地私有状态、不会放进 Copy view |
| --- | --- |
| 页面、记录 ID、仓库范围、允许的页签 | 密码、登录凭据、角色授权和会话秘密 |
| 列表搜索/过滤、当前页 | 反馈正文、设置草稿、账户编辑内容 |
| 报告 finding ID、优先级/assessment/文本过滤、分页 | 已选反馈的正文快照、Action payload、待确认 intent 内容 |
| Task attempt、已加载输出的搜索/类型过滤 | 命令回执私有内容、历史事件中的请求 payload |
| Comments/Webhooks/Workers/Repositories/Accounts 的允许视图参数 | origin 结果队列的完整成员、私稿保存基线 |

解析器限制字符串长度、枚举和整数范围，未知参数不成为业务状态。`Copy view` 恢复视图，不复制草稿、选择授权或已准备操作；接收链接的人仍必须使用自己的权限读取数据。来源结果快照仅由本地导航状态维持，复制详情链接不承诺复现一份完整历史队列。

实现位置：[core.js](core.js) 的 `viewParams`、`parseView`、`publicOpsView`、`applyView`、`copyView`；[operations.js](operations.js) 的 `viewKeys`、`safeViewValue`、`getView`、`applyView`。

### F-03 · 报告正文优先，上下文按需展开

报告的来源、不可变版本、digest、执行、完整性、交付等信息集中到可展开的 Report context。首屏优先呈现报告对象、验证情况、关键阻止条件和 Findings。Source/Task 跳转与导出仍可在上下文中访问。Filters & feedback 可以收起，当前总数、匹配数、选择数和未保存状态仍有简短提示。

这是一项呈现方式调整，不合并执行成功、报告完整、验证通过等不同概念。P0 对 Approve 的限制及来源过期提示不能因上下文收起而失去可见性；部分报告与未完成验证在生产实现中仍需有清楚提示。

实现位置：[core.js](core.js) 的 `reportDetail` 与当前样式文件。正文优先带来的实际首屏收益、折叠后的键盘焦点和窄屏布局待最终视觉验证。

### F-04 · 当前 finding 的 Save & Next

当前 finding 提供保存并前进的操作：只保存这一条反馈，然后进入**当前筛选结果**中的下一条，必要时跨 findings 数据页。最后一条只保存并提示已到末尾，不循环、不自动选择，也不发起准备或发布。

`Save all report drafts` 仍是另一项操作。其他 finding 或其他报告的未保存修改不会因为保存当前条而被隐式保存；它们仍应触发相应离开保护。保存对象是会话内私有反馈，原始报告保持不变。

实现位置：[core.js](core.js) 的 `saveCurrentFinding`、`moveFinding` 和 `save-current-next`。现行产品 [report-draft-store.ts](../../../apps/dashboard/src/investigation/report-draft-store.ts)（line 41–84）只有整体 `save`/`discard` 事件，落地时需增加按草稿 ID 更新保存基线的本地事件，而不是让按钮调用整体保存。

### F-05 · Review selected 展示完整已选集合

Review selected 不局限于当前 25 条、当前筛选或当前页：它列出该报告已选中的 finding，标注被当前过滤条件隐藏的条目，并允许逐条 Remove。移除只改变选中状态，保留该条私有反馈草稿；关闭面板回到原报告视图。

它用于复核一次准备所包含的材料，不是批量执行界面。移除 P0 不解除当前源上完整集合的 Approve 限制，选择数量为零也不能绕过服务器 guards。

实现位置：[core.js](core.js) 的 `selectedReviewDialog`、`matchedFindings`、`remove-selected`。产品现有 [feedback-selection.ts](../../../apps/dashboard/src/investigation/feedback-selection.ts) 已用 finding/draft 身份保存跨页选择；新面板可复用这个状态，不应新增互相独立的“面板选择”。

### F-06 · 准备正文的反馈快照与过时提示

第一次从所选 findings 生成准备正文时，保存其来源快照：哪些 finding、当时的反馈内容、对应报告。随后修改反馈或选中集合，不再静默追加或覆盖已经编辑过的正文，而是显示正文来源已过时。

用户需要明确选择：

- `Replace with current selected feedback`：先确认替换，再用当前已选反馈重新生成正文；取消保留原正文。
- `Keep body as manual text`：明确保留为独立手写内容，承认它不再自动同步当前选择；之后选择再次变化仍需重新审阅。

准备精确预览前检查尚未处理的差异。生成正文与已准备 intent 分开：重新生成只是本地草稿变化；已准备、已提交或结果未知的 intent 仍绑定原 payload，不能以修改 textarea 取代重新准备或查询现有提交。

实现位置：[core.js](core.js) 的 `feedbackSnapshot`、`feedbackNeedsReview`、`feedbackStatus`、`actionDraft` 及替换确认路径。本地 snapshot ID 是变化检测标记，**不是服务器 digest、签名或执行凭证**。

生产实现需注意已有语义：当前 [action-panel.tsx](../../../apps/dashboard/src/investigation/action-panel.tsx)（line 88–129）的 `materializeFeedback` 将额外正文与选中 drafts 分开组装；不能一边把选中草稿拼入正文，一边又在 drafts 中重复提交。应明确采用“独立正文 + 结构化 drafts”还是“明确物化的正文”，并保留 finding、suggestion 与 report 的精确绑定。

### F-07 · 默认最新 attempt，Cancelling 留在 Active

第一次进入 Task 默认展示最新 attempt；历史 attempt 明确标记，并提供 Latest attempt 返回入口。Task 总消耗与当前 attempt 输出分别说明；恢复后新增的模拟 attempt 不应沿用旧 attempt 的输出标题。返回已查看记录时可以保留用户明确选中的历史 attempt。

取消 E2E 或停用其 Worker 准入后，任务显示 Cancelling，并继续保留在 Active 结果中，直到收到明确 cleanup 结果。刷新页面只更新观察，不释放 ownership。Worker 与 Task 的模拟状态保持关联。

这是原型对现行产品的对齐与补充：产品 [task-workspace.tsx](../../../apps/dashboard/src/investigation/task-workspace.tsx)（line 379–383）已经默认选择最新 attempt，不能把这一点描述成产品此前缺失。

产品契约 [InvestigationTaskV1Schema](../../../packages/contracts/src/investigation.ts)（line 254–275）的 `state` 没有 `cancelling`。取消请求标志存在于 Worker heartbeat（同文件 line 1196–1202），资源租约另有 `held/needs_cleanup/released`，见 [investigation-scheduler.ts](../../../packages/contracts/src/investigation-scheduler.ts)（line 15–31）。因此落地应优先采用由权威读取字段推导的**呈现状态**；若列表目前缺少这些字段，需补读模型。不要直接向现行 API 发送原型的 `Cancelling` 字符串，也不要把“等待清理”当作仍在运行代码。

### F-08 · 检查回执不等于重试，模拟结果显式提供

Comments 与 Webhooks 现在将以下行为分开：

| 行为 | 原型表达 |
| --- | --- |
| Refresh / Check delivery | 读取当前观察，不创建发布或重试 |
| Check saved request | 查看已有请求的 acknowledgement，不安排第二个操作 |
| Retry same request | 以原请求身份重发，并演示去重；不是换 key 新建命令 |
| Sync publication / Retry handling | 显式确认后的新业务请求；接受请求与业务完成分开 |
| Simulate successful result / Simulate another failure | 仅原型控制，向已确认接收的 Pending/Retry scheduled 操作注入合成结果 |

原型不再让“检查”直接把投递变成 Delivered 或把事件变成 Processed。新结果由明确标注的模拟控制产生，Unknown acknowledgement 未解决时不能直接注入最终结果。Webhook 成功示例只连接确实存在的本地 Task/Comment；没有对应记录时不捏造关联，也不声称启动了 Worker。

实现位置：[operations.js](operations.js) 的 `commentCommand`、`webhookCommand`、`commentOutcome`、`webhookOutcome` 与 `prototypeOutcomeControls`。真实接口的三种“读/核对/写”边界见第 2 节。

### F-09 · 历史按实际模拟事件追加

Comments/Webhooks 历史由会话内事件数组维护：初始保留快照、提交、检查、同请求重发、模拟成功或再次失败各追加一条记录，记录顺序号、请求身份、事件与结果；提交时复制当时的 payload。后续变化不会把旧行重新渲染成当前状态，也不再使用固定两行占位历史冒充发生过的过程。

实现位置：[operations.js](operations.js) 的 `operationHistory`、`addHistory`、`historyPanel`。这里的 append-only 是**本次原型会话内的实际追加行为**，不是持久化审计服务、可信时间线或防篡改日志；相对时间与 receipt 都是合成内容，刷新文件会重置。

### F-10 · 净变化 dirty、无变化保存与运营页路由

dirty 按当前值和保存基线的净差异计算。把字段改回原值后应自动清除 dirty；集合型权限不因选中顺序不同产生虚假差异。仓库设置、账户设置和全局并发的无变化保存不会增加模拟版本或显示新的保存成功；按钮与提交处理都检查 no-op。

这不取消独立业务操作：新建账户、重设密码、账户启停、重新授权自动发布等有各自的语义，不能因为某个配置草稿无差异就一并禁用。生产的“重新授权”尤其可能在配置值不变时仍需提交。

运营页的 tabs、列表搜索和过滤接入统一视图路由。Repository 的 Intake/Replies/Scheduling、回复模板选择以及 Comments/Webhooks/Workers/Accounts 的允许过滤可随 URL 恢复。路由只包含“正在看哪个模板”，不包含模板正文；直接页签链接仍受账号权限限制。

实现位置：[operations.js](operations.js) 的 `canonical`、`changedCount`、`clean`、`draftActions`、各 save handler、`viewChanged`、`setSection`。当前产品部分模块本就有基线比较和无变化保护，例如 [scheduler-panel.tsx](../../../apps/dashboard/src/investigation/scheduler-panel.tsx)（line 98、139）和 [action-draft-store.ts](../../../apps/dashboard/src/investigation/action-draft-store.ts)（line 80–92）；本轮不是宣称所有产品表单此前都缺失这一能力。

## 2. 哪些可以直接做 UI，哪些涉及 API/read model

| 变化 | 当前产品已有能力 | 落地判断 |
| --- | --- | --- |
| 上下文折叠、正文优先、Latest attempt 入口 | 报告 header、Task attempts 与详情数据已存在 | 主要为 UI 布局与本地视图状态；不需要为折叠增加 API |
| Copy view、运营页 tabs/filters 路由 | 页面已采用 URL 参数，字段数据由现有 API 提供 | 可先做白名单编码/解析和历史恢复；URL 不能替代授权，也不能带私稿/payload |
| 当前 finding Save & Next | 会话内报告草稿与跨页选择 store 已存在 | 新增按单条更新基线的 reducer；继续为本地保存则无需新 API。若要求跨设备持久保存，应另设计草稿 API 与权限/版本 |
| Review selected 完整集合 | `selectedFindings`、完整报告 export 和报告 identity 校验已有 | 已完整加载时可由客户端完成；若只载当前页，需按 ID 加载已选详情或完整 export，不能漏掉隐藏条目 |
| 准备正文快照过时提示 | 生产已有结构化反馈物化、ActionIntent、revision/report/digest 绑定 | 本地快照比较可在 UI 做；最终 prepare/confirm 继续依赖服务器，不以本地 snapshot hash 代替 guards |
| Findings 全集合搜索/过滤/定位 | 当前 findings 页仅支持 `cursor/limit`；完整 export 已有 | 可以完整 export 校验后客户端过滤；若要按服务端分页且不下载全量，需扩展绑定 sealed report 身份的查询 read model |
| Reports 目录的搜索/类型/完整性/交付/范围 | 当前已有服务端 query/page 契约与 cursor | **不是缺 API 项**；本轮应复用，不能重新设计成客户端仅过滤已加载页 |
| origin 结果审阅队列 | Work items/Tasks 当前全量读取后本地分页；Reports 目录服务端分页 | 当前全量集合可在客户端冻结顺序。跨服务端分页的完整结果队列需稳定 cursor/顺序/快照身份及按 ID 定位约定，不能以当前页索引充当身份 |
| Cancelling 在 Active 中可见 | Task 详情有 resourceLeases；Worker heartbeat 有取消请求信息；Task 列表无 Cancelling 枚举 | 推导呈现状态需要可靠的取消与清理字段。列表若缺字段，补聚合读取模型；需要新增后端 state 时另做契约迁移，不能静默扩枚举 |
| 查询特定命令 acknowledgement | 能读取 publication/event 当前状态；现行未发现按请求 idempotencyKey 查询命令回执的专用接口 | 不能把 GET 对象状态当作这次命令已被确认。若正式提供 Check saved request，应新增/明确命令回执读取契约，或只展示对象状态并保持命令 Unknown |
| append-only 运营历史 | 已有 comment attempts 与 webhook processing attempts | 直接展示权威 attempt 历史可复用；若要持久记录每次用户状态检查/重发，需服务端审计事件支持，不靠浏览器数组充当审计证据 |
| dirty / no-op save | 多个产品表单已存在基线、版本与冲突处理 | 先统一前端净变化与按钮行为；真正提交仍保留 optimistic version。是否由服务器保证 no-op 不增版本需单独确定，不能从原型推断 |

### 2.1 全集合与分页的准确边界

当前 [investigation-workspace.ts](../../../packages/contracts/src/investigation-workspace.ts)（line 47–68）已定义 Reports 目录的 `repositoryId/workItemId/taskId/kind/search/delivery/completeness/cursor/limit` 和 `items/nextCursor`，由 [read-api.ts](../../../apps/dashboard/src/investigation/read-api.ts)（line 116）调用。目录过滤不需要凭空增加一套 API；任意排序、facets 或结果快照则是额外能力。

报告内部 findings 页见 [api.ts](../../../apps/dashboard/src/investigation/api.ts)（line 359），全量 export 见同文件（line 364）。页面用 [report-state.ts](../../../apps/dashboard/src/investigation/report-state.ts) 校验 report 版本、digest 与集合数量。原型有 26 条全量数据，可以正确演示完整集合过滤；生产可以复用完整 export，但应评估数据规模和访问成本。若新增服务端过滤分页，契约应至少包含：报告 ID/version/digest、过滤条件、稳定排序、过滤后总数、cursor、按 finding ID 定位。不能将当前 25 条的命中数标成全报告总数。

当前 Tasks API 仅通过 `workItemId` 读取集合，没有服务端 cursor，见 [api.ts](../../../apps/dashboard/src/investigation/api.ts)（line 179、341）；产品 [task-workspace.tsx](../../../apps/dashboard/src/investigation/task-workspace.tsx)（line 93–96、928–943）本地筛选、排序和分页。未来服务端分页应定义排序 tie-breaker（如 task.id）、cursor 对筛选/排序的绑定，以及结果变化时“继续原队列”还是“重新生成结果”的规则。多独立服务聚合还需要 workspace/server scope；这不是当前 task 契约已有字段。

### 2.2 Comments 的读取、核对、发布是三类操作

现行接口不能简写成一个统一 Retry：

1. GET comment summary / attempts：读取已有 publication 与历史，见 [api.ts](../../../apps/dashboard/src/investigation/api.ts)（line 250–260）。
2. POST `/comments/:id/reconcile`：检查 GitHub 投递并记录观察；不重新发布正文，见同文件（line 272）和 [comment-publication-state.ts](../../../apps/dashboard/src/investigation/comment-publication-state.ts)（line 117–119）。它可能更新服务端观察记录，不等同于纯 GET。
3. POST `/comments/:id/sync`：提交发布/更新最新准备内容，见 [api.ts](../../../apps/dashboard/src/investigation/api.ts)（line 263）。reconcile 与 sync 都有版本和幂等键，见 [investigation-comments.ts](../../../packages/contracts/src/investigation-comments.ts)（line 145）。

因此，原型里普通 `Check delivery` 的只读演示，落地时需明确是读取已知记录还是启动一次权威 reconcile，文案和权限按所选语义实现。`Check saved request` 则是“查询特定命令是否已受理”，与上述三项都不应混淆。现行保留请求位于客户端内存；对象状态相同不能证明某个命令 identity 已确认。

### 2.3 Webhook 刷新不安排重试，也不确认未知命令

GET event 列表/详情与 POST `/webhook-deliveries/:id/retry` 分离，见 [api.ts](../../../apps/dashboard/src/investigation/api.ts)（line 214–228）。重试携带 `version + idempotencyKey`，见 [investigation-webhook-deliveries.ts](../../../packages/contracts/src/investigation-webhook-deliveries.ts)（line 97）。

现行 [webhook-deliveries-page.tsx](../../../apps/dashboard/src/investigation/webhook-deliveries-page.tsx)（line 281、299–304）明确保留 Unknown：读取事件不能确认已保存命令。原型的 acknowledgement 模拟不是现有 API 能力证明。正式实现中，“刷新事件”“查询命令回执”“重发同一请求”必须是分开的动作；恢复可能连接既有 Task，或在处理到创建阶段时产生新工作及已配置自动回复，不等于重新执行既有 Task。

### 2.4 服务器仍决定能否执行

现行 [InvestigationActionIntentV1](../../../packages/contracts/src/investigation.ts)（line 977–1009）包含 expected revision/SHA、reportRef、payloadDigest 和 guards；创建与确认请求见同文件（line 1296–1315）。反馈快照提示、Review selected 和白名单 URL 都不能替代这些约束。

正式接入时仍须保留完整集合 P0 判断、精确目标、操作能力、源版本、report 版本/digest、幂等身份、未知提交恢复和服务器确认。准备与确认只针对一个明确工作项及其 intent；本轮没有提供批量 Approve 的授权模型或 API。

## 3. 交互验收清单

这些条目用于本轮原型收尾与后续产品验收；已执行的验证另列于本轮验证记录，不能直接外推到生产实现。

| 场景 | 预期结果 |
| --- | --- |
| PR 列表带搜索/状态，从第二页打开 Source → Task → Report | queue 仍指向 PR 原筛选结果；返回恢复过滤、页码和位置；Previous/Next 按捕获顺序，边界按钮禁用 |
| 队列中 Task 状态变化、切换仓库或账号 | 状态变化不悄悄重排原结果；新 scope/身份不沿用旧队列 |
| Copy view 后刷新/新开同一原型，及浏览器前进后退 | 白名单视图可恢复；未知参数安全回退；复制内容没有草稿、密码、payload；无 origin 队列时有合理返回 |
| Repository 切到 Replies 并选模板；运营列表设过滤 | URL 与 Back/Forward 恢复页签/过滤/模板选择；模板正文和账户编辑内容不进入 URL |
| 报告窄屏首屏与键盘 | 正文优先，P0/验证状态可识别；上下文和筛选可展开，焦点可达且不被操作条遮住 |
| 在 finding 25 编辑后 Save & Next | 只保存当前条并进入下一个匹配 finding；跨页正确；其他条目 dirty 保留；最后一条只保存 |
| 选中跨页 finding 后过滤隐藏其中一条，打开 Review selected | 完整选中集合仍可见；逐条移除保留草稿；删除选中 P0 不改变 Approve 的完整集合限制 |
| 生成准备正文后改选中集合或反馈，再打开准备 | 显示过时依据；确认重新生成可替换、取消不覆盖；明确保留手写正文后不自动追加；后续再次变化仍可检测 |
| 有未确认 intent 时编辑私稿或返回准备 | 不修改已有提交 payload，不生成重复提交；继续检查已有 intent |
| 中断任务首次打开、查看历史 attempt、恢复 | 默认最新；历史输出标签明确；Latest 可回到最新；恢复新增 attempt 后不显示旧输出为最新 |
| E2E Cancel 或 Worker Disable E2E | Task 在 Active 中保持 Cancelling；普通刷新不变成清理完成；明确模拟 cleanup 后才释放 ownership/改变取消呈现 |
| Comments/Webhooks Unknown → Check saved request | 不增加业务请求数，不创建第二次发布/处理；acknowledgement 与最终 delivery/handling 分离 |
| Retry same request 与再次失败后的新 retry | 同请求身份保持、去重可见；新业务重试才产生新请求/attempt，并经过现有权限与确认 |
| 显式模拟成功/失败，再查看历史 | 只对允许的 Pending/Retry scheduled 项生效；历史追加新行，旧结果/旧 payload 不被新状态覆盖；不存在的 Task/Comment 不造链接 |
| 修改设置再改回原值；无变化 Save | dirty 回到零、无虚假离开提示、无模拟版本递增；真正更改仍受字段验证/冲突保护；独立重新授权不被误当 no-op |

后续移植到产品时，先实现可独立落地的 UI/本地状态，再决定命令回执、服务端全集合查询、稳定分页队列和取消聚合字段等契约扩展。真实 PR/Issue 写入验证仍需针对具体目标、内容和执行范围取得明确授权；本原型及本文不发出任何外部操作。
