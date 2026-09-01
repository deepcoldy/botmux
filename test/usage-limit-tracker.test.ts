/**
 * 限额状态机单测：扫屏门控 + 结构化限流的粘性重发。
 *
 * 背景：worker 的扫屏判定在 working/analyzing 帧被门控抑制（误报根治），
 * 但 Claude/Codex 的结构化限流是「一次性 emit + UUID 去重」的权威信号。
 * 若结构化限流命中后 CLI 仍被阻塞，而 worker 状态在 prompt 检测生效前
 * 投影为 working（projectRuntimeScreenStatus 在 promptReady=false 时的
 * 默认值就是 working），daemon 侧的 working 帧自愈会把这条权威限额清掉，
 * 且 Claude 家族的扫屏 rate 判定被 suppressRateKind 关闭，再也不会重新
 * 上报——真限流卡片被静默吞掉。因此结构化限额必须在本轮内逐帧重发，
 * 让 daemon 的「新鲜 usageLimit 优先」分支始终生效。
 *
 * Run: pnpm vitest run test/usage-limit-tracker.test.ts
 */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test';
import { bridgeTurnOutcome, createUsageLimitTracker } from '../src/utils/usage-limit-tracker.js';
import { detectCliUsageLimit } from '../src/utils/cli-usage-limit.js';
import { shouldSuppressBridgeEmit, structuredFallbackKind } from '../src/services/bridge-fallback-gate.js';
import { CODEX_RATE_LIMIT_ERROR_CODE } from '../src/services/codex-transcript.js';
import type { CliUsageLimitState } from '../src/utils/cli-usage-limit.js';

function structuredLimit(): CliUsageLimitState {
  return {
    limited: true,
    kind: 'rate',
    retryAtMs: Date.now() + 60_000,
    retryLabel: '5-10 min',
    retryReady: false,
  };
}

describe('usage-limit tracker — 结构化限流粘性重发', () => {
  it('结构化限流命中后，working 帧仍重发 limited（防 daemon 自愈误清）', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    const seq = tracker.beginTurn('');
    const limit = structuredLimit();
    tracker.noteStructuredLimit(limit);

    // 屏幕上没有任何限流文案、CLI 还在 working：扫屏门控会抑制，但权威
    // 结构化限额必须原样重发，daemon 收到新鲜 usageLimit 就不会自愈清除。
    const working = tracker.classify('模型正在输出业务 429 的排查结论', 'working');
    expect(working.status).toBe('limited');
    expect(working.usageLimit).toBe(limit);

    // idle 帧同样保持：CLI 被阻塞落到 idle，卡片不回落。
    const idle = tracker.classify('rate limit reached', 'idle');
    expect(idle.status).toBe('limited');
    expect(idle.usageLimit).toBe(limit);

    expect(tracker.detectedThisTurn(seq)).toBe(true);
  });

  it('analyzing 帧同样重发结构化限流', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('thinking', 'analyzing').status).toBe('limited');
  });

  it('下一轮 beginTurn 后停止重发：限额卡片随新轮次清除', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('anything', 'working').status).toBe('limited');

    tracker.beginTurn('');
    expect(tracker.classify('anything', 'working').status).toBe('working');
    expect(tracker.classify('anything', 'idle').status).toBe('idle');
  });

  it('扫屏命中保持一次性：不在后续帧重发（误报由 daemon 自愈兜底）', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    // idle 抖动帧扫屏命中。
    const detected = tracker.classify('429 Too Many Requests', 'idle');
    expect(detected.status).toBe('limited');
    expect(detected.usageLimit).toBeDefined();
    // 下一帧屏幕已无该文案（或状态变化）：不重发，daemon 可自愈清除。
    expect(tracker.classify('plain output', 'idle').status).toBe('idle');
    expect(tracker.classify('plain output', 'working').status).toBe('working');
  });

  it('扫屏门控保持不变：working 帧不出限额结论', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    expect(tracker.classify('429 Too Many Requests', 'working').status).toBe('working');
    expect(tracker.classify('429 Too Many Requests', 'analyzing').status).toBe('analyzing');
    // idle/stalled 帧维持原判定，真实限流（CLI 被阻塞）仍可检出。
    expect(tracker.classify('429 Too Many Requests', 'idle').status).toBe('limited');
    expect(tracker.classify('429 Too Many Requests', 'stalled').status).toBe('limited');
  });

  it('suppressRateKind 语义在结构化重发之外保持不变', () => {
    // Claude 家族：rate 被抑制，usage 仍检出；结构化重发不受影响。
    const suppressed = createUsageLimitTracker({ isRateKindSuppressed: () => true });
    suppressed.beginTurn('');
    expect(suppressed.classify('429 Too Many Requests', 'idle').status).toBe('idle');
    expect(suppressed.classify("You've hit your usage limit. Try again at 10:36 PM.", 'idle').status).toBe('limited');
    // 结构化限流即使在 suppressRateKind 下也重发。
    suppressed.noteStructuredLimit(structuredLimit());
    expect(suppressed.classify('output', 'working').status).toBe('limited');
  });
});

