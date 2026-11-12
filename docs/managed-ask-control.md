# 受管无期限 Ask 退役

`botmux ask control describe|inspect|retire|release --control-file <file>` 使用宿主 IPC 鉴权，不接受普通会话凭证。旧 daemon 不提供此接口时直接失败，不降级为普通 suspend、发送答案或强杀。

控制文件包含 `larkAppId/sessionId/requestId/chatId/rootMessageId/origin`；origin 必须与 daemon 原回执中的 `turnId/workerGeneration/dispatchAttempt` 一致。退役/释放额外包含固定的 `operationId/reason`。字段来自原回执及受管 Session，不按显示名称推导；有限 Ask、Hook、无原轮记录的历史卡不接入。

- 新 opt-in 业务在发卡前生成唯一 `--request-id` 并登记待决事件。只有 `describe` 不要求 origin：凭原 app/session/request/chat/root 五字段只读取得 daemon 已记录的 origin，不能据此改写原轮。观察器随后保存该 origin，所有 inspect/retire/release 必须精确匹配。没有原 origin 或真实送达证据不启动生命周期计时。
- `inspect` 只读返回原卡 ID、实际送达时间、冻结答题人和结算结果。
- `retire` 先持久操作意图，再严格落盘原 broker 的 `invalidated` 结算，解除原等待。原有效答案优先；存储失败不能声称已退役。退役只让原决策失效、不碰任何进程或资源，因此只核对原回执的五字段绑定与 origin，不要求原代次仍持有 worker：daemon 重启、worker 换代、Dashboard 锁定或 adopt 之后仍可退役（`release` 仍会拒绝）。决策已被其它路径判失效时，`retire` 只记录本操作，不再二次结算。
- `release` 必须使用同一退役操作。原轮真正 terminal，后台工作、输入及交付排空，原代次与资源归属仍可核验时，才走既有受管 suspend。异步落盘后、真正拆除前再次核验同一安全谓词。
- 受管 suspend 使用原退役 ID 派生的确定控制 ID，重启/结果未知后的再次 release 只对账同一 operation/runtime。认领前要求 readiness；认领后 readiness 被该操作撤销时仍保留精确 operation/代次/terminal/排空检查。未知不能当无效果结算；只对确定无效果的 applying 拒绝恢复 active。
- 确定 `failed_before_effect/rejected` 后才允许沿该退役 ID 的下一持久尝试序号重新释放；不重写旧操作事件。`uncertain/applying/confirmed` 不分配新尝试，重启由既有持久控制历史恢复同一身份。
- `draining` 表示未释放；`retiring` 表示退役意图已落盘、原 broker 结算尚未确证（卡片仍可能被真人答案抢先，后台会继续补完）；`retired` 表示决策已失效；`suspended` 表示确证挂起；`unknown/conflict` 不等于操作成功。HTTP 超时后先 inspect 原操作，不创建新操作盲重试。

业务生命周期由宿主 opt-in 观察器登记，不内置 MR 查询、提醒时间、调度或自动恢复。原卡送达时刻才可作为业务计时起点。重启恢复未完成的退役意图（会话已关闭或换绑时按普通无期限 Ask 失效处理），不创建新的模型恢复轮；已经退役的结果保留用于原调用重连，迟到旧按钮不授予新授权。

调用方保管原回执和 MR 等业务绑定、一次提醒意图、完成副作用及确认来源。真人恢复须重新验证业务仍有效和当前版本，创建新请求，不重新启用旧卡。普通 Ask、权限 Hook 和有限超时的默认行为保持不变。

本接口交付不代表部署、线上调度已安装或允许处理历史等待。需要独立确认候选版本及运行权限，再做真实新卡验收。
