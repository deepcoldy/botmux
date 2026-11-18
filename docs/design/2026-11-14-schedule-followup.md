# Schedule 跟进落点与结果

同群真实话题中创建 --until-done 任务时，默认沿用原话题；明确指定 top-level、new-topic、topic 或 follow-active 始终优先，跨群不继承来源话题。常规报告保持顶层默认。

CLI 创建回执、Lark 详情卡和 Dashboard 使用共享支持信息：执行位置、首次与后续检查频率、通知对象及条件、停止条件、最后已知结果、连续失败、到期原因。通知是既有 failing/expired 创建人通知，不把条件名当作收件人。自然语言 /schedule 建不出 until-done 或带通知的任务，回执保持原样；Lark 详情卡已有执行位置行，支持信息里的「上次结果」取代原来的原始状态行。匿名只读看板不下发 doneNote。

untilDone.status 是业务完成与到期的事实源，doneNote 可省；lastStatus=ok 只证明检查已派发。一次触发的 until-done 任务同时显示后续 retryMinutes（省略时为既有默认 24 小时），避免把首次延迟当成反复检查频率。未知历史计数不显示为零。
