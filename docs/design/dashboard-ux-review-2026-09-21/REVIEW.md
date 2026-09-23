# Dashboard UI/UX Review · 2026-09-21

本次评审建议优先改善仓库范围、列表返回、完整筛选、错误反馈和报告阅读效率。现有工作流和操作确认边界已经较完整，适合在其基础上统一交互，不需要另造一个与实际功能脱节的统计首页。本次没有足够证据提出 P0/P1 问题；以下为可从源码确认的 P2/P3 问题与有明确依据的设计改进。

评审文档使用中文，产品界面和原型文案保持英文。

## 1. 依据与证据边界

- **源码基线**：当前仓库提交 `238b1c3`。现行入口为 [app.tsx](../../../apps/dashboard/src/app.tsx)（line 94–120），页面注册见 [routes.ts](../../../apps/dashboard/config/routes.ts)（line 1–15）。
- **视觉基线**：仓库中保存的 2026-09-20 生产构建截图。其 [capture-manifest.json](../dashboard-production-alignment/review/capture-manifest.json) 标记为 `production-dashboard-synthetic-fixtures`，生成时间为 `2026-09-19T23:05:55.0703104Z`，对应香港时间 2026-09-20。它证明当时生产构建在合成数据下的视觉状态，不代表真实客户记录，也不证明当前提交已重新运行。
- **已查看的核心截图（共 14 张）**：1440px 的 [PR 列表 0005](../dashboard-production-alignment/review/captures/capture-0005.png)、[Tasks 0008](../dashboard-production-alignment/review/captures/capture-0008.png)、[PR 详情 0022](../dashboard-production-alignment/review/captures/capture-0022.png)、[Report 0043](../dashboard-production-alignment/review/captures/capture-0043.png)、[Workers 0016](../dashboard-production-alignment/review/captures/capture-0016.png)、[Repositories 0018](../dashboard-production-alignment/review/captures/capture-0018.png)、[Task output 0028](../dashboard-production-alignment/review/captures/capture-0028.png)、[大型报告 0049](../dashboard-production-alignment/review/captures/capture-0049.png)、[Comments 0012](../dashboard-production-alignment/review/captures/capture-0012.png)、[Webhook 失败 0051](../dashboard-production-alignment/review/captures/capture-0051.png)、[仓库设置 0053](../dashboard-production-alignment/review/captures/capture-0053.png)、[Accounts 0021](../dashboard-production-alignment/review/captures/capture-0021.png)，以及 390px 的 [PR 列表 0055](../dashboard-production-alignment/review/captures/capture-0055.png)、[Report 0098](../dashboard-production-alignment/review/captures/capture-0098.png)。
- **本次未做**：没有启动当前生产 Dashboard，没有通过故障注入复现当前版本，没有运行 build，也没有执行实际 GitHub PR/Issue 写入。问题不会因未运行而被描述为“已运行复现”或“新引入的回归”。
- **原型边界**：本次交互原型使用合成数据和本地交互状态，模拟加载、错误、权限、冲突、排队、投递与确认流程，不连接生产 API。原型中的 Create task、Publish、Approve、Merge、Retry、账户与 Worker 修改等均只改变模拟状态。它可验证信息架构与操作路径，不能验证认证、权限执行、真实任务调度、GitHub 投递、清理完成或后端数据契约。

下文“源码确认”指渲染或导航逻辑可直接从当前代码读出；“影响”是据此作出的 UX 判断。涉及实际滚动距离、屏幕阅读器输出和网络时序的结论保留为后续运行验收项。截图和当前源码属于不同证据时间点，不能互相替代。

## 2. 现有产品结构与应保留的行为

当前工作流为 **Source / Work item → Task → Attempt / Checkpoint → Report → Prepared action → Confirmation / Receipt**。报告、执行、验证和外部评论是相关但独立的结果。现有 shell 将页面分为 Review、Tasks、Activity、Workspace；My account 位于账户菜单。`/` 与 `/work-items` 是跳转，不是独立目的地。

以下现有能力应保留：

- 执行结果、报告完整性、最终交付、评审结论和实际验证分别呈现；`Complete` 不能转译为代码正确或 E2E 已通过。
- 报告不可变，反馈草稿可编辑；选中状态跨 findings 分页保留。
- 外部动作采用准备、精确预览、单独确认；未知结果通过已有提交身份刷新或 reconcile。
- P0 对 Approve 的内容限制覆盖完整集合。P1、验证缺失与 Merge 的独立条件不能被混为一个统一“禁止”状态。
- Issue 的源代码调查需要显式 SHA；跟进执行基于已保存的计划；创建 PR 需要已验证远端分支。
- Worker 设置已保存与 Worker 实际退出/清理完成分别表示；停用 E2E 不能显示为立即清理成功。
- 权限不足、版本冲突、未保存离开、请求未知和只读状态不能被视觉简化掉。

