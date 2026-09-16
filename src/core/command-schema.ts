/**
 * 命令 schema —— botmux 自有斜杠命令的**唯一事实源**（设计
 * docs/design/2026-09-11-command-router.md R4 / §4）。
 *
 * 今天命令的"注册"散在五个裸集合里（`DAEMON_COMMANDS`、`SESSIONLESS_DAEMON_COMMANDS`、
 * `EXISTING_SESSION_ONLY_DAEMON_COMMANDS`、`MULTILINE_COMMANDS`、`FORCE_TOPIC_COMMANDS`），
 * 外加 daemon 两条入口里逐个 `if (cmd === '/xxx')` 的前置特判，没有任何一处声明子命令与
 * 参数形状。这里把它们收成一张表；那五个集合从表**推导**（下方导出，名字不变，消费方无感），
 * 路由器（command-router.ts）与 `/help`、doc-sync 守卫都读这张表。
 *
 * 表里只放**有消费者、被测试钉住**的字段：名字/别名、会话政策、前置特判、多行豁免、help 键。
 * 参数形状（整行 / 按空白切 / 子命令）今天仍由 `handleCommand` 各 case 自己解析，这里刻意
 * **不**登记——没有消费者的字段只会悄悄过期（2026-09-16 删掉了 PR-2 留下的 `argShape` /
 * `subcommands`）；将来若把参数解析收进解析器，届时按 case 逐条建表并同时接上消费者与守卫。
 * `notes` 是自由文本备注，不装成数据。
 *
 * 依赖：零 import（leaf）。`passthrough-commands.ts`、`command-handler.ts`、
 * `command-trigger.ts` 都从这里取集合，card-builder 等更下游的模块经它们再拿，依赖方向不变。
 */

/** 无会话时路由怎么处理这条命令（设计 §5 矩阵的 `none` 列）。 */
export type CommandSessionPolicy =
  /** 无会话则先预建一条 worker:null 会话再交给 handleCommand（今天的通用分支）。 */
  | 'default'
  /** 从不建会话：`/group` `/sessions` 这类只作用于群/机器本身的命令。 */
  | 'sessionless'
  /** 只对已有会话有意义：无会话时直接进 handleCommand 的 `!ds` 分支回 no_active_session。 */
  | 'existingOnly';

/** 路由入口在 `parseSlashCommandInvocation` 之后、透传闸之前/之内的前置特判处理器。 */
export type CommandSpecialHandler = 'sessions' | 'vc-auth' | 'card' | 'cot' | 'term';

export interface CommandSpec {
  /** 主名，含前导 `/`，小写。 */
  readonly name: string;
  /** 别名（fallthrough case），含前导 `/`。 */
  readonly aliases?: readonly string[];
  readonly sessionPolicy: CommandSessionPolicy;
  /**
   * 前置特判：不进 `handleCommand` 的 switch，而由路由入口直接派给专属处理器，从不建会话。
   * 两条入口同一张表（`/card` `/cot` 在 PR-2 收敛：此前 thread 入口无特判、无会话时会预建
   * 幽灵会话，§9 有意变化；`/term` 此前在 thread 入口位于透传闸之后，但透传集与 daemon 命令
   * 恒不相交，先后不可观测，故不再区分位置）。
   */
  readonly special?: CommandSpecialHandler;
  /** 允许多行正文（`parseSlashCommandInvocation` 的多行豁免）。 */
  readonly multiline?: boolean;
  /** `/help` 组装用的 i18n 键；空数组 = `/help` 不展示（今天只有 `/cli`）。 */
  readonly help: readonly string[];
  /** 备注：今天解析上的怪异处，收进解析器时要逐条决定保留还是列为有意变化。 */
  readonly notes?: string;
}

