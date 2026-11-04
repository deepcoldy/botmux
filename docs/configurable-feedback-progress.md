# 可配置反馈卡与动作扩展

状态：开发中，已有主链路接入，仍不满足完整设计验收，不可部署。

## 本次基础变更

- `feedbackPresentation` 提供 bot 默认、群规则和具体问题规则。
- 具体问题覆盖群规则；数组整体替换；同 selector 或 id 重复时报错。
- `rounds` 必须是升序、无重复的正整数；未配置默认关闭。
- 现有反馈按钮定义不复制到展示配置，后续 renderer 必须使用原 delivery 的反馈策略。
- 配置写入和重载共用规范化；直接写入无效展示规则也会拒绝。
- 宿主 Hook 注册类型和校验器约束命令参数、工作目录、作用域及秘密引用，已接入注册 UI 和执行器。

## 剩余交付

已加入事件流、独立扩展库、表单/JSON 模板预览、Hook 注册/订阅/任务执行、回调原回答映射和基础显示重试。

仍需闭合：

1. 已有 `botmux feedback bind --file binding.json` 及当前回合、同群/话题校验；普通群/代理交付全链验证尚未完成。
2. 已有标题、主题、间距、按钮排列样式表单及高级模板 JSON；通用布局/素材控件和完整状态展示仍待补。
3. 已有 Hook unknown 人工核对入口及一次性 pre-effect 重试；surface unknown 核对和最终跨进程/重复点击验证待补。
4. 多 surface 的完整展示一致性、回调/发送/配置撤销交叠验收。
5. 最终独立审核和全部必要回归；不把构建或专项通过当作完整生产验证。

独立反馈卡不能作为新回答计入统计；预览/保存不能执行脚本；结果未知不能自动重复业务写入。默认不得改动运行中的配置、迁移共享反馈库或重启服务。

## 数据源约束

新增 `readFeedbackEventsAfter()` 提供顺序流：SQLite 增量触发器和 PostgreSQL 事务计数器。PostgreSQL 业务写入采用统一锁序；读流不取得业务写锁。主反馈库 user_version 保持 8，扩展业务状态单独存储。

存储后端切换后 generation 改变，消费者从新源起点读取，依靠稳定事件/操作身份避免重复副作用；序号不宣称跨后端保持一致。已安装流的 SQLite 迁移路径有真实临时 PostgreSQL 验证。

## 验证

本批专项测试：

```sh
bun run test test/bot-config-store.test.ts test/feedback-presentation.test.ts test/feedback-hook-config.test.ts
```

相关回归 497 项通过；真实临时 PostgreSQL 提交顺序测试及带流的正常迁移通过。完整构建在本轮中间增量通过，最终增量需重跑。

全量 unit 尝试：42916 passed、158 failed、171 skipped。部分失败涉及宿主文件监听资源耗尽；`schedule-store-dashboard-watch.test.ts` 在干净上游基线同样因 EMFILE 失败。其余失败尚未逐项归因，不宣称全量通过。
