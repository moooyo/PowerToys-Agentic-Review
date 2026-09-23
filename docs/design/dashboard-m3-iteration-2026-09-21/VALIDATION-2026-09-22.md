# 2026-09-22 · 功能与交互续轮验证

当前版本：M3 / 03。验证范围为本地交互原型，不是生产 Dashboard。上一版源码已保留为 [M3 / 02 快照](history/m3-02-source.zip)。

## 实际浏览器检查

| 路径 | 观察结果 |
| --- | --- |
| 390×844 普通报告阅读 | 同一 #2101 报告的首个 finding 标题从约 Y=1137px 提前至 Y=763px，标题底部约819px，完整进入首屏。完整来源信息仍可展开，Validation 常驻 |
| PR 第二页→Source→Report→Task→返回 | 保留 PRs 5/6 的起始队列；返回原 PR 第二页；未跳回各自的无关目录 |
| 320px 报告队列 | Previous/Next 图标操作有名称，Reports 1/3→2/3 指向正确下一份报告，队列控件没有越界 |
| URL 与刷新 | 搜索 `s`、第二页产生 `q=s&lp=2`，刷新恢复相同搜索及页码；显式 finding 26/P0 链接定位正确；同文档换成 finding4/Needs verification 后按显式 URL 恢复 |
| URL 非白名单 | 测试 role/draft 参数没有改变当前账号或注入私稿；复制生成器仅使用 origin、pathname 和白名单 hash，不继承原 URL query |
| 完整已选集合 | 选25条后筛选只剩finding4，Review selected 显示24条被过滤隐藏；移除8只减为24，筛选和当前finding保持 |
| 已选项移除焦点 | 首次实测发现焦点落到不可见的Remove1，已修；复测移除8后聚焦可见的Remove9，关闭仍能返回原触发器 |
| 当前草稿保存并下一项 | finding25填写私稿后进入26/第二页，选中数仍为0，没有准备/发布动作；返回25可读到保存内容。最终焦点为 Copy finding link 26，h2约Y=36px，未被上沿切掉 |
| 准备正文变更 | 反馈A生成准备正文后，反馈改为B，再次准备显示Out of date；取消替换保留A，确认替换仅为B，没有A+B。精确预览展示当前选中ID及正文依据 |
| 跨账号未决操作 | admin将正文B提交为unknown，退出并登录reviewer。reviewer只见未决摘要，无法看到正文B，没有reconcile按钮；不能用新prepare覆盖未决操作 |
| 浏览器Back/Discard/Forward | 初次实测暴露Forward丢详情，已修异步history时序。同脚本复测：Discard后回Reports，Forward恢复#2101详情 |
| 返回原行焦点 | 初次实测返回后焦点在屏幕外主导航，已修opener恢复。复测焦点为`ar-source-reports-2103`，边界约337–506px，处于844px视口内 |
| 净变化保存 | Static intake关闭后显示1项变更、Save启用；改回原值后显示No unsaved changes、Save禁用，版本未增加 |
| Repository页签 | Replies写入URL；刷新仍显示对应模板编辑器，正文未进入URL |
| Webhook恢复闭环 | 失败事件→retry attempt2→显式模拟再次失败→新retry attempt3→显式模拟成功；历史保留初始失败、两次调度及两个结果，共5条；成功仅关联已有本地Task/Publication |
| 取消与清理 | #2203取消后仍在Active中，显示cleanup pending及责任Worker；普通刷新保持ownership；仅模拟cleanup后释放。终态显示Cancelled、Saved checkpoint · Partial、No accepted result |
| 旧报告不可变 | 清理完成后旧报告仍为Interrupted / Partial / Checkpoint / Not run，没有被当前Task终态改写 |

最终对22个列表、详情、登录和NoTask组合分别检查1440、900、390、320px，共 **88组布局**：每页一个主标题，没有页面级横向溢出或非表格控件越出视口。检查期间没有捕获到页面error日志。

## 其他验证层

- `node --check`：core.js、operations.js、compose.mjs通过。
- 核心模块最终提供79项隔离断言，包含URL白名单、上下文队列、私稿/选中集合、actor、history时序、NoTask、opener及终态语义。
- 运营模块12项流程与156个渲染/重复ID检查通过；独立审查另复核8项。
- 最后独立源码复查确认既有P0、权限、unknown、不可变报告、URL白名单及新返回行为未被破坏，在本轮指定范围内没有新增可执行问题。
- 新增workflow样式继续使用既有M3颜色角色；粗指针Report context与finding链接目标补齐48px约束。尺寸优先级为静态CSS检查，未声称完成真实触屏验证。

剪贴板字符串生成、禁止内容排除和降级路径有代码/隔离检查；实际浏览器重点验证链接恢复，不将所有平台的剪贴板权限行为声明为已测。完整屏幕阅读器、真实后端、运行时媒体、网络故障和外部发布仍不在本原型验收范围。

## 本轮循环结论

续轮经过任务路径评审、功能修改、独立复审和浏览器反馈修正。浏览器新发现的前进后退、移除焦点、下一项到达、返回原行及终态文案问题均已修正并复测；最终检查没有新增范围内可执行项，本轮收敛。

这不是“以后不会再有优化”的保证。新增用户场景、真实数据规模和产品接入仍可能带来新问题。产品API落地约束见 [FUNCTIONAL-CHANGES.md](FUNCTIONAL-CHANGES.md)。

没有修改apps、Server或contracts，没有运行产品build、安装依赖、发出真实GitHub写入或Worker操作。所有凭据输入和结果均为合成演示。刷新恢复URL视图，但不会保留模拟执行状态或未持久化私稿。