describe('usage-limit tracker — adopted 会话本地恢复后清除结构化 latch', () => {
  it('本地 turn 成功完成（noteTurnCompleted）后不再重发旧限额', () => {
    // 场景：adopted Claude/Codex 会话命中结构化限流（latch 置位），用户在本地
    // 终端直接恢复——不触发 beginTurn()。daemon 的 final_output handler 已清
    // ds.usageLimit，但 tracker 的 activeStructured latch 仍在；若不清，下次
    // periodic / prompt-ready classify 会重发旧限额，把卡片/Dashboard 重新钉住。
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    const seq = tracker.beginTurn('');
    const limit = structuredLimit();
    tracker.noteStructuredLimit(limit);
    // 恢复前：working 帧仍重发（防 daemon 自愈误清的既有保护）。
    expect(tracker.classify('anything', 'working').status).toBe('limited');

    // bridge 收获到本地 turn 的 final_output → noteTurnCompleted（与 daemon
    // final_output handler 清 ds.usageLimit 同一恢复路径）。
    tracker.noteTurnCompleted();

    // 恢复后：不再重发旧限额。
    expect(tracker.classify('anything', 'working').status).toBe('working');
    expect(tracker.classify('anything', 'idle').status).toBe('idle');
    // 历史事实保留：本轮确实命中过限额（detectedThisTurn 供 submit-confirmation
    // recheck 读取），latch 清除不影响该标记。
    expect(tracker.detectedThisTurn(seq)).toBe(true);
  });

  it('noteTurnCompleted 后下一轮 beginTurn 行为不变', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    tracker.noteTurnCompleted();
    // 新一轮正常开始：扫屏判定恢复工作。
    tracker.beginTurn('');
    expect(tracker.classify('429 Too Many Requests', 'idle').status).toBe('limited');
  });

  it('未命中结构化限流时 noteTurnCompleted 是 no-op', () => {
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    tracker.noteTurnCompleted(); // 不应抛错，也不影响普通判定。
    expect(tracker.classify('plain output', 'idle').status).toBe('idle');
  });
});

