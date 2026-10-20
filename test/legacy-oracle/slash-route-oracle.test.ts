import { describe, it, expect } from 'vitest';
import {
  legacySlashRoute,
  ORACLE_DAEMON_COMMANDS,
  ORACLE_PASSTHROUGH_COMMANDS,
  type OracleDecision,
  type OracleInput,
  type OraclePhase,
} from './slash-route-oracle.js';

/**
 * 冻结 oracle 的自检：把 `docs/design/2026-09-11-command-router.md` §9 兼容表里
 * **能用 oracle 表达**的每一行钉成断言。这些断言描述的是「今天的行为」——它们变红
 * 说明 oracle 与 src 之间的转写出了偏差，或者有人改了老路由，而不是新路由器有 bug。
 *
 * 不在这里断言的 §9 行（超出 oracle 边界）：`/repo` 尾参贪婪性（在 handleCommand 内部
 * 解析，oracle 只到 cmd 一层）、`#1361` D6/D9 的 `/t` 头部语义（parseTopicHeader 是
 * 上游层）、commandTrigger 双 lane（上游层）、`reservedCommandKind` 兜底（上游层）。
 */

// claude-code / codex 今天声明的 adapter 级冷启动透传（isInitialSessionPassthrough）。
const COLD_START_GOAL: ReadonlySet<string> = new Set(['/goal']);
const NO_COLD_START: ReadonlySet<string> = new Set();

function route(text: string, over: Partial<OracleInput> = {}): OracleDecision {
  return legacySlashRoute({
    text,
    context: 'new-topic',
    phase: 'none',
    passthrough: ORACLE_PASSTHROUGH_COMMANDS,
    coldStartPassthrough: NO_COLD_START,
    senderIsBot: false,
    acceptSlashFromBots: true,
    ...over,
  });
}

describe('legacy oracle: parse 层（parseSlashCommandInvocation 的逐字拷贝）', () => {
  it('`/adopt <pane>`：首行含尖括号占位符 → 讨论文本，转发给 CLI', () => {
    // §9「会话内首行含 <…> 占位符不认命令」/ test/command-handler.test.ts:1533
    expect(route('/adopt <pane>')).toEqual({ kind: 'forward', reason: 'discussion' });
  });

  it('不以 `/` 开头（`关于 /t 这个命令`）→ no_slash', () => {
    expect(route('关于 /t 这个命令')).toEqual({ kind: 'forward', reason: 'no_slash' });
  });

  it('`/schedule` 多行 → MULTILINE 豁免，仍是 daemon 命令', () => {
    // §9「MULTILINE_COMMANDS 多行豁免」/ test/command-handler.test.ts:1547
    const d = route('/schedule 每天 9 点\n提醒我看 PR');
    expect(d).toEqual({
      kind: 'daemon',
      cmd: '/schedule',
      content: '/schedule 每天 9 点\n提醒我看 PR',
      sessionPolicy: 'precreate',
    });
  });

  it('`/role` 多行 → 同样豁免（§9 标注今天缺用例的那条）', () => {
    expect(route('/role 你是评审\n只看安全问题')).toMatchObject({
      kind: 'daemon',
      cmd: '/role',
      sessionPolicy: 'precreate',
    });
  });

  it('`/fork` 多行 → 豁免且落 existing_only', () => {
    expect(route('/fork 试另一条思路\n保留原话题')).toMatchObject({
      kind: 'daemon',
      cmd: '/fork',
      sessionPolicy: 'existing_only',
    });
  });

  it('非 MULTILINE 命令带第二行 → 讨论文本', () => {
    expect(route('/close\n顺手把话题收了')).toEqual({ kind: 'forward', reason: 'discussion' });
  });

  it('后续行还是 `/` 开头（命令清单）→ 讨论文本，即使首行是 MULTILINE 命令', () => {
    expect(route('/schedule 列表\n/close')).toEqual({ kind: 'forward', reason: 'discussion' });
  });

  it('两端 trim：尾随换行不进 content（raw_input 逐字透传的契约）', () => {
    expect(route('/compact  \n', { passthrough: ORACLE_PASSTHROUGH_COMMANDS }))
      .toMatchObject({ kind: 'passthrough', cmd: '/compact', content: '/compact' });
  });

  it('首 token 大小写不敏感（toLowerCase）', () => {
    expect(route('/CD /tmp/x')).toMatchObject({ kind: 'daemon', cmd: '/cd' });
  });
});

