# Daemon 派发与报告的来源检查

依赖消息写前保护候选。topicUnavailablePolicy=stop 时，daemon 在创建派发 seed、委托发送与报告 relay 的实际副作用前核验已冻结的原话题；目的地、接收会话或后来 turn 不替代原来源。显式无话题来源记录为 null，缺少话题证据与无话题是不同状态。

原 session 对象与 managed turn 的 turnId/dispatchAttempt/capability 在异步查询前后保持一致；排队重试不得借用替换后的执行。共享 Lark transport 在每次实际 SDK 尝试前调用同一检查，所以限流期间来源变化仍会拒绝写入。目标消息的查询沿共享 transport，daemon 不再增加一份重复查询。

报告 relay 复用原请求、鉴权和 fallback 规则；在首次 trigger POST 和读取 fallback 目标后再次 POST 之前调用 beforeWrite。没有回调时不增加空等待。自动零提示报告同样沿已签名 dispatchRoot 检查来源。来源拒绝保留原回执，不自动改发其它地方。

本候选不增加报告 publish 模式、业务阶段或平台 Ask 协议。跨主体独立请求、自动建群、fork 启动、worker 自动结果和 workflow 还有独立的调用方边界，不由本候选推断完成。来源检查与远端提交不组成原子事务。

CLI dispatch 的 repo prime 使用进程树证明的原 session/turn，显式 session-id 与新建 seed 不替换来源；每次实际发送或重试前重查。明确无话题的群会话可继续，线程来源缺少消息身份必须暂停。既有 repo 命令、admission 与 receipt 协议保持。