describe('usage-limit tracker — outputActive 门控（working 不等于输出在进展）', () => {
  const blocked429Screen = 'exceeded retry limit, last status: 429 Too Many Requests, request id: req_x';

  it('working + outputActive=false 仍检出阻塞 429（非结构化 CLI 卡死错误屏）', () => {
    // 非结构化 CLI（codex/grok/traex/pi）的限额错误屏不渲染配置的 ready
    // prompt，idle detector 永不转 idle，状态一直是 working（只有 Codex App
    // 会 project stalled）。outputActive=false 表示 PTY 已静默（CLI 被阻塞，
    // 不是在产出），扫屏判定必须运行——真实阻塞 429 不能被无限抑制。
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => false,
      isOutputActive: () => false,
    });
    tracker.beginTurn('');
    const blocked = tracker.classify(blocked429Screen, 'working');
    expect(blocked.status).toBe('limited');
    expect(blocked.usageLimit?.kind).toBe('rate');
  });

  it('working + outputActive=true 保持抑制（输出进展中 = CLI 自己的输出）', () => {
    // PTY 活跃（模型正在输出）时屏幕上的 429 文案是业务输出/内部重试，仍抑制。
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => false,
      isOutputActive: () => true,
    });
    tracker.beginTurn('');
    expect(tracker.classify(blocked429Screen, 'working').status).toBe('working');
  });

  it('未注入 isOutputActive 时保持保守默认（working 一律抑制）', () => {
    // 纯单测/无输出活动信号的调用方保持既有行为。
    const tracker = createUsageLimitTracker({ isRateKindSuppressed: () => false });
    tracker.beginTurn('');
    expect(tracker.classify(blocked429Screen, 'working').status).toBe('working');
  });

  it('analyzing + outputActive=false 同样检出', () => {
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => false,
      isOutputActive: () => false,
    });
    tracker.beginTurn('');
    expect(tracker.classify(blocked429Screen, 'analyzing').status).toBe('limited');
  });

  it('outputActive 门控不影响结构化限流重发', () => {
    // 结构化限流是权威信号，重发不受 outputActive 影响（P1#1 的粘性保护）。
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => true,
      isOutputActive: () => true,
    });
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('output', 'working').status).toBe('limited');
  });
});