这些边界可在 [Dashboard README](../../../apps/dashboard/README.md) 的 Structured reports、Decisions, preparation, and confirmation、Worker task controls 中核对。旧 `pages/Jobs`、`pages/Evaluations`、`pages/Prompts`、旧配置和通知页面未注册到当前 shell，本次原型不将其作为现有可用功能。

## 3. 按优先级的发现与改进

本节的“原型对应改动”描述设计方向及后续生产实现目标；其中超出当前模拟能力的部分不视为已经完成。当前原型实际提供的控件和路径以第 4、5 节为准，运行验证范围以交付验证记录为准。

### UX-01 · P2 · 仓库范围缺少一致的切换入口

**证据与现状（源码确认）**：`InvestigationRepositorySelector` 仅有定义，当前页面未调用，见 [repository-scope.tsx](../../../apps/dashboard/src/investigation/repository-scope.tsx)（line 21）。Repository Overview 的快捷入口将 `repositoryId` 加到列表 URL，见 [repositories-page.tsx](../../../apps/dashboard/src/investigation/repositories-page.tsx)（line 136–166）。shell 中已应用仓库按钮仅清除范围，见 [app.tsx](../../../apps/dashboard/src/app.tsx)（line 281–309）；主导航和分组导航使用目的地裸路径，见同文件（line 383–385、478–481）。Reports 有自己的仓库筛选，其他来源与任务列表没有同等入口。

**影响**：多仓库用户需要进入 Workspace、打开仓库，再选择具体工作列表。切换 Review、Tasks、Activity 后范围发生变化，用户容易失去当前工作上下文。

**原型对应改动**：在全局工作区提供 `Repository` 选择器和 `All accessible repositories`；来源、任务、报告、活动列表共享范围。详情页展示所属仓库；管理全局资源时明确 `Workspace-wide`。合成原型使用原生选择框；真实仓库数量增多时再接入可搜索选择器。

**实现优先级**：第一批，先明确范围继承规则，再接各列表，避免每页独立实现。

**验收标准**：从一个仓库的 Pull requests 切到 Issues、Tasks、Comments、Webhook events 后仍保留该仓库；选择 All repositories 明确清空；没有权限的仓库不出现在可选集合；通过深链进入详情仍显示真实所属仓库。切换范围遇到未保存草稿时沿用现有离开保护。

### UX-02 · P2 · 详情返回会丢失筛选、页码或范围

**证据与现状（源码确认）**：来源详情返回裸 `/pull-requests` 或 `/issues`，见 [work-item-details.tsx](../../../apps/dashboard/src/investigation/work-item-details.tsx)（line 432–440）；来源详情链接只携带 item 与 repository，见 [work-item-state.ts](../../../apps/dashboard/src/investigation/work-item-state.ts)（line 28–34）。Tasks 返回裸 `/tasks`，TaskList 页码保存在组件 state，见 [task-workspace.tsx](../../../apps/dashboard/src/investigation/task-workspace.tsx)（line 93、449、905–906）。Comments 返回仅保留仓库、分页游标存在组件 state，见 [comments-page.tsx](../../../apps/dashboard/src/investigation/comments-page.tsx)（line 138、247）；Webhook 返回见 [webhook-deliveries-page.tsx](../../../apps/dashboard/src/investigation/webhook-deliveries-page.tsx)（line 1015）。Reports 详情已保留多数目录 URL 参数，可作为现有参考，见 [report-workspace.tsx](../../../apps/dashboard/src/investigation/report-workspace.tsx)（line 320–324、360–362）。

**影响**：连续审阅多个对象时，需要重复筛选、翻页和寻找原行。浏览器返回与页面内返回的结果不一致。

**原型对应改动**：统一 `Back to results`，保存来源 URL、分页与列表位置；无列表来源的深链使用 `All …` 作为回退。详情间的 Source、Task、Report 关系链接保持清晰。

**实现优先级**：第一批，与 UX-01 一起处理。

**验收标准**：分别在五类列表设置仓库、搜索和状态，进入第二页对象，再经页面返回按钮返回；筛选、页码和原行位置恢复。直接打开详情链接仍有可用返回路径。浏览器前进/后退和页面返回没有重复、死循环或错误的跨页面参数。

