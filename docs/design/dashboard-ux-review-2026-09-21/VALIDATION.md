# 本次交付验证

验证对象为本目录中的静态交互原型，使用独立合成数据。没有启动、构建或修改生产 Dashboard，也没有请求真实 API、启动 Worker 或写入任何仓库的 PR/Issue。

## 评审证据

- 源码基线：`238b1c3`，读取现行路由与 `src/investigation` 实现。
- 视觉基线：实际查看仓库保存的 14 张生产构建合成数据截图：0005、0008、0022、0043、0016、0018、0055、0098、0028、0049、0012、0051、0053、0021。
- 上述截图来自先前验收，不能视为本次运行当前产品的结果。

## 原型检查

| 检查 | 结果与范围 |
| --- | --- |
| JavaScript 语法 | `node --check` 检查 core.js、operations.js、compose.mjs 通过 |
| 无后端依赖 | 源码检查没有 fetch、XHR、WebSocket；链接中的 GitHub URL 仅为输入示例，不发送请求；没有 package install 或产品 build |
| 全部页面 | 浏览器以 1024px 打开 10 个目的地和登录页，均有内容；检查期间未出现浏览器 error 日志 |
| 窄屏 | 320px 检查 PR 列表、Task/Report/Comment/Webhook 详情、Workers、Repository、Account 编辑、My account、Sign in，共 10 个页面组合；页面宽度没有超出视口。Report 交互控件另查边界，无页面外裁切；表格允许局部滚动 |
| 视觉抽检 | 查看默认桌面、320px 登录与报告、390px 报告截图；修正手机顶部快捷键占位和登录页多余工作区外壳 |
| 列表上下文 | PR 搜索 `settings` → 详情 → 返回后查询保留；Task 第二页进入中断记录；列表按 4 条合成记录分页 |
| 错误状态 | Tasks 加载失败只显示失败与 Retry，没有同时显示“没有任务” |
| P0 与完整集合 | 报告 26 个 findings，可直接定位第 26 条 P0；Approve 提交准备被拒绝并显示原因 |
| 恢复与报告不可变 | 耗尽 20,000 tokens 时原额度被拒绝，改为 30,000 后恢复；旧报告仍为 Interrupted / Partial / Checkpoint |
| 准备与未知结果 | 正文进入精确预览，返回准备保留正文；unknown 后跨 Task/Report 导航仍保留同一 intent，核对显示新提交数 0 |
| 未保存保护 | 编辑 action 后 Ctrl+K 出现离开保护；Keep editing 保留正文。编辑 finding 后浏览器 Back 同样触发保护并保留输入 |
| 评论筛选 | More filters 可打开 Exact Task ID；筛选 `task-2102` 后只剩相应记录，打开评论再跳转到匹配 Task |
| Worker | Disable E2E admission 显示仅影响 E2E 的后果；保存后刷新仍为 Awaiting cleanup，静态能力保留 |
| Webhook | Retry event handling 进入 Retry scheduled，没有创建/重启 Task；时间线保留前次 Source import Failed，并显示下一次已排队 |
| 辅助逻辑检查 | 独立模块检查覆盖 48 个运营页面/场景组合和 11 项核心状态转换。这些检查不替代浏览器或真实产品测试 |

这些检查通过浏览器访问仅绑定 `127.0.0.1` 的临时静态预览完成。直接打开 `file://` 的额外检查被浏览器 URL 安全策略阻止，未绕过；因此不把“浏览器直接本地文件打开”计为已通过。独立 HTML 已生成且包含全部 CSS/JS，对话内片段也不依赖该临时服务。

未运行自动化无障碍审计或实际触屏模拟；coarse pointer 的按钮尺寸只检查了 CSS 优先级。主题颜色使用产品语义变量及 light-dark 配对，本次没有将深色/所有交互组合声明为完整验收。

## 证据限制

原型中的账户角色、版本、来源 SHA、digest、Task、Report、Intent 和回执都是合成演示。确认按钮只产生本地模拟结果。它不能验证后端鉴权、幂等性、真实网络故障、数据一致性、GitHub 投递、Worker 资源占用或应用清理。

没有真实 artifact 字节的媒体显示不可用及来源信息，不伪造可播放视频或下载成功。真实媒体播放、屏幕阅读器输出、完整键盘验收及实际产品的多环境运行保留为后续验证项。
