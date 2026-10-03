/**
 * 命令路由器 ↔ legacy oracle 的**穷举差分**（设计 docs/design/2026-09-11-command-router.md R10 / §10）。
 *
 * 对小字母表上长度 ≤ 3 的全部 token 串（空格 / 换行两种分隔符全交叉）× 两条入口 × 全部
 * 会话相位 × 三种透传配置 × 发送方是否 bot，断言 `classifySlash` 的决策与 oracle 逐字相等。
 * oracle 不 import src（冻结的老行为），所以这不是恒等式：src 侧任何改动都会在这里变红，
 * 由人来判断是回归还是 §9 里登记过的有意变化——后者写进下面的 INTENTIONAL 名单才放行。
 *
 * 名单里每一条都对应 §9 有意变化表的一行（PR-2：thread 入口 /card /cot 的前置特判对齐）。
 *
 * Run: bun run vitest run test/command-router-oracle-diff.test.ts
 */
import { describe, it, expect } from 'vitest';
import { classifySlash, type SlashRouteDecision, type SlashRouteInput } from '../src/core/command-router.js';
import { SESSION_PHASES, type SessionPhase } from '../src/core/session-phase.js';
import {
  legacySlashRoute,
  ORACLE_PASSTHROUGH_COMMANDS,
  type OracleDecision,
  type OracleInput,
  type OraclePhase,
} from './legacy-oracle/slash-route-oracle.js';

/** 设计 §10 的字母表：命令 / 子命令 / 透传 / 冷启动 / 未注册 / 多行豁免 / 占位符 / 中文 / latin / 引号 / 大小写。 */
const ALPHABET = [
  '/cd', '/repo', 'wt', '/rename', '/sessions', '/card', '/cot', '/term', '/vc-auth',
  '/compact', '/model', '/goal', '/foo', '/schedule', '/role', '/fork', '/watch-comment', 'list',
  '<pane>', '中文', 'latin', '"x y"', '/T',
];
const SEPARATORS = [' ', '\n'];

function* texts(): Generator<string> {
  for (const a of ALPHABET) {
    yield a;
    yield ` ${a} `;
    for (const s1 of SEPARATORS) {
      for (const b of ALPHABET) {
        yield `${a}${s1}${b}`;
        for (const s2 of SEPARATORS) {
          for (const c of ALPHABET) yield `${a}${s1}${b}${s2}${c}`;
        }
      }
    }
  }
}

const BUILTIN = new Set(ORACLE_PASSTHROUGH_COMMANDS);
const PASSTHROUGH_CONFIGS: Array<{ name: string; passthrough: ReadonlySet<string>; coldStart: ReadonlySet<string> }> = [
  { name: 'claude-code 默认', passthrough: new Set([...BUILTIN, '/goal']), coldStart: new Set(['/goal']) },
  { name: '含自定义透传 /foo', passthrough: new Set([...BUILTIN, '/goal', '/foo']), coldStart: new Set(['/goal']) },
  { name: '无 raw 面（codex-app）', passthrough: new Set(), coldStart: new Set() },
];
const SENDERS: Array<{ name: string; senderIsBot: boolean; acceptSlashFromBots: boolean }> = [
  { name: '真人', senderIsBot: false, acceptSlashFromBots: true },
  { name: 'bot 且本 bot 不接受 bot 斜杠', senderIsBot: true, acceptSlashFromBots: false },
];

/** session-phase.ts → oracle 相位的投影（oracle 文件头有同一张表）。 */
function toOraclePhase(phase: SessionPhase): OraclePhase | null {
  switch (phase) {
    case 'none': return 'none';
    case 'pendingRepo':
    case 'worktreeCreating':
    case 'queued': return 'pendingRepo';
    case 'dormant': return 'dormant';
    case 'spawning':
    case 'ready':
    case 'running': return phase;
    case 'closed': return null; // closed 不在 activeSessions 里，路由器永远拿不到它
  }
}

/**
 * 决策形状的两处**有意**差异（不是行为差异），比较前归一：
 *   - oracle 的 passthrough.delivery 四值里 existing / reject_needs_session / reject_needs_active_cli
 *     只是转写口径（执行段按 ds.worker 实时判，两条入口文案不同），路由器收成 to_session；
 *   - 路由器给 unknown_slash 的 forward 带上 cmd（入口的 grant 限制闸要查它），oracle 没有。
 */
function normalizeLegacy(d: OracleDecision): unknown {
  if (d.kind === 'passthrough' && d.delivery !== 'cold_start') return { ...d, delivery: 'to_session' };
  return d;
}
function normalizeNext(d: SlashRouteDecision): unknown {
  if (d.kind === 'forward' && d.reason === 'unknown_slash') return { kind: 'forward', reason: 'unknown_slash' };
  return d;
}