### UX-03 · P2 · Comments 桌面端无法打开完整筛选

**证据与现状（源码确认）**：默认隐藏 `.comments-mobile-filter`，仅在 ≤1100px 显示，见 [comments-activity.css](../../../apps/dashboard/src/investigation/comments-activity.css)（line 32–34、126–136）。桌面工具栏显示的字段之外，精确 `PR or issue number`、`Task ID` 只在 Filters 弹窗中，见 [comments-page.tsx](../../../apps/dashboard/src/investigation/comments-page.tsx)（line 353–367、474–486）；已有这些筛选时桌面表单用 hidden inputs 维持条件。

**影响**：大屏反而比手机少两项可操作能力。通过深链得到的精确条件不能单独修改，用户只能清掉全部过滤。

**原型对应改动**：所有尺寸都保留 `More filters`；常用条件留在工具栏，完整条件放统一面板；已应用条件用可独立移除的 chips 表示。

**实现优先级**：第一批，可作为小范围独立修改。

**验收标准**：1440px、900px、390px 均能设置、修改和单独移除来源号与 Task ID；Apply/Cancel 行为一致；筛选总数包含全部有效条件；缩放或改变窗口宽度不会丢失草稿或已应用条件。

### UX-04 · P2 · Tasks 首次加载失败同时显示真实空状态

**证据与现状（源码确认）**：未获取数据时 `tasks` 从空数组计算，错误 Alert 之后仍可能渲染 TaskList，而 TaskList 对空数组显示 `No investigation tasks yet`，见 [task-workspace.tsx](../../../apps/dashboard/src/investigation/task-workspace.tsx)（line 127–132、928、1028–1056）。

**影响**：同一次加载同时传达“无法读取”和“确实没有任务”，降低用户对系统状态的判断能力。当前源码能确认该渲染分支；本次没有注入网络故障运行复现。

**原型对应改动**：提供独立的 Loading、Unable to load、No tasks yet、No matching tasks；刷新失败但有旧数据时保留旧数据并标注刷新失败和重试。

**实现优先级**：第一批，复用状态模式时检查其他列表，但不将未经确认的页面扩大为同一缺陷。

**验收标准**：首次 GET 失败只显示错误与 Retry；成功返回空集合才显示 No tasks yet；成功但筛选为空显示 No matching tasks；刷新失败不把已加载记录转换为虚假的空集合。

### UX-05 · P2 · Findings 数量增加后缺少快速定位路径

**证据与现状（源码确认 + 既有截图）**：Findings 每页请求 25 条，目录仅逐项展开并提供 Previous/Next，没有严重性、确认状态或文本筛选，见 [report-workspace.tsx](../../../apps/dashboard/src/investigation/report-workspace.tsx)（line 251、550–624）。≤900px 时目录与详情变成同一列，目录排在详情前，见 [report-workspace.css](../../../apps/dashboard/src/investigation/report-workspace.css)（line 113–127）。[390px Report 截图](../dashboard-production-alignment/review/captures/capture-0098.png) 的初始视口大部分用于标题、动作、结果和页签，具体 finding 尚未进入可见区域。截图只能证明当时画面，不能证明当前 26 条案例的实际滚动距离。

**影响**：用户需要逐条翻阅才能定位高优先级问题；手机先经过长目录才能阅读当前 finding。任务的核心行为是评估证据并准备反馈，报告前部的多行元信息会推迟这一行为。

**原型对应改动**：报告顶部提供 P0–P3 与确认状态总览；目录支持全文/位置/严重性筛选，清楚显示结果范围；桌面保留列表与详情，手机采用可收起目录、`Finding 1 of 26` 和前后导航。压缩标题及元信息区，保留执行、完整性、验证的独立语义。动作区保留当前选择数量和进入预览的路径。

**实现优先级**：第二批；优先解决导航密度，再设计服务端完整集合筛选契约。

**验收标准**：用 26 个 findings、P0 位于第二页的合成案例验证：用户能定位 P0，当前范围与完整总数始终清楚；筛选不能只搜索已加载的 25 条；选择、明确取消选择和草稿跨分页/过滤保留；390px 无横向溢出，选择 finding 后能到达详情并有返回目录入口。**现有 Approve 跨页 P0 阻止已经实现，本项不是安全漏洞，也不能改为仅检查可见 findings。**

### UX-06 · P2 · 本地表单校验失败也清空已填密码