describe('legacy oracle: bot 门（botAcceptsSlashFromBots）', () => {
  it('bot 发送者且 acceptSlashFromBots=false → bot_gated，在 parse 之前', () => {
    // §9「botAcceptsSlashFromBots」/ test/daemon-rename-route.test.ts:3091 /:3130
    expect(route('/repo botmux', { senderIsBot: true, acceptSlashFromBots: false }))
      .toEqual({ kind: 'forward', reason: 'bot_gated' });
    expect(route('/repo botmux', { context: 'thread', phase: 'running', senderIsBot: true, acceptSlashFromBots: false }))
      .toEqual({ kind: 'forward', reason: 'bot_gated' });
  });

  it('bot 发送者但 acceptSlashFromBots=true → 正常路由', () => {
    expect(route('/repo botmux', { senderIsBot: true, acceptSlashFromBots: true }))
      .toMatchObject({ kind: 'daemon', cmd: '/repo', sessionPolicy: 'precreate' });
  });

  it('人类发送者永不被这道门拦（acceptSlashFromBots=false 也照常）', () => {
    expect(route('/repo botmux', { senderIsBot: false, acceptSlashFromBots: false }))
      .toMatchObject({ kind: 'daemon', cmd: '/repo' });
  });
});

describe('legacy oracle: 新话题（handleNewTopicAdmitted）', () => {
  it('`/sessions` 在 none 相位 → 前置特判，不建会话', () => {
    // §9「前置特判命令在 none 相位不建会话」/ test/daemon-rename-route.test.ts:705
    expect(route('/sessions')).toEqual({
      kind: 'special', cmd: '/sessions', content: '/sessions', handler: 'sessions',
    });
  });

  it.each([
    ['/vc-auth', 'vc-auth'],
    ['/card', 'card'],
    ['/cot', 'cot'],
    ['/term', 'term'],
  ] as const)('%s 也是前置特判（§9 标注 daemon 级用例缺失的四条）', (text, handler) => {
    expect(route(text)).toMatchObject({ kind: 'special', cmd: text, handler });
  });

  it('五条前置特判都排在透传闸之前：即使被塞进透传集也仍走特判', () => {
    // src/daemon.ts:18415-18487 在 :18488 的透传闸之前。今天 normalizePassthroughCommand
    // 会过滤掉遮蔽 DAEMON_COMMANDS 的自定义项，所以这个顺序不可观测——除非那道
    // 过滤破了。这条断言把顺序钉住。
    const shadowed = new Set([...ORACLE_PASSTHROUGH_COMMANDS, '/card']);
    expect(route('/card off', { passthrough: shadowed })).toMatchObject({
      kind: 'special', cmd: '/card', handler: 'card',
    });
  });

  it('`/goal` 在 none 相位且 coldStartPassthrough 含 /goal → cold_start', () => {
    // §9「D9：/t /goal 修一下 落到冷启动路径」/ test/topic-directive-header.test.ts:439
    expect(route('/goal 修一下登录', {
      passthrough: new Set([...ORACLE_PASSTHROUGH_COMMANDS, '/goal']),
      coldStartPassthrough: COLD_START_GOAL,
    })).toEqual({
      kind: 'passthrough', cmd: '/goal', content: '/goal 修一下登录', delivery: 'cold_start',
    });
  });

  it('`/compact` 在 none 相位 → reject_needs_session（无进程可透传）', () => {
    expect(route('/compact')).toEqual({
      kind: 'passthrough', cmd: '/compact', content: '/compact', delivery: 'reject_needs_session',
    });
  });

  it('`/effort` 刻意不在 adapter 冷启动集 → none 相位同样被拒', () => {
    // passthrough-commands.ts:22 的注释：/effort 是「调档」不是「开一段工作」。
    expect(route('/effort high', { coldStartPassthrough: COLD_START_GOAL }))
      .toMatchObject({ kind: 'passthrough', cmd: '/effort', delivery: 'reject_needs_session' });
  });

  it('`/rename` 在 none 相位 → existing_only（不预建幽灵会话）', () => {
    expect(route('/rename 新标题')).toEqual({
      kind: 'daemon', cmd: '/rename', content: '/rename 新标题', sessionPolicy: 'existing_only',
    });
  });

  it('`/cd` 在 none 相位 → precreate', () => {
    expect(route('/cd ~/Code/botmux')).toEqual({
      kind: 'daemon', cmd: '/cd', content: '/cd ~/Code/botmux', sessionPolicy: 'precreate',
    });
  });

  it('`/group` → sessionless', () => {
    expect(route('/group 讨论组')).toMatchObject({
      kind: 'daemon', cmd: '/group', sessionPolicy: 'sessionless',
    });
  });

  it('`/watch-comment` 按 content 分叉：list/off 无会话，真正 watch 要会话', () => {
    expect(route('/watch-comment list')).toMatchObject({ sessionPolicy: 'sessionless' });
    expect(route('/watch-comment off')).toMatchObject({ sessionPolicy: 'sessionless' });
    expect(route('/watch-comment')).toMatchObject({ sessionPolicy: 'sessionless' });
    expect(route('/watch-comment https://x.feishu.cn/docx/abc')).toMatchObject({
      cmd: '/watch-comment', sessionPolicy: 'precreate',
    });
  });

  it('新话题路径不查 activeSessions：phase 对判定无影响', () => {
    const phases: OraclePhase[] = ['none', 'pendingRepo', 'dormant', 'spawning', 'ready', 'running'];
    for (const phase of phases) {
      expect(route('/cd /tmp', { phase })).toMatchObject({ sessionPolicy: 'precreate' });
      expect(route('/rename x', { phase })).toMatchObject({ sessionPolicy: 'existing_only' });
      expect(route('/compact', { phase })).toMatchObject({ delivery: 'reject_needs_session' });
    }
  });

  it('认得出是 `/xxx` 但不属于任何集合 → unknown_slash，转发给 CLI', () => {
    expect(route('/foo bar')).toEqual({ kind: 'forward', reason: 'unknown_slash' });
  });

  it('无 raw 面的 CLI（dsh / codex-app）透传集为空 → /compact 变成普通文本', () => {
    // §9「dsh 透传集：路由不传 dshRuntime，dsh-tui 与 headless 一样空集」
    expect(route('/compact', { passthrough: new Set() }))
      .toEqual({ kind: 'forward', reason: 'unknown_slash' });
  });
});

