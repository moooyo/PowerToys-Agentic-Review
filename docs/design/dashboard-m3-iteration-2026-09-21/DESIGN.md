# Agentic Review · Material 3 design system

本轮仅迭代设计和交互原型。保留 [第一版](../dashboard-ux-review-2026-09-21/README.md)，产品源码基线为 `238b1c3`，没有修改 `apps/dashboard`。

## 设计依据与选择

使用已安装的 `ui-ux-pro-max`。首次 `operations dashboard material --design-system` 返回 General / Hero + Features，未匹配审阅工作台；按技能要求缩窄为 `Developer Tools`，匹配 Developer Tool / IDE。该结果的文档 landing page、OLED 默认和配色不是本产品要求，因此没有套用或持久化成设计规范。保留其键盘操作、可读性和明确反馈建议，以实际产品流程和 Material 3 为视觉依据。

定向检索使用 `error summary validation`、`keyboard focus modal`、`touch target size`（UX），以及已确认 React 19 的 `accessible form label` / `focus refs events`。采纳字段旁错误、标签关联、焦点可见、键盘路径和减少动态效果。原型继续使用原生 HTML/JS；不为设计演示迁移产品框架。

Material 依据来自实际读取的官方 [color roles](https://material-web.dev/theming/color/)、[typography](https://material-web.dev/theming/typography/)、[buttons](https://material-web.dev/components/button/)、[dialogs](https://material-web.dev/components/dialog/)，以及官方 [shape](https://github.com/material-components/material-web/blob/main/tokens/versions/v0_192/_md-sys-shape.scss)、[type scale](https://github.com/material-components/material-web/blob/main/tokens/versions/v0_192/_md-sys-typescale.scss)、[state](https://github.com/material-components/material-web/blob/main/tokens/versions/v0_192/_md-sys-state.scss) token。`m3.material.io` 返回动态页面壳，具体值采用可读取的官方 Material Web 定义，不声称已读取该站完整动态正文。

## 视觉规则

| 角色 | 本原型的选择 |
| --- | --- |
| 色彩 | 保留产品蓝 `#345EAD`；分别定义 on-primary、primary/secondary container、surface low/container/high、on-surface、outline 与 outline-variant；明暗配对 |
| 操作 | 单一强调主操作；普通填充/描边/文字按钮可见高度 40px；粗指针交互目标提升至 48px；Hover/Pressed 使用语义状态层 |
| 字级 | 页面 28/36，窄屏 24/32；区块 22/28；正文 16/24、密集列表 14/20；元信息 12px；400/500 字重 |
| 形状 | 输入 4px、filter chips 8px、列表/卡片 16px、对话框 28px、按钮 full；避免相近但无角色的任意圆角 |
| 图标 | 同一套 Lucide，常用 20/24px；装饰图标隐藏于辅助技术，图标操作有明确名称。独立版本内嵌本机已有 Lucide 1.8.0，保留许可证，无网络加载 |
| 层级 | 页面与主要区块靠字级、间距和 surface 区分；保留标题、信息、操作的顺序，不新增无数据依据的指标卡 |
| 窄屏 | 保留四个主分组；来源完整筛选进入面板并显示条件摘要；报告工具渐进展开，finding 选择与前后切换常驻；运营表格按带标签的记录重排 |
| 焦点与错误 | 单行单一详情入口；局部刷新恢复控件焦点；原生导航按钮使用 aria-current，不伪装不完整的 tablist；错误摘要和字段旁文案关联 |

主色文字配对和交互边界按实际相邻颜色计算。粗指针 48px 是本轮 Material 触控体验选择，不把它误称为所有 Web WCAG AA 控件的统一门槛。完整屏幕阅读器、真实触屏和所有缩放环境不在本次验证声明中。

## 信息架构

沿用当前 Review、Tasks、Activity、Workspace 四组和 10 个目的地，My account 位于账户菜单，登录是独立入口。没有创建与当前产品功能脱节的统计总览。

来源、调查、报告和操作之间始终保留明确的关系。全局仓库范围跨业务导航继承；管理列表清楚标注 workspace-wide。恢复列表包含搜索、筛选和分页。查看旧报告不会因任务恢复而改变报告。

报告保持五种独立语义：execution、completeness、delivery、assessment、validation。Completed 不代表 E2E 通过。P0 限制使用完整集合；定位 P0 会清除冲突筛选，并告诉用户筛选发生变化。

操作顺序是私有草稿 → 精确预览 → 单独确认 → 回执。未知结果保留同一 intent，不产生新提交。Issue 普通动作展示 issue snapshot；跟进动作展示实际选择的完整 SHA。权限来自当前模拟账户的独立 grants，不用 Administrator 字符串代替仓库/动作/执行权限。

## 交付边界

所有 Task、账号、权限、报告、SHA、intent 和操作回执均为合成示例。页面没有后端 API、GitHub、Worker 或凭据网络调用。没有真实媒体 bytes 的证据只显示来源与不可用状态；不制造可播放文件或伪造验证成功。

原型覆盖现行目的地及主要可达流程，不把本地状态机当成生产认证/版本并发/幂等/调度/清理协议的验证。实现产品时仍须根据实际 API 和完整集合查询能力接入。