**证据与现状（源码确认）**：登录在用户名本地校验前清空密码；改密在确认一致性等本地校验前清空三项密码，见 [sign-in-form.tsx](../../../apps/dashboard/src/investigation/sign-in-form.tsx)（line 38）、[my-account.tsx](../../../apps/dashboard/src/investigation/my-account.tsx)（line 76）。[Dashboard README](../../../apps/dashboard/README.md)（line 210–214）明确要求密码仅存表单内存，实际提交后包括失败都清空。

**影响**：没有发出认证请求的本地格式/确认错误，也要求用户重新输入所有密码。此问题严格限于真正提交前的本地校验，不否定提交后清空的既定规则。

**原型对应改动**：先运行本地校验，失败时保留输入、显示对应字段错误并将焦点移到首个错误。真正发起请求后，无论成功或失败继续清空；取消、会话结束也清空。禁止将密码写入 URL、缓存、日志或持久化存储。

**实现优先级**：第二批，作为独立表单行为调整。

**验收标准**：无效用户名、确认密码不一致时无网络请求且已填字段保留；真正请求失败后字段清空；成功改密后按现有规则退出所有会话；运行检查确认密码不进入 localStorage/sessionStorage、URL 或日志。

### UX-07 · P3 · 报告标题语义与账户仓库名称可更清楚

**证据与现状（源码确认，辅助技术效果待验证）**：Report Section 和 Finding 标题使用 `variant="h6"` 而未显式指定语义元素，见 [report-sections.tsx](../../../apps/dashboard/src/investigation/report-sections.tsx)（line 32、471）；当前主题没有重映射这些 variant。My account 的 Repository access 直接拼接原始 IDs，见 [my-account.tsx](../../../apps/dashboard/src/investigation/my-account.tsx)（line 293）。

**影响**：报告的语义标题层级与视觉层级容易脱节，影响按标题导航的可理解性；用户难以仅凭内部 ID 识别仓库。

**原型对应改动**：显式采用 h1→h2→h3 结构，字号单独控制；账户页优先显示仓库 fullName 与入口，ID 作为可复制次级信息。

**实现优先级**：第三批，可与组件整理同步。

**验收标准**：DOM 标题顺序对应信息层次；键盘与屏幕阅读器能定位报告区域和 finding；仓库名称加载失败时保留 ID 并显示失败/重试，不能伪造名称；没有仓库权限时显示明确空状态。

## 4. 原型范围：10 个目的地 + 登录

这里的“完整”指覆盖现行 10 个目的地、登录入口和主要业务路径，不表示生产控件、状态枚举、权限组合与后端协议的逐项复制。以下按当前 [shell.html](shell.html)、[core.js](core.js)、[operations.js](operations.js) 的实现列出可交互内容。原型内部使用 hash 导航；表中路径是其对应的产品目的地。媒体文件、真实网络、认证和任务执行不在模拟范围内。