/** §9 有意变化名单：返回 true 表示这组 (输入, 老决策, 新决策) 是登记过的变化。 */
const INTENTIONAL: Array<(input: SlashRouteInput, legacy: any, next: any) => boolean> = [
  // PR-2：thread 入口的 /card /cot 与新话题入口对齐为前置特判（原先走 daemon 分支，无会话时预建幽灵会话）。
  (input, legacy, next) =>
    input.context === 'thread'
    && legacy.kind === 'daemon' && (legacy.cmd === '/card' || legacy.cmd === '/cot')
    && next.kind === 'special' && next.cmd === legacy.cmd && next.content === legacy.content
    && next.handler === legacy.cmd.slice(1),
  // PR-3：thread + 活 worker 上"透传命令行 ⏎ …"的多行消息，今天整条被判讨论文本转发，
  // 现在按级联逐条排队（cascadeCapable 缺省为 false → cascade_unsupported，同属这一条变化）。
  (input, legacy, next) =>
    input.context === 'thread'
    && (input.phase === 'spawning' || input.phase === 'ready' || input.phase === 'running')
    && legacy.kind === 'forward' && legacy.reason === 'discussion'
    && (next.kind === 'cascade' || next.kind === 'cascade_unsupported')
    && next.items.length >= 2 && next.items[0]!.kind === 'passthrough',
];
describe('classifySlash ↔ legacySlashRoute 穷举差分', () => {
  it('小字母表 × 长度 ≤ 3 × 入口 × 相位 × 透传配置 × 发送方：决策逐字相等', () => {
    const contexts: Array<{ context: 'new-topic' | 'thread'; phase: SessionPhase }> = [
      { context: 'new-topic', phase: 'none' },
      ...SESSION_PHASES.filter(p => p !== 'closed').map(phase => ({ context: 'thread' as const, phase })),
    ];
    const mismatches: string[] = [];
    let evaluated = 0;
    for (const text of texts()) {
      for (const { context, phase } of contexts) {
        const oraclePhase = toOraclePhase(phase);
        if (oraclePhase === null) continue;
        for (const cfg of PASSTHROUGH_CONFIGS) {
          for (const sender of SENDERS) {
            const input: SlashRouteInput = {
              text, context, phase,
              passthrough: cfg.passthrough, coldStartPassthrough: cfg.coldStart,
              senderIsBot: sender.senderIsBot, acceptSlashFromBots: sender.acceptSlashFromBots,
            };
            const oracleInput: OracleInput = { ...input, phase: oraclePhase };
            const legacy = normalizeLegacy(legacySlashRoute(oracleInput));
            const next = normalizeNext(classifySlash(input));
            evaluated += 1;
            if (JSON.stringify(legacy) !== JSON.stringify(next)) {
              if (INTENTIONAL.some(rule => rule(input, legacy, next))) continue;
              if (mismatches.length < 25) {
                mismatches.push(`${JSON.stringify(text)} @${context}/${phase}/${cfg.name}/${sender.name}\n  legacy=${JSON.stringify(legacy)}\n  next  =${JSON.stringify(next)}`);
              } else {
                mismatches.push('…');
                break;
              }
            }
          }
        }
      }
    }
    expect(mismatches, mismatches.join('\n')).toEqual([]);
    // 规模写死在断言里：别人缩字母表时会看见。
    expect(evaluated).toBeGreaterThan(2_000_000);
  }, 120_000);

  it('设计 §4/§13 的长形状作为定向用例（穷举够不到的 6–8 token）', () => {
    const cases: Array<{ text: string; context: 'new-topic' | 'thread'; phase: SessionPhase }> = [
      { text: '/repo wt botmux ci/temp_split /model sonnet 简单确认下当前依赖的 bun 的版本号', context: 'thread', phase: 'running' },
      { text: '/schedule 每天 9:00\n跑一遍回归\n然后发我', context: 'thread', phase: 'running' },
      { text: '/model opus\n/clear\n接下来看一下 PR #1361 的评审意见', context: 'thread', phase: 'running' },
      { text: '/watch-comment https://x.feishu.cn/docx/abc --mentions-only --dir ~/Code/botmux', context: 'new-topic', phase: 'none' },
      { text: '/watch-comment list', context: 'new-topic', phase: 'none' },
      { text: '/cd /Users/foo bar baz qux', context: 'thread', phase: 'dormant' },
      { text: '/adopt <pane> 这是讨论', context: 'thread', phase: 'running' },
    ];
    for (const c of cases) {
      const cfg = PASSTHROUGH_CONFIGS[0]!;
      const input: SlashRouteInput = { ...c, passthrough: cfg.passthrough, coldStartPassthrough: cfg.coldStart, senderIsBot: false, acceptSlashFromBots: true };
      const legacy = normalizeLegacy(legacySlashRoute({ ...input, phase: toOraclePhase(c.phase)! }));
      const next = normalizeNext(classifySlash(input));
      if (INTENTIONAL.some(rule => rule(input, legacy, next))) continue; // 登记过的有意变化（PR-3 级联）
      expect(next, c.text).toEqual(legacy);
    }
  });
});
