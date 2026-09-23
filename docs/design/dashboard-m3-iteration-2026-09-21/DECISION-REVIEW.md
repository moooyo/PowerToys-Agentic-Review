# M3 / 04 · GitHub 入口、结论与下一步

2026-09-22。继续仅修改设计与交互原型；未修改 `apps/dashboard`。上一版独立预览保存在 [history/m3-03-preview.zip](history/m3-03-preview.zip)。

## 本轮改动

来源、Task、Report 详情增加「GitHub PR / Issue #编号」入口；Comment 和 Webhook 详情也提供对应入口。使用记录自身的仓库全名、来源类型和编号，不使用 Task ID 或当前全局仓库范围。原生链接在新标签打开，带 `noopener noreferrer` 和可访问名称。缺失合法来源元数据时显示原因，不生成错误链接。

当前数据仍是合成样例 `example/dashboard-ui-fixture`，链接旁明确标注 **Sample target**，不声称这些目标真实存在。打开的是 GitHub 当前页面；报告证据仍对应保存的 snapshot/commit。

来源、Task 和 Report 展示同一保存结论，顺序调整为 **结论 → 建议下一步 → 证据**。报告元数据仍可展开。Task 当前执行状态单独显示；来源和报告列表直接显示结论与建议，Task 列表同时显示执行状态和保存结论。

| 样例 | 显示结论 | 验证/决策边界 | 推荐入口 |
| --- | --- | --- | --- |
| PR #2101 | Changes needed | 两个 source-confirmed P1；E2E Not run | Prepare request changes |
| PR #2102 | Changes needed | 26 findings 含未解决 P0；E2E Not run | Prepare request changes；P0 仍阻止 Approve |
| PR #2103 | No final conclusion | Partial / Checkpoint；预算耗尽 | Review resume budget；恢复后改为 Follow latest attempt |
| PR #2202 | No final conclusion | Validation Blocked | Inspect prerequisites |
| PR #2203 | No final conclusion | 保存 checkpoint 与当前运行独立 | Follow latest attempt；取消时跟踪 cleanup |
| Bug #3101 | Needs verification | Reproduction: Not run；根因未确认 | Prepare verification → 精确 commit → 前提检查 |
| Feature #3102 | Needs decision | 依赖、默认值、兼容性待决定；Draft plan | Prepare clarification comment |

Completed / Complete / Final 只表示对应执行或交付属性，不代表「通过」「已复现」「已接受」。`changes-requested` 在界面显示 **Changes needed**，避免暗示已经向 GitHub 提交 Request changes。部分报告一律标明 **Checkpoint assessment · Not final**。

## 推荐动作的交互规则

- 推荐入口选择相应 operation，已有非空正文保留；只有空正文才填入建议文本，并标为独立手写稿。保留选中反馈变化检测与精确预览。
- GitHub 相关动作仍经过准备、精确预览和独立确认。推荐不是已执行的动作，也不是授权。
- 准备要求 `action:prepare` 和对应 capability；follow-up 另需 `task:create` 和 repository execution。`action:execute` 用于最终确认，不能混入准备授权。
- Bug follow-up 使用 `start-task`，PR follow-up 使用 `reviews.verify`。通用操作选择器、提交 handler 和推荐按钮共用权限判断。
- 缺权限时显示具体原因；保存计划、证据和 GitHub 来源仍可查看。来源变更或刷新失败不会关闭来源链接。
- 有未知提交时，推荐变为检查原 submission；其他账号只看到等待摘要，不接触原 payload 或产生新提交。
- 保存 assessment 不随 Resume / cancellation 改写；下一步从当前 Task 和 ActionContext 推导。旧报告导出继续携带原保存 assessment。

为让新流程可演示，仅给合成 `demo.admin` 增加 `start-task` 和 `reviews.verify` capability；没有修改真实账号或权限。`demo.reviewer` 仍只有 Comment capability。

## 产品落地映射

复用现有 PR `reviewConclusion.status/rationale`、Bug `bugAssessment`、Feature assessment、reproduction/validation 和 saved next actions。不要在前端根据 finding 数量或 Task Completed 推断 review 通过。Report header 已有 assessment，应在首屏展示，不应依赖导出完整报告。

GitHub 目标来自 `repository.fullName` 和 `workItem.kind/number`；支持真实 `pull_request` / `issue` 类型。当前 prototype 显式保存相同来源字段。真实产品继续使用服务端 ActionContext 的 recommendation、canPrepare、readyToExecute 和 guards；不把原型的本地状态机当作授权依据。

移动端优先露出结论和建议名称；完整原因、操作与 findings 依次滚动可达。不再把「首条 finding 尽量首屏可见」作为压过结论的目标。

## 复核与证据

1. 首轮检查发现 Bug 把未执行复现写成 Not reproduced、Feature 把待决策方案写成 Plan ready；已改为 Not run / Needs decision。
2. 独立源码复核发现真实 `pull_request` 类型缺失，以及准备操作缺少 capability 检查；已修正，并再次复核闭合。
3. 浏览器完成 PR 推荐、手写稿保留、P0 Approve 阻止、Bug SHA 校验与精确预览、Feature 澄清推荐、Resume 后保存结论不变、未知提交与跨账号摘要、只读/旧来源入口检查。
4. 12 个详情 × 320 / 390 / 1024 / 1440px，共 48 个布局检查无横向溢出；每页一个正确 GitHub 来源链接，target/rel 正确。另有四个核心列表 × 320 / 1440px，共 8 项检查通过。抽查明暗主题和桌面/窄屏截图。
5. `node --check` 校验 core.js 和 operations.js；静态拼接成功；浏览器未记录 JavaScript error。未运行产品 build。

没有访问合成 GitHub 目标，没有真实 PR、Issue、评论或 Worker 写入。布局检查不等同完整无障碍认证；真实服务端集成和所有合法 assessment 枚举仍需产品落地时验证。本轮范围的最终复核未发现新的可执行问题，不宣称所有未来交互都已穷尽。

`ui-ux-pro-max` 的 `clear next steps` 和缩窄后的 `primary action` 查询均未命中，使用已建立的 Material 3 规则和实际契约推导本次方案。本轮官方站点复查因 Web provider 未配置而未能完成；沿用 [DESIGN.md](DESIGN.md) 已记录的官方资料，未引入新的标准数值主张。