| 目的地 | 对应产品入口与角色 | 当前原型实际提供的交互 |
| --- | --- | --- |
| Sign in | 未登录时的会话入口 | 手动输入 demo.admin、demo.reviewer、demo.reader 与任意非空虚构密码；缺失字段/未知示例用户名校验；根据示例账号切换角色并进入 PR 列表；显示模拟改密后的重新登录说明 |
| Pull requests | `/pull-requests` · 仓库读者 | 标题/号码搜索、来源状态、调查状态和 More filters；详情 Overview/Investigations/Discussion；源快照对话框、Task/Report 跳转；用 GitHub URL 模拟导入本地记录；Start review 与预算表单 |
| Issues | `/issues` · 仓库读者 | 与 PR 列表一致的搜索/筛选及三页签详情；Bug/Feature 示例；选择 snapshot 或 source 模式，source 模式要求完整 SHA；进入关联任务、报告与已保存跟进计划 |
| Tasks | `/tasks` · 仓库读者 | 搜索和 All/Active/Needs attention；Progress/Evidence/Details；示例 attempt 选择、输出文本/事件类型过滤、follow 开关、下载合成已加载输出；取消确认与 E2E 等待清理显示；调整预算后恢复；Source/Report 跳转 |
| Reports | `/reports` · 仓库读者 | 目录提供搜索、完整性筛选及全局仓库范围上下文三项入口；Findings/Evidence/Details；完整合成集合搜索、P0/P1 与 assessment 筛选、25 条分页、手机 finding 选择器、目录展开/收起；跨页选择、逐条反馈草稿编辑和保存、JSON 导出；准备动作 |
| Comments | `/comments` · 仓库读者 | 搜索、PR/Issue、Pending/Delivered/Failed 筛选；跨尺寸 More filters 中的来源号、Exact Task ID、Publication type；可独立删除的筛选 chips；正文和历史、Task/Report 跳转；Check delivery、同步精确正文确认、未知请求检查/重试及冲突后审阅 |
| Webhook events | `/webhooks` · 仓库读者 | Processed/Failed/Ignored/Retry scheduled 状态筛选；详情分开显示 Event handling、Task、Comment；阶段时间线与原因；关联 Task/Comment 跳转；失败事件重试确认、请求未知恢复、冲突后审阅 |
| Workers | `/workers` · 管理员 | 列表卡片及 Worker 详情、联系情况、上报/有效能力、E2E ownership 与最近活动；开启准入、停用后果确认、等待清理、清理说明；显式 Simulate cleanup report 控件；刷新不会推断清理成功 |
| Repositories | `/repositories` · 仓库读者 | 仓库目录和 Overview/Intake/Replies/Scheduling；Overview 到 Webhooks/Comments；静态/E2E intake、接收人与可信 actor ID 校验；回复开关、模板选择/编辑/占位符校验/预览；保存/丢弃、冲突对照与下载草稿；全局并发编辑和校验 |
| Accounts | `/accounts` · 管理员 | 启用/禁用筛选；新建/编辑账户；Identity、Administration、Repository scope、Operational permissions、Action capabilities 面板；字段校验、保存/丢弃、停用确认、版本冲突比较、重设密码与会话后果确认 |
| My account | `/account` · 已登录用户 | 当前示例身份、仓库 fullName/ID 与角色 preset；三字段改密、本地校验、确认后回到模拟登录；没有存储或提交真实密码 |

全局实际提供：原生 `Repository` 下拉框（不可搜索）、主导航和窄屏布局、主题切换、`Ctrl/Cmd+K` 合成来源/Task/Report 搜索、账户菜单与退出、流程地图、三种角色 preset、场景选择器，以及已接入表单/反馈的未保存离开保护。仓库控件表达范围继承；主要业务 fixtures 属于同一仓库，不能用它证明生产多仓库隔离。

场景选择器可显示 Loading、Error、Empty、No access，以及相应业务路径中的 Conflict、Unknown、Stale。它是评审控制，不是故障注入工具；并非每个页面实现全部状态组合。Accounts 与 Workers 有基于示例角色的页面门槛，这种客户端模拟不构成真正安全边界。

当前没有模拟：可搜索仓库控件；密码显隐、自动填入凭据、真实认证/连接失败、自动会话到期和原受保护路径恢复；Comments 等运营列表的大数据分页；Reports 的调查类型和 delivery 目录筛选、独立于 finding 的反馈草稿集合；Comments 的 Producer 及全部投递状态枚举；Webhooks 的目标号/类型/Static-E2E 筛选与 duplicate→canonical 导航；Workers 的搜索/状态过滤和版本冲突流程；仓库目录搜索、webhook endpoint、真实回复授权及完整资源 owner 视图；Accounts 搜索与全部权限组合。PR/Task 列表提供每页 4 条的交互演示，Findings 使用每页 25 条的数据分页。

Evidence 当前只有“内容未保留”和 provenance 对话框，没有可播放视频、可预览图片的文件 bytes，也没有真正的媒体下载。输出和 JSON 导出下载的是明确标注的合成文本/数据文件。

## 5. 关键任务流与原型状态

下表记录当前可体验的主要路径，不把生产契约要求等同于模拟实现。动作表单目前覆盖 Comment、Approve、Request changes、Code suggestion comment、Merge、Close、Trigger CI、saved follow-up plan；字段按操作简化。Create PR 与 Close as duplicate 虽出现在账户 capability 清单中，但没有对应执行准备表单。