export const COMMANDS: readonly CommandSpec[] = [
  { name: '/close', sessionPolicy: 'default', help: ['help.close'] },
  { name: '/restart', sessionPolicy: 'default', help: ['help.restart'] },
  { name: '/status', sessionPolicy: 'default', help: ['help.status'] },
  { name: '/retry', sessionPolicy: 'default', help: ['help.retry'] },
  { name: '/help', sessionPolicy: 'default', help: ['help.help'] },
  { name: '/insight', sessionPolicy: 'default', help: ['help.insight'] },
  { name: '/detach', aliases: ['/disconnect'], sessionPolicy: 'default', help: ['help.detach'] },
  { name: '/cd', sessionPolicy: 'default', help: ['help.cd'], notes: '剥命令名的正则大小写敏感' },
  {
    name: '/repo', sessionPolicy: 'default',
    help: ['help.repo_list', 'help.repo_n', 'help.repo_path', 'help.repo_wt'],
    notes: '贪婪是 form 级：裸 `/repo <参数>` 整行当路径（#1361 D7）；`/repo wt <目标> [分支]` 按空白切、1..2 个 token；无会话时任何参数形式都落到选仓卡路径',
  },
  { name: '/rename', sessionPolicy: 'existingOnly', help: ['help.rename'] },
  {
    name: '/schedule', sessionPolicy: 'default', multiline: true,
    help: ['help.schedule_create', 'help.schedule_list', 'help.schedule_remove', 'help.schedule_toggle', 'help.schedule_run', 'help.schedule_formats'],
    notes: '动词形只取一个 id，尾部多余文本静默忽略；其余整段（含换行）当自然语言排程',
  },
  {
    name: '/role', sessionPolicy: 'default', multiline: true,
    help: ['help.role_show', 'help.role_set', 'help.role_team', 'help.role_cap', 'help.role_profile'],
    notes: '`set` 吃多行 Markdown 正文',
  },
  {
    name: '/botconfig', sessionPolicy: 'sessionless',
    help: ['help.config_get', 'help.config_set'],
  },
  {
    name: '/skills', sessionPolicy: 'sessionless', help: ['help.skills'],
  },
  { name: '/pair', sessionPolicy: 'default', help: ['help.pair'] },
  {
    name: '/login', sessionPolicy: 'default', help: ['help.login', 'help.login_status'],
  },
  { name: '/adopt', sessionPolicy: 'default', help: ['help.adopt', 'help.adopt_pane'] },
  {
    name: '/oncall', sessionPolicy: 'default',
    help: ['help.oncall_bind', 'help.oncall_unbind', 'help.oncall_status'],
  },
  {
    name: '/project', sessionPolicy: 'sessionless', help: ['help.project'],
    notes: '多一个 token 即 unexpected_arguments，是所有命令里 arity 最严的',
  },
  { name: '/group', aliases: ['/g'], sessionPolicy: 'sessionless', help: ['help.group'] },
  { name: '/relay', sessionPolicy: 'default', help: ['help.relay', 'help.relay_create'] },
  { name: '/quote', sessionPolicy: 'existingOnly', help: ['help.quote'] },
  { name: '/fork', sessionPolicy: 'existingOnly', multiline: true, help: ['help.fork'] },
  { name: '/forklist', sessionPolicy: 'existingOnly', help: ['help.forklist'] },
  {
    name: '/card', sessionPolicy: 'default', help: ['help.card'],
    special: 'card',
    notes: 'PR-2 收敛：thread 入口原先没有特判，无会话时会预建幽灵会话；`pin off` 类子命令按整串全等比较',
  },
  {
    name: '/cot', sessionPolicy: 'default', help: ['help.cot'],
    special: 'cot',
    notes: 'PR-2 收敛：thread 入口原先没有特判',
  },
  {
    name: '/term', sessionPolicy: 'default', help: ['help.term'],
    special: 'term',
  },
  { name: '/list-slash-command', aliases: ['/slash'], sessionPolicy: 'sessionless', help: ['help.list_slash'] },
  {
    name: '/subscribe-lark-doc', sessionPolicy: 'default', help: ['help.subscribe_doc'],
  },
  {
    name: '/watch-comment', sessionPolicy: 'sessionless', help: ['help.watch_comment'],
    notes: '按参数分叉：真正开始监听（kind=watch）时需要会话，其余子命令无会话（isSessionlessCommandInvocation）',
  },
  {
    name: '/vc', sessionPolicy: 'default', help: ['help.vc'],
  },
  {
    name: '/vc-auth', sessionPolicy: 'sessionless', help: ['help.vc_auth'],
    special: 'vc-auth',
    notes: '唯一没有 handleCommand case 的命令：只存在于两条入口的前置特判',
  },
  {
    name: '/dashboard', sessionPolicy: 'sessionless', help: ['help.dashboard'],
  },
  {
    name: '/sessions', sessionPolicy: 'sessionless', help: ['help.sessions'],
    special: 'sessions',
    notes: '授权在 canTalk 级（canTalkForGroupSessions），不是 canOperate',
  },
  {
    name: '/issue', sessionPolicy: 'sessionless', help: ['help.issue'],
  },
  {
    name: '/cleanup-wt', sessionPolicy: 'sessionless', help: ['help.cleanup_wt'],
    notes: '恰好 1 个 token（清理任务 ID）；主干 #956 引入，rebase 时与 oracle 同步登记',
  },
  { name: '/cli', sessionPolicy: 'default', help: [], notes: '恰好 1 个 token；`/help` 不展示' },
];

/** 话题路由元命令：由 `parseTopicHeader` 在命令表之前拦截，不在 `DAEMON_COMMANDS` 里。
 *  `/th` `/tw` 是生命周期别名（= `/t here` / `/t worktree`），同样是保留命令（触发 API 里须 @）。 */
export const FORCE_TOPIC_COMMANDS: ReadonlySet<string> = new Set(['/t', '/topic', '/th', '/tw']);

function namesOf(spec: CommandSpec): string[] {
  return [spec.name, ...(spec.aliases ?? [])];
}

const BY_NAME: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.flatMap(spec => namesOf(spec).map(n => [n, spec] as const)),
);

/** 按命令 token（含别名，小写）查 spec。 */
export function commandSpec(cmd: string): CommandSpec | undefined {
  return BY_NAME.get(cmd.trim().toLowerCase());
}

// ─── 从表推导的集合（名字与今天一致，消费方无感） ─────────────────────────────

/** botmux 自己处理（而非透传给 CLI）的斜杠命令，含别名。 */
export const DAEMON_COMMANDS: Set<string> = new Set(COMMANDS.flatMap(namesOf));

/** 从不建会话的命令（`/watch-comment` 还按参数二次判定，见 isSessionlessCommandInvocation）。 */
export const SESSIONLESS_DAEMON_COMMANDS: Set<string> = new Set(
  COMMANDS.filter(s => s.sessionPolicy === 'sessionless').flatMap(namesOf),
);

/** 只对已有会话有意义、路由绝不为它预建会话的命令。 */
export const EXISTING_SESSION_ONLY_DAEMON_COMMANDS: Set<string> = new Set(
  COMMANDS.filter(s => s.sessionPolicy === 'existingOnly').flatMap(namesOf),
);

/** 允许多行正文的命令（`parseSlashCommandInvocation` 的豁免名单）。 */
export const MULTILINE_COMMANDS: Set<string> = new Set(
  COMMANDS.filter(s => s.multiline).flatMap(namesOf),
);

/** 路由入口前置特判：命令 → 处理器。 */
export const ROUTE_SPECIAL_COMMANDS: ReadonlyMap<string, CommandSpecialHandler> = new Map(
  COMMANDS.filter(s => s.special).flatMap(s => namesOf(s).map(n => [n, s.special!] as const)),
);