describe('legacy oracle: thread（handleThreadReplyAdmitted）', () => {
  const thread = (text: string, over: Partial<OracleInput> = {}) =>
    route(text, { context: 'thread', ...over });

  it('`/sessions` `/vc-auth` 是 thread 仅有的两条前置特判', () => {
    expect(thread('/sessions', { phase: 'none' })).toMatchObject({ kind: 'special', handler: 'sessions' });
    expect(thread('/vc-auth', { phase: 'none' })).toMatchObject({ kind: 'special', handler: 'vc-auth' });
  });

  it('`/term` 仍是特判，但位置在 DAEMON_COMMANDS 块内（透传闸之后）', () => {
    expect(thread('/term', { phase: 'none' })).toMatchObject({ kind: 'special', handler: 'term' });
    // 顺序可观测点：`/term` 若进了透传集，thread 走透传、new-topic 走特判。
    const shadowed = new Set([...ORACLE_PASSTHROUGH_COMMANDS, '/term']);
    expect(thread('/term', { phase: 'running', passthrough: shadowed }))
      .toMatchObject({ kind: 'passthrough', cmd: '/term', delivery: 'existing' });
    expect(route('/term', { passthrough: shadowed }))
      .toMatchObject({ kind: 'special', handler: 'term' });
  });

  it('thread 语境 /card 无会话 → daemon precreate（今天与新话题路径的不一致）', () => {
    // §9「有意变化」表：thread 路径 /card /cot 的前置特判与新话题不一致，PR-2 收敛。
    expect(thread('/card', { phase: 'none' })).toEqual({
      kind: 'daemon', cmd: '/card', content: '/card', sessionPolicy: 'precreate',
    });
    expect(thread('/cot', { phase: 'none' })).toMatchObject({
      kind: 'daemon', cmd: '/cot', sessionPolicy: 'precreate',
    });
    // 同一条命令在新话题路径是 special、不建会话。
    expect(route('/card')).toMatchObject({ kind: 'special', handler: 'card' });
  });

  it('有会话且 worker 在（spawning/ready/running）→ 透传给现有会话', () => {
    for (const phase of ['spawning', 'ready', 'running'] as OraclePhase[]) {
      expect(thread('/compact', { phase })).toEqual({
        kind: 'passthrough', cmd: '/compact', content: '/compact', delivery: 'existing',
      });
    }
  });

  it('有 existingDs 但 worker 未起（pendingRepo）→ cmd_needs_active_cli', () => {
    expect(thread('/compact', { phase: 'pendingRepo' })).toEqual({
      kind: 'passthrough', cmd: '/compact', content: '/compact', delivery: 'reject_needs_active_cli',
    });
  });

  it('dormant（会话在、worker 不在且非等选仓）→ 与 pendingRepo 同形，透传被拒', () => {
    // src/daemon.ts:17627 的首条判定只看 worker 活没活，dormant 落 :17677 拒绝分支。
    expect(thread('/compact', { phase: 'dormant' })).toEqual({
      kind: 'passthrough', cmd: '/compact', content: '/compact', delivery: 'reject_needs_active_cli',
    });
  });

  it('dormant 的 daemon 命令走 existing（会话在，不预建）', () => {
    // :20247 预建块的排除条件是 `!existingDs`，dormant 有 existingDs → 不预建。
    expect(thread('/cd /tmp', { phase: 'dormant' })).toMatchObject({
      kind: 'daemon', cmd: '/cd', sessionPolicy: 'existing',
    });
  });

  it('无会话 + 非冷启动透传 → reject_needs_active_cli（新话题同场景是 reject_needs_session）', () => {
    expect(thread('/compact', { phase: 'none' })).toMatchObject({ delivery: 'reject_needs_active_cli' });
    expect(route('/compact')).toMatchObject({ delivery: 'reject_needs_session' });
  });

  it('无会话 + 冷启动透传 → cold_start；有会话时冷启动集不再参与判定', () => {
    const over = {
      passthrough: new Set([...ORACLE_PASSTHROUGH_COMMANDS, '/goal']),
      coldStartPassthrough: COLD_START_GOAL,
    };
    expect(thread('/goal 修登录', { phase: 'none', ...over })).toMatchObject({ delivery: 'cold_start' });
    expect(thread('/goal 修登录', { phase: 'running', ...over })).toMatchObject({ delivery: 'existing' });
    expect(thread('/goal 修登录', { phase: 'pendingRepo', ...over }))
      .toMatchObject({ delivery: 'reject_needs_active_cli' });
  });

  it('DAEMON_COMMANDS 的会话策略随相位变：无会话 precreate、有会话 existing', () => {
    expect(thread('/cd /tmp', { phase: 'none' })).toMatchObject({ sessionPolicy: 'precreate' });
    expect(thread('/cd /tmp', { phase: 'running' })).toMatchObject({ sessionPolicy: 'existing' });
    expect(thread('/cd /tmp', { phase: 'pendingRepo' })).toMatchObject({ sessionPolicy: 'existing' });
  });

  it('sessionless / existing_only 两类不受相位影响', () => {
    for (const phase of ['none', 'pendingRepo', 'dormant', 'running'] as OraclePhase[]) {
      expect(thread('/group x', { phase })).toMatchObject({ sessionPolicy: 'sessionless' });
      expect(thread('/rename x', { phase })).toMatchObject({ sessionPolicy: 'existing_only' });
    }
  });

  it('unknown_slash 与 no_slash 在 thread 同样成立', () => {
    expect(thread('/foo', { phase: 'running' })).toEqual({ kind: 'forward', reason: 'unknown_slash' });
    expect(thread('随便聊两句', { phase: 'running' })).toEqual({ kind: 'forward', reason: 'no_slash' });
  });
});

describe('legacy oracle: 集合不变量', () => {
  it('透传集与 DAEMON_COMMANDS 恒不相交（顺序因此在生产配置下不可观测）', () => {
    // §9 / test/command-handler.test.ts:1420 :2874 / test/bot-config-store.test.ts:806
    const overlap = [...ORACLE_PASSTHROUGH_COMMANDS].filter(c => ORACLE_DAEMON_COMMANDS.has(c));
    expect(overlap).toEqual([]);
  });

  it('两条入口对同一条 DAEMON_COMMANDS 命令的 cmd/content 提取一致', () => {
    const text = '  /cd ~/Code/botmux  ';
    const a = route(text);
    const b = route(text, { context: 'thread', phase: 'none' });
    expect(a).toMatchObject({ cmd: '/cd', content: '/cd ~/Code/botmux' });
    expect(b).toMatchObject({ cmd: '/cd', content: '/cd ~/Code/botmux' });
  });
});