| 任务流 | 当前可体验的步骤 | 当前模拟的关键分支 |
| --- | --- | --- |
| 导入并发起调查 | PR/Issue list → Import source URL → Source detail → Start investigation → Task | URL 格式校验、本地创建合成来源、Issue source 模式 SHA、预算校验、Queued、来源冲突/更新提示、未知创建请求恢复；不读取 GitHub |
| 跟进与恢复任务 | Task → Progress / Output → Evidence / Details → Report 或 Resume | Running/Blocked/Interrupted 示例、输出过滤与 follow、已耗尽预算检查和提高限制、取消确认；E2E 显示等待清理。没有真实新 attempt、Worker 或父子任务执行 |
| 审阅并准备反馈 | Report → Finding → 编辑/选择/保存 → Prepare action → Exact preview | 26 条完整集合、P0 位于第二页、跨页选中、P0 对 Approve 的限制、只读/只准备角色；显示精确模拟目标、revision、内容与 intent |
| 确认并查看结果 | Exact preview → Confirm → Simulation receipt | 独立确认、来源过期阻止、版本冲突刷新、Unknown 检查已有 intent；成功仅为本地 receipt。不模拟完整 Executing/Failed 后端状态机，也不将 payload digest 当密码学校验 |
| 检查与同步评论 | Comments → Publication detail → Check delivery 或 Review sync → Confirm | 已保留正文、历史、Task/Report；Pending/Delivered/Failed 示例；Unknown 检查/重试同一请求、冲突后审阅；接受同步后显示 Pending，不伪称已投递 |
| 恢复事件处理 | Webhook event → 阶段时间线 → Retry handling → 确认 | Failed → Retry scheduled、Unknown 原请求恢复、冲突后审阅、角色限制；已有 Task 与 Comment 独立显示，不重跑既有 Task |
| 管理自动化与资源 | Repository Intake/Replies/Scheduling；Worker → Disable E2E | 配置字段与模板校验、保存/丢弃、仓库版本对照、全局并发范围；Worker ownership 保留与待清理；显式合成 cleanup report 才改变清理状态 |
| 管理访问 | Accounts → 创建/编辑/停用/Reset；My account → Change password | 独立仓库/业务权限/capability/execution 字段、账户冲突比较、密码本地校验和确认；自己的模拟改密回到登录，其他会话失效仅作后果说明 |

完整领域要求仍作为后续生产实现验收保留：来源和任务的真实分页与恢复定位；报告五类筛选、全部严重性、独立草稿、完整动作字段及服务端 guards；Create PR 的已验证分支与 Close as duplicate 目标选择；认证、会话过期、登录回跳；全部评论/事件状态、canonical 记录及权限组合；Worker 版本并发和真实 cleanup receipt；可用媒体 bytes、鉴权下载和错误恢复。第 3 节每项验收及第 6 节跨设备/辅助技术检查也属于此范围，不能因本地原型能点击通过就认定生产已满足。

所有真实会产生 PR/Issue 写入的按钮在原型里均为模拟。生产实现的真实写入验收须另外准备具体目标、操作和内容，取得适用于该执行范围的明确授权；此文档和原型交互不构成该授权。

## 6. 实现顺序与后续验收

| 批次 | 目标 | 验收重点 |
| --- | --- | --- |
| 第一批 | UX-01–04：范围、返回、完整筛选、错误状态 | 对连续处理任务的阻碍最直接；先统一 URL/范围约定与状态组件，再接页面 |
| 第二批 | UX-05–06：报告导航密度、密码本地校验 | 保持完整 findings 与操作 guards 的语义；密码真正提交后的清空策略不变 |
| 第三批 | UX-07 与细节一致性 | 标题结构、仓库名称、键盘焦点、焦点恢复、响应式排布；不扩大成未经证实的可访问性合规结论 |

后续在实际实现完成后，按 1440px、900px、390px 检查主要列表、详情、表单、确认对话框和错误状态，并补充深色主题、200% 缩放、纯键盘与屏幕阅读器验证。至少覆盖：

- 首次加载失败、刷新失败有旧数据、真正空集合、筛选无结果，分别输出准确文案和恢复入口。
- 26 个 findings 的完整总数、严重性定位、分页与选择保留；页面二的 P0 仍影响 Approve，Merge 保持独立检查。
- 当前原始源、旧报告、部分 checkpoint、缺验证证据之间的区别可被用户识别。
- 对话框打开/关闭的焦点、Esc、按钮命名、错误字段聚焦；异步更新不会把焦点抢走。
- 不同账号权限、会话失效、并发版本冲突和未知请求结果；无权限按钮同时具备可理解的原因。
- 390px 视口没有页面级横向滚动；手机目录可收起、选中内容可到达，底部导航不遮住关键操作。
- 浏览器前进/后退、页面内返回、刷新与直达链接的状态规则一致。

这些是实现后的验收要求，不是本次已通过的测试结果。本次交付用于讨论和验证 UI/UX 方案；真实数据、网络、执行和发布链路仍以生产 API 与独立验证证据为准。
