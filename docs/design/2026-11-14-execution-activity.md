# 可验证执行活动

流式卡、Dashboard 和 observe 使用同一份当前轮执行活动投影。投影检查 worker generation、当前 turn 与 dispatch attempt high-water，拒绝旧进程、旧轮或旧重试的执行记录。

真实工具开始事件优先于模型容量排队横幅。没有可验证来源时阶段为 unknown；没有当前轮的开始时间时不编造运行时长，最后活动时间也只来自实际事件。observe v1 的顶层 phase 继续保持 unknown，新事实放在可选 executionActivity 字段。

模型输出更新 Dashboard 时每秒最多发布一次；工具事件与生命周期变化立即更新。已完成、非工作态或探测失败的会话不携带旧执行事实。改变展示与观测投影，不改变输入投递的认领、回执和重试状态机。
