# M3 / 06 Dashboard 代码落地

2026-09-22，根据最终交互原型将改动落实到 `apps/dashboard`。原型文件继续保留为设计参考；本记录说明实际产品实现及验证边界。未修改 Server、contracts 或数据库协议。

## 已落地

- Material 3 字级、语义色、形状、状态层、明暗主题及窄屏布局；共用仓库范围和受限的 Copy view URL。
- PR / Issue 列表显示保存结论；Source、Task、Report 分别呈现保存结论、实际验证与当前执行，建议下一步前置。相关详情提供原生 GitHub PR / Issue 链接。
- 连续审阅保留列表筛选、结果顺序、位置和原行焦点；Source → Task → Report 可返回最初结果。身份和仓库变化使不适用的队列失效。
- 完整报告的 finding 检索、优先级和 assessment 筛选、跨页 P0 定位、完整已选集合复核、逐条保存并继续。
- 发布按 Select findings → Compose → Server preview 展开，预览后单独 Confirm。不同动作分别保存选择、正文与字段；报告勾选需明确导入。
- Request changes 至少选择一条 finding。存在有效保存建议时可作为 GitHub suggested change 发表，允许编辑 replacement code，保留精确源绑定。Approve 可不包含 finding；Close、Merge、CI 和保存计划的 follow-up 使用各自字段及真实 API 语义。
- 回执保留、相同内容再次发布提示、未决提交核对、准备与执行权限分离。丢弃本地草稿不表示取消或回滚服务器操作。
- Task 最新/历史 attempt、输出搜索 URL、恢复预算错误和等待资源清理的 Active 呈现；Comments 精确 Task 筛选与可移除条件；运营表单净变化检测和 no-op 保存保护。
- 刷新失败时保留可读旧数据并限制新操作；权限拒绝不继续展示已拒绝的子查询缓存。来源、报告、计划、子任务及 action context 均检查实际身份绑定。

## 真实 API 边界

- Reports 目录仍使用服务端 cursor，审阅队列明确只覆盖当前目录页。报告内 finding 筛选使用已校验的完整 export，本地每页显示 25 条。
- Task 的等待清理呈现来自已有 scheduler 资源租约，没有向 API 添加 `cancelling` 状态。
- Comments / Webhooks 没有按请求标识读取 acknowledgement 的专用 API。刷新对象状态不会清除 Unknown；不会把原型模拟控件作为产品功能。
- PR follow-up 沿用保存计划主体；Issue snapshot 计划需明确 SHA，已有冻结 commit 的计划沿用该来源。CI ref 由服务端解析并校验目标 head。
- 本轮浏览器验证使用隔离的 development sample；确认样例外部动作返回“未分发 GitHub 操作”。没有对真实 PR / Issue 执行写入，也未进行线上发布。

## 验证

交互检查覆盖 finding 选择与建议预览、样例提交回执、零 finding 的 Approve 不混入其他动作的草稿、Issue SHA 错误定位、Close 独立字段、离开草稿保护、跨 Report 的原结果队列、P0 定位和 URL、Task 恢复表单及输出搜索、Comments 精确 Task 筛选，以及桌面、390px 窄屏与深色主题。窄屏 Task 检查无页面横向溢出。

- 共享 contracts 构建、Dashboard 正式 package exports 的 TypeScript 检查和 Vite 生产构建通过。
- 本轮 75 个新增/修改的前端源文件通过 Biome error-level 检查；`git diff --check` 通过。
- 生产源码边界检查 9 项通过，包含构建后复核。
- Vite 提示主 JavaScript bundle 超过 500 kB 阈值：约 1.43 MB，gzip 约 401 kB。本轮保留现有静态入口策略，未将该提示宣称为已解决。

完整 Dashboard 回归：172 个测试文件、4,319 项测试全部通过，使用构建后的正式 contracts package exports。测试报告保存在本地忽略目录 `artifacts/dashboard-final-tests.json`。