describe('usage-limit tracker — 屏幕上的旧限额横幅不得每轮重新钉住卡片', () => {
  // 线上真实横幅（Codex）。关键性质：
  //  ① 只带钟点不带日期 ⟹ detectCliUsageLimit 对「已过去的 PM 时间」刻意留在
  //     今天（见其注释），所以一天里 20:45 之前的任意时刻，这条隔夜横幅都被
  //     解析成「今天 20:45」这个未来时刻 ⟹ retryReady === false。
  //  ② Codex 整个 pane 只打印一次就一直留在 viewport 里（实测 261 个 live tmux
  //     会话、-S -20000 深回滚，没有任何 pane 出现第二次），所以它不是「CLI 又
  //     拒了一次」的活证据，而是一块不会消失的旧背景。
  // 判据不能只看横幅文本/key：那分不开「旧横幅」与「同文案的新拒绝」。也不能
  // 要求「出现新的结构化记录」：实测全仓 1925 个 rollout 里，带
  // usage_limit_exceeded task_complete 的 8 个**各自只有一条**，且其中有会话在
  // 限额之后仍跑了 7 个 turn / 12 条用户消息——usage kind 的结构化信号只写一次。
  // 所以用的是正向成功证据：本轮 CLI 真的答出了东西（noteTurnCompleted
  // 'answered'）——被限额阻塞的轮次永远不会产出成功终态。
  const STALE_BANNER = "■ You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 8:45 PM.";
  // 另一个 CLI 家族的「带明确重置时刻的 rate 限额」（仓库既有真路径，见
  // cli-usage-limit.test.ts）。它走 parseMeridiemTime 拿固定钟点，不走 5 分钟
  // 分桶，所以 key 不会自己递进——这类必须保持原语义，绝不能被抑制。
  const GEMINI_RATE_BANNER = 'Rate limit exceeded. Try again at 10:36 PM.';

  // 把时钟钉在 8:45 PM 之前，让 retryReady 稳定为 false（回归的前提条件）。
  // 不钉时钟的话，用例在每天 20:45 之后会因为 retryReady 变 true 而「自己变
  // 绿」——那是最坏的一种假绿：它会在 CI 的某些时段掩盖真回归。
  const beforeReset = new Date('2026-08-29T10:00:00-07:00');
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(beforeReset); });
  afterEach(() => { vi.useRealTimers(); });

  /** codex：emitsStructuredRateLimit ⟹ suppressRateKind=true（rate 走结构化，
   *  扫屏只留 usage）；限额错误屏上 PTY 已静默 ⟹ outputActive=false。 */
  const codexTracker = () => createUsageLimitTracker({
    isRateKindSuppressed: () => true,
    isOutputActive: () => false,
  });
  /** 非结构化 CLI（gemini/grok/traex…）：rate 扫屏在用，且没有结构化兜底。 */
  const plainTracker = () => createUsageLimitTracker({
    isRateKindSuppressed: () => false,
    isOutputActive: () => false,
  });

  it('前提校验：这条横幅在重置时刻之前确实解析为 retryReady=false', () => {
    // 这不是被测行为，而是上面「性质①」的自证。如果哪天解析规则改了、这条横幅
    // 变成 retryReady=true，下面的回归用例就不再覆盖它声称的场景（会退化成恒真
    // 断言），必须由这条前提用例先红出来。
    const detected = detectCliUsageLimit(STALE_BANNER);
    expect(detected.limited).toBe(true);
    expect((detected as CliUsageLimitState).kind).toBe('usage');
    expect((detected as CliUsageLimitState).retryReady).toBe(false);
  });

  it('本轮真答完后，屏幕上的旧横幅不再判限额（回归）', () => {
    const tracker = codexTracker();
    // 第 1 轮：真限额命中（canary——若这里就不 limited，本用例什么都没测到）。
    tracker.beginTurn('');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('limited');

    // 第 2 轮：用户重新发消息，屏幕上那条横幅还在（Codex 不重印也不消失）。
    const seq2 = tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('answered');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    expect(tracker.classify(STALE_BANNER, 'stalled').status).toBe('stalled');
    expect(tracker.detectedThisTurn(seq2)).toBe(false);
  });

  it('本轮尚未答出东西时，旧横幅照常判限额（不得 fail-open）', () => {
    // 这是抑制的「有牙」边界：没有成功证据就不抑制，真限额仍然上报。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('limited');
  });

  it('failed 终态不得置成功位（限额拒绝本身就是 failed 终态）', () => {
    // codex bridge 的失败 fallback 与成功路径共用同一个出口，若把它当成功
    // 证据，等于「用限额拒绝证明没被限额」。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('failed');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('limited');
  });

  it('failed 终态不得清结构化 latch（真 429 不得静默）', () => {
    // 本 PR 在 gate 分支新增了 noteTurnCompleted 调用点，把 failed 终态接进了
    // 「清 latch」这条路——而 master 上这条路根本不会被走到。真路径：本轮已有
    // botmux send marker，结构化 429 先置 latch，随后 gate=true 带着 failed 终态
    // 调到这里。若清了 latch，下一帧 working 会触发 daemon 自愈清限额，而 codex
    // 的扫屏 rate 判定本来就被 suppress（结构化才是权威）⟹ 真 429 永久静默。
    const tracker = codexTracker();
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('模型正常输出', 'working').status).toBe('limited');
    tracker.noteTurnCompleted('failed');
    expect(tracker.classify('模型正常输出', 'working').status).toBe('limited');
    expect(tracker.classify('模型正常输出', 'idle').status).toBe('limited');
  });

  it('answered 终态仍清结构化 latch（既有自愈不变）', () => {
    // 反向校准：failed 不清 latch 这条改动不能顺手把 answered 的自愈也关掉。
    const tracker = codexTracker();
    tracker.beginTurn('');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify('模型正常输出', 'working').status).toBe('limited');
    tracker.noteTurnCompleted('answered');
    expect(tracker.classify('模型正常输出', 'working').status).toBe('working');
  });

  it('ambiguous 终态同样不得置成功位', () => {
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('failed'); // bridgeTurnOutcome 把 ambiguous 映射到 failed
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('limited');
  });

  it('成功判据必须取终态，不能取 fallbackKind（失败+已send 的组合）', () => {
    // structuredFallbackKind 决定「展示哪种 fallback」，不是终态：当失败 fallback
    // 被 gate 掉（本轮已 botmux send / 命中 codex 限额短路 rateLimitHandled）时，
    // 它会返回 'final'。此处以 bridge-fallback-gate 的真实返回值驱动，确认按
    // fallbackKind 判会把 failed 终态误判成成功，而按 terminalStatus 判不会。
    const failedButGated = structuredFallbackKind(
      { turnId: 't', isLocal: false, finalText: 'x', markTimeMs: Date.now(),
        terminalStatus: 'failed', terminalErrorCode: CODEX_RATE_LIMIT_ERROR_CODE } as any,
      undefined, [], false, true,
    );
    // 真路径自证：这个组合下 fallbackKind 确实不是 'failed'。
    expect(failedButGated).not.toBe('failed');

    // 按终态判（worker 的 bridgeTurnOutcome 口径）：failed ⟹ 不置位 ⟹ 仍上报。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('failed');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('limited');
  });

  it('已 botmux send（fallback 被 gate 掉）也算成功终态', () => {
    // 最常见的成功路径：模型本轮已 botmux send，shouldSuppressBridgeEmit 会在
    // final_output 之前 continue。若把成功证据绑在「是否又发了一条 final_output」
    // 上，这条路径永远不置位，原横幅仍会每轮重钉——即本 bug 的主场景。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('answered');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
  });

  it('Codex 静默成功（last_agent_message 空 + 已 send）也必须置成功位（接线回归）', () => {
    // 这一格是 worker 侧的**接线**回归，不是两个纯函数各自的返回值：
    // codex-transcript 会把空 last_agent_message 产成 assistant_final(text:'')，
    // 而本轮有 in-window send marker 时 structuredFallbackKind 返回 'none' ⟹
    // content='' ⟹ worker 的 `if (!content) continue` 先触发，gate 分支里的
    // noteTurnCompleted 结构上不可达。这是最常见的成功形态（全仓 1925 个 rollout
    // 里有 253 个这种成功终态），漏了它旧横幅照旧每轮重钉。
    // 先用真函数自证这个组合确实走到 content='' 且 gate=true——否则本用例可能
    // 在测一个根本不存在的形态。
    const gateInput = { turnId: 't', isLocal: false, finalText: '', markTimeMs: 100 };
    const markers = [{ sentAtMs: 150 }];
    const kind = structuredFallbackKind(gateInput as any, undefined, markers, false, true);
    expect(kind).toBe('none');                                    // ⟹ content 会是 ''
    expect(shouldSuppressBridgeEmit(gateInput as any, undefined, markers, false)).toBe(true);

    // worker 现在在 `!content` 分支上也记录终态（bridgeTurnOutcome 决定 answered/
    // failed），所以同一条旧横幅不再被重新判成限额。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted(bridgeTurnOutcome({}));             // 成功终态：无 terminalStatus
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
  });

  it('同一形态但终态是 failed 时仍须上报（不得因 content 空就当成功）', () => {
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted(bridgeTurnOutcome({ terminalStatus: 'failed' }));
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('limited');
  });

  it('抑制严格按 episode 收敛：干净开局时中途出现的限额仍要检出', () => {
    const tracker = codexTracker();
    tracker.beginTurn('干净屏幕，完全没有限额文案');
    tracker.noteTurnCompleted('answered');
    const detected = tracker.classify(STALE_BANNER, 'idle');
    expect(detected.status).toBe('limited');
    expect(detected.usageLimit?.kind).toBe('usage');
  });

  it('抑制只认同一横幅：换成另一个重置钟点即视为新限额', () => {
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('answered');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    const detected = tracker.classify(STALE_BANNER.replace('8:45 PM', '11:15 PM'), 'idle');
    expect(detected.status).toBe('limited');
    expect(detected.usageLimit?.retryLabel).toBe('11:15 PM');
  });

  it('横幅身份不含时钟：跨午夜不得因 retryAtMs 漂移而重新钉住', () => {
    // usageLimitStateKey 含 retryAtMs，而 retryAtMs 是按「今天」解析的，所以同
    // 一段屏幕文字在午夜前后会产生不同的 key。若用它当横幅身份，抑制会在 00:01
    // 静默失效、在没有任何新输入的情况下把卡片重新钉住。
    const tracker = codexTracker();
    vi.setSystemTime(new Date('2026-08-29T23:59:00-07:00'));
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('answered');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    vi.setSystemTime(new Date('2026-08-30T00:01:00-07:00'));
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
  });

  it('结构化限额到达后撤销成功抑制（权威信号优先）', () => {
    // 成功答完之后又收到权威限额（steer / 多答交错）：CLI 现在确实被阻塞，
    // 不能再让「本轮答过」把该显示的横幅继续吞掉。
    const tracker = codexTracker();
    tracker.beginTurn(STALE_BANNER);
    tracker.noteTurnCompleted('answered');
    expect(tracker.classify(STALE_BANNER, 'idle').status).toBe('idle');
    tracker.noteStructuredLimit(structuredLimit());
    expect(tracker.classify(STALE_BANNER, 'working').status).toBe('limited');
  });

  it('非结构化 CLI 的带钟点限额：重试仍被拒时必须继续上报', () => {
    // 无结构化兜底的 CLI（gemini/grok/traex…）：其带明确钟点的限额走固定
    // retryAtMs、不走 5 分钟分桶，key 不会自己递进。用户在真限额期间重试、
    // CLI 以同文案再拒时，必须照报——否则真限额被静默到跨日。
    const tracker = plainTracker();
    tracker.beginTurn(GEMINI_RATE_BANNER);
    expect(tracker.classify(GEMINI_RATE_BANNER, 'idle').status).toBe('limited');
  });

  it('非结构化 CLI 连续多轮重试都要上报', () => {
    const tracker = plainTracker();
    for (let turn = 0; turn < 5; turn++) {
      tracker.beginTurn(GEMINI_RATE_BANNER);
      expect(tracker.classify(GEMINI_RATE_BANNER, 'idle').status).toBe('limited');
    }
  });

  it('working + 输出在进展时的既有门控不受影响', () => {
    const tracker = createUsageLimitTracker({
      isRateKindSuppressed: () => true,
      isOutputActive: () => true,
    });
    tracker.beginTurn('干净屏幕');
    tracker.noteTurnCompleted('answered');
    expect(tracker.classify(STALE_BANNER, 'working').status).toBe('working');
  });
});

describe('usage-limit tracker — bridgeTurnOutcome 按终态而非 fallbackKind 判成功', () => {
  // 这个 predicate 是「本轮算不算答出东西」的唯一判据，worker 的三个 bridge
  // 出口都调它。它必须只认终态：structuredFallbackKind 决定的是「展示哪种
  // fallback 文案」，在失败 fallback 被 gate 掉时会对 failed 终态返回 'final'。
  it('completed / undefined 终态算 answered', () => {
    expect(bridgeTurnOutcome({ terminalStatus: 'completed' })).toBe('answered');
    expect(bridgeTurnOutcome({})).toBe('answered');
  });

  it('failed / ambiguous 终态算 failed', () => {
    expect(bridgeTurnOutcome({ terminalStatus: 'failed' })).toBe('failed');
    expect(bridgeTurnOutcome({ terminalStatus: 'ambiguous' })).toBe('failed');
  });

  it('failed 终态 + 失败 fallback 被 gate 掉时，仍判 failed（真路径自证）', () => {
    // 先用 bridge-fallback-gate 的真实返回值证明「按 fallbackKind 判会误判」，
    // 再确认 bridgeTurnOutcome 不受它影响。缺了前半段，这条断言就无从判断自己
    // 是否真的覆盖了那个绕过路径。
    const turn = {
      turnId: 't', isLocal: false, finalText: 'x', markTimeMs: Date.now(),
      terminalStatus: 'failed' as const, terminalErrorCode: CODEX_RATE_LIMIT_ERROR_CODE,
    };
    expect(structuredFallbackKind(turn as any, undefined, [], false, true)).not.toBe('failed');
    expect(bridgeTurnOutcome(turn)).toBe('failed');
  });
});

describe('usage-limit tracker — worker 接线不变量（源码守卫）', () => {
  // worker.ts 没有单测面，而这条缺陷是**语句顺序**：把终态记录放在
  // `if (!content) continue;` 之后，它对「静默成功 + 已 botmux send」这一最常见
  // 形态结构上不可达（content 恒为 ''）。行为用例咬不住顺序——实测把顺序改回
  // 缺陷版本，35 条用例全绿——所以这条只能由源码守卫兜。
  const workerSrc = readFileSync(
    new URL('../src/worker.ts', import.meta.url), 'utf8',
  );

  /** emitReadyCodexTurns 的函数体（从签名到下一个顶层 function）。 */
  function codexEmitBody(): string {
    const start = workerSrc.indexOf('function emitReadyCodexTurns(');
    expect(start).toBeGreaterThan(-1);          // 锚点自证：函数还在
    const end = workerSrc.indexOf('\nfunction ', start + 1);
    expect(end).toBeGreaterThan(start);
    return workerSrc.slice(start, end);
  }

  it('终态记录必须出现在「无 fallback 文案就 continue」那个 bail-out 之前', () => {
    // 锚点刻意不绑变量名：按 `if (!<ident>) continue;` 这个**形状**匹配，所以把
    // 局部变量 content 改名为 fallbackText 之类的正常重构不会让守卫误红（实测
    // 过：写死 'if (!content)' 的版本一改名就红，那种守卫迟早被人删掉）。
    const body = codexEmitBody();
    const bail = body.search(/if \(!\w+\) continue;/);
    const record = body.indexOf('usageLimitTracker.noteTurnCompleted(');
    // 窗口自证：两个锚点都真的在这个函数体里找到了，否则断言是空真的。
    expect(bail).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(-1);
    expect(record).toBeLessThan(bail);
  });

  it('该记录必须由 bridgeTurnOutcome 决定，不得写死 answered', () => {
    // 只锁「用了这个 predicate」+「没写死成功位」这两点，不锁它的实参形状：
    // `bridgeTurnOutcome(turn)` 与 `bridgeTurnOutcome({ terminalStatus: … })`
    // 语义相同，守卫不该因为后者而误红（实测过绑 `(turn)` 会红）。这个 bridge
    // 有失败终态，写死成功位会把限额拒绝读成成功。
    const body = codexEmitBody();
    // 必须真正把 predicate 的结果喂给 tracker，而不是「函数体里某处出现过」：
    // 先抓 noteTurnCompleted 的实参标识符，再证明那个标识符正是由
    // bridgeTurnOutcome 赋值的。只 grep 两个名字都存在是**欠约束**的——实测把
    // bridgeTurnOutcome 的结果弃用、另写一个恒为 'answered' 的同名局部变量，
    // 那种守卫照样全绿。
    const calls = [...body.matchAll(/noteTurnCompleted\(([^)]*)\)/g)].map(m => m[1].trim());
    expect(calls.length).toBeGreaterThan(0);            // 锚点自证
    for (const arg of calls) {
      // 实参必须是个标识符（不是字面量），且该标识符由 bridgeTurnOutcome 赋值。
      expect(arg).toMatch(/^[A-Za-z_$][\w$]*$/);
      expect(body).toMatch(
        new RegExp(`(?:const|let)\\s+${arg}[^=\\n]*=\\s*bridgeTurnOutcome\\(`),
      );
    }
  });
});
