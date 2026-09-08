/**
 * Unit tests for the streaming card's stop button, compact button, and
 * context-headroom indicator — the conditional renders added to
 * buildStreamingCard. Pure functions; HOME is isolated so global-config reads
 * see a scratch config.json (same pattern as card-builder.test.ts).
 *
 * Run: pnpm vitest run test/card-builder-stop-compact.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildStreamingCard,
  contextCompactThreshold,
  DEFAULT_CONTEXT_COMPACT_THRESHOLD,
} from '../src/im/lark/card-builder.js';
import { ALL_CLI_IDS } from '../src/adapters/cli/registry.js';
import { cliHasNoRawPassthroughSurface } from '../src/core/passthrough-commands.js';
import { setPromptOverrideResolver } from '../src/i18n/index.js';
import {
  globalConfigPath,
  mergeDashboardConfig,
  invalidateGlobalConfigCache,
} from '../src/global-config.js';

let cardTestHome: string;
beforeEach(() => {
  cardTestHome = mkdtempSync(join(tmpdir(), 'botmux-card-stop-'));
  vi.stubEnv('HOME', cardTestHome);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  invalidateGlobalConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  rmSync(cardTestHome, { recursive: true, force: true });
});

const SID = 'sess-stop';
const ROOT = 'om_root_stop';
const URL = 'https://example.com/term';
const TITLE = 'Stop Task';

function parse(json: string): any {
  return JSON.parse(json);
}

/** The FIRST action element is the main control row (headerActions); the
 *  quick-action key rows come after it. */
function headerActions(card: any): any[] {
  const actionEl = card.elements.find((e: any) => e.tag === 'action');
  return actionEl?.actions ?? [];
}

function findButton(actions: any[], action: string): any {
  return actions.find((a: any) => a.tag === 'button' && a.value?.action === action);
}

function build(opts: {
  status?: string;
  cliId?: string;
  displayMode?: string;
  usage?: any;
  locale?: string;
  dshRuntime?: 'official' | 'tui';
} = {}): any {
  return parse(buildStreamingCard(
    SID,
    ROOT,
    URL,
    TITLE,
    '',
    (opts.status ?? 'working') as any,
    opts.cliId as any,
    (opts.displayMode ?? 'hidden') as any,
    undefined,
    undefined,
    false,
    false,
    opts.locale as any,
    undefined,
    undefined,
    false,
    opts.usage,
    undefined,
    undefined,
    undefined,
    opts.dshRuntime,
  ));
}

describe('buildStreamingCard: stop button (stop_turn)', () => {
  it('renders in the main control row while a turn is active (working, claude-code)', () => {
    const card = build({ status: 'working', cliId: 'claude-code' });
    const btn = findButton(headerActions(card), 'stop_turn');
    expect(btn).toBeTruthy();
    expect(btn.text.content).toContain('停止');
  });

  it('is hidden when idle (no turn to stop)', () => {
    const card = build({ status: 'idle' });
    expect(findButton(headerActions(card), 'stop_turn')).toBeFalsy();
  });

  it('is hidden while starting (CLI not up yet) and limited (turn already failed)', () => {
    expect(findButton(headerActions(build({ status: 'starting' })), 'stop_turn')).toBeFalsy();
    expect(findButton(headerActions(build({ status: 'limited' })), 'stop_turn')).toBeFalsy();
  });

  it('stays visible in BOTH collapsed (hidden) and expanded (screenshot) modes', () => {
    // 折叠态常驻是本需求的核心：此前 ^C 仅在 screenshot 展开态出现，折叠态只能 /close。
    for (const displayMode of ['hidden', 'screenshot']) {
      const card = build({ status: 'working', displayMode });
      expect(findButton(headerActions(card), 'stop_turn')).toBeTruthy();
    }
  });

  it('is hidden for remote CLIs (riff / mojo) — no terminal to drive', () => {
    expect(findButton(headerActions(build({ status: 'working', cliId: 'riff' })), 'stop_turn')).toBeFalsy();
    expect(findButton(headerActions(build({ status: 'working', cliId: 'mojo' })), 'stop_turn')).toBeFalsy();
  });

  it('is hidden for codex-app (App Runner has no PTY input channel)', () => {
    const card = build({ status: 'working', cliId: 'codex-app' });
    expect(findButton(headerActions(card), 'stop_turn')).toBeFalsy();
  });

  it('carries action=stop_turn plus the shared actionBase identity fields', () => {
    const card = build({ status: 'working', cliId: 'claude-code' });
    const btn = findButton(headerActions(card), 'stop_turn');
    expect(btn.value.action).toBe('stop_turn');
    expect(btn.value.root_id).toBe(ROOT);
    expect(btn.value.session_id).toBe(SID);
    expect(btn.value.cli_id).toBe('claude-code');
  });
});

describe('buildStreamingCard: compact button (compact_session)', () => {
  // 判据是「这个 CLI 有没有能收 /compact 的输入通道」，**不是**「有没有上下文百分比」。
  // 旧实现拿 percentUsed 当闸门，而只有 codex（native model_context_window）和 pi
  // （读 ~/.pi/agent/models.json）算得出百分比；Claude Code 的 transcript 里没有任何
  // 上下文窗口字段 ⟹ Claude 会话永远看不到压缩按钮，而 Claude 恰恰最需要 /compact。
  it('renders for Claude Code even with NO context percentage (the regression this fixes)', () => {
    const card = build({ status: 'working', cliId: 'claude-code' });
    const btn = findButton(headerActions(card), 'compact_session');
    expect(btn).toBeTruthy();
    expect(btn.text.content).toContain('压缩');
    expect(btn.value.action).toBe('compact_session');
    expect(btn.value.root_id).toBe(ROOT);
    expect(btn.value.session_id).toBe(SID);
  });

  it('renders for a Claude session that only reports usedTokens (no window ⇒ no percent)', () => {
    // 真实 Claude 形态：只有 usedTokens，没有 windowTokens / percentUsed。
    const card = build({
      status: 'working',
      cliId: 'claude-code',
      usage: { context: { usedTokens: 411_100 } },
    });
    expect(findButton(headerActions(card), 'compact_session')).toBeTruthy();
  });

  it('still renders when a percentage IS available (codex/pi shape)', () => {
    const card = build({ status: 'working', usage: { context: { percentUsed: 45 } } });
    expect(findButton(headerActions(card), 'compact_session')).toBeTruthy();
  });

  it('is hidden for remote CLIs and codex-app (no local input channel to receive /compact)', () => {
    for (const cliId of ['riff', 'mojo', 'codex-app']) {
      const card = build({ status: 'working', cliId, usage: { context: { percentUsed: 45 } } });
      expect(findButton(headerActions(card), 'compact_session'), `cliId=${cliId}`).toBeFalsy();
    }
  });

  // ── 闸门必须调谓词，不能手写 cliId 字面量 ────────────────────────────────
  // /compact 走 raw_input 把**字面量**写进 PTY，绕过 runner 的
  // `::botmux-<id>:<base64>` 帧协议：dsh 打 `ignoring non-frame input` 静默丢弃，
  // mira/mir 把 `/compact` 当**普通用户消息**发给模型白烧一个 turn。打字发 /compact
  // 本就被 router（resolvePassthroughCommands 对这些 CLI 返回空集）拦住，按钮不得把
  // 那条路重新打开。
  //
  // ⭐ 这条**枚举 ALL_CLI_IDS 全集**而不是列举几个已知成员：本缺陷的成因正是
  // 「手写了名单里的 1 个、漏掉其余 4 个」，只测已知成员的用例对"下一个新增的
  // 无 raw 面 CLI"没有区分力。把判据钉在谓词上，新增 CLI 会自动被覆盖。
  it('never renders for ANY cli whose passthrough surface the predicate refuses (whole registry)', () => {
    const offenders: string[] = [];
    for (const cliId of ALL_CLI_IDS) {
      // dsh 是运行时相关的：不传 dshRuntime ⇒ 谓词按 headless runner 判（fail-closed）。
      if (!cliHasNoRawPassthroughSurface(cliId)) continue;
      const card = build({ status: 'working', cliId, usage: { context: { percentUsed: 45 } } });
      if (findButton(headerActions(card), 'compact_session')) offenders.push(cliId);
    }
    expect(offenders).toEqual([]);
    // 反向哨兵：谓词至少真的拒绝了一批 CLI，否则上面的循环体一次都没跑（空断言假绿）。
    expect(ALL_CLI_IDS.filter(c => cliHasNoRawPassthroughSurface(c)).length).toBeGreaterThanOrEqual(5);
  });

  it('is hidden for the runner CLIs specifically (mira/mir/dsh/ebsd — /compact would be dropped or sent as a user message)', () => {
    for (const cliId of ['mira', 'mir', 'dsh', 'ebsd']) {
      const card = build({ status: 'working', cliId, usage: { context: { percentUsed: 45 } } });
      expect(findButton(headerActions(card), 'compact_session'), `cliId=${cliId}`).toBeFalsy();
    }
  });

  // dsh-tui 是 PTY 驱动的交互式 TUI（与 claude-code 同款交互模型），raw /compact 有效。
  // 它**不靠 cliId 选中**：bot 配 cliId='dsh' + dshRuntime='tui'，worker 内部才解析成
  // dsh-tui，所以卡片侧只能靠 dshRuntime 区分。
  it('DOES render for a dsh bot running the interactive TUI (dshRuntime=tui)', () => {
    const card = build({ status: 'working', cliId: 'dsh', dshRuntime: 'tui' });
    expect(findButton(headerActions(card), 'compact_session')).toBeTruthy();
  });

  it('stays hidden for a dsh bot on the headless runner (dshRuntime=official)', () => {
    const card = build({ status: 'working', cliId: 'dsh', dshRuntime: 'official' });
    expect(findButton(headerActions(card), 'compact_session')).toBeFalsy();
  });

  it('fails CLOSED for dsh when dshRuntime is not threaded through (missing arg ⇒ status quo, not a broken button)', () => {
    const card = build({ status: 'working', cliId: 'dsh' });
    expect(findButton(headerActions(card), 'compact_session')).toBeFalsy();
  });

  it('does not let dshRuntime leak into an unrelated runner CLI', () => {
    const card = build({ status: 'working', cliId: 'mir', dshRuntime: 'tui' });
    expect(findButton(headerActions(card), 'compact_session')).toBeFalsy();
  });
});

describe('buildStreamingCard: context headroom lives ONLY in the usage footer', () => {
  // 防回归：曾经有一行独立的 `📊 上下文 N%`，与 usage footer 同源 ⟹ 同一个百分比在
  // 一张卡上出现两次（footer 还多带绝对值）。合并后整张卡对「上下文百分比」只能有一处。
  it('never renders the context percentage twice on one card', () => {
    const card = build({
      status: 'working',
      displayMode: 'screenshot',
      usage: { context: { usedTokens: 34_300, windowTokens: 258_400, percentUsed: 13 } },
    });
    const withPct = card.elements.filter(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('13%'),
    );
    expect(withPct).toHaveLength(1);
    // 留下的那一处是 footer——带绝对值与窗口，不是光秃秃的百分比。
    expect(withPct[0].content).toContain('34.3K');
    expect(withPct[0].content).toContain('258.4K');
  });

  it('appends the compact hint to the footer line (not a separate row) and turns it red', () => {
    const card = build({
      status: 'working',
      usage: { context: { usedTokens: 220_000, windowTokens: 258_400, percentUsed: 85 } },
    });
    const hinted = card.elements.filter(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('建议压缩'),
    );
    // 提示只出现一次，且就在那条 usage footer 上（同一元素里既有百分比也有提示）。
    expect(hinted).toHaveLength(1);
    expect(hinted[0].content).toContain('85%');
    expect(hinted[0].content).toContain("color='red'");
  });

  it('stays grey with no hint below the threshold', () => {
    const card = build({
      status: 'working',
      usage: { context: { usedTokens: 34_300, windowTokens: 258_400, percentUsed: 13 } },
    });
    const footer = card.elements.find(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('13%'),
    );
    expect(footer.content).toContain("color='grey'");
    expect(footer.content).not.toContain('建议压缩');
  });

  it('respects a configured threshold (dashboard.contextCompactThreshold)', () => {
    mergeDashboardConfig({ contextCompactThreshold: 50 });
    expect(contextCompactThreshold()).toBe(50);
    const card = build({
      status: 'working',
      usage: { context: { usedTokens: 155_000, windowTokens: 258_400, percentUsed: 60 } },
    });
    const footer = card.elements.find(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('60%'),
    );
    expect(footer.content).toContain('建议压缩');
    expect(footer.content).toContain("color='red'");
  });

  it('falls back to the default 80 for invalid threshold values', () => {
    for (const bad of [0, 101, -5, 'foo']) {
      mergeDashboardConfig({ contextCompactThreshold: bad as any });
      expect(contextCompactThreshold()).toBe(DEFAULT_CONTEXT_COMPACT_THRESHOLD);
    }
    mergeDashboardConfig({ contextCompactThreshold: 80 });
    expect(contextCompactThreshold()).toBe(80);
  });

  it('renders no context text at all without context data (graceful degradation)', () => {
    const card = build({ status: 'working' });
    expect(card.elements.some((e: any) => e.tag === 'markdown' && e.content.includes('上下文'))).toBe(false);
  });

  it('shows usedTokens with no percentage when the CLI reports no window (Claude shape)', () => {
    const card = build({ status: 'working', usage: { context: { usedTokens: 411_100 } } });
    const footer = card.elements.find(
      (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('上下文'),
    );
    expect(footer.content).toContain('411.1K');
    expect(footer.content).not.toContain('%');
    // 没有百分比 ⟹ 阈值判断天然不触发，不会误报「建议压缩」。
    expect(footer.content).not.toContain('建议压缩');
    expect(footer.content).toContain("color='grey'");
  });

  // ── 颜色判据不得从「渲染后的文案」反推 ───────────────────────────────────
  // 提示文案（card.context.compact_hint）是**可被用户覆盖**的 copy。曾经的实现用
  // `usageSeg.includes(t('card.context.compact_hint'))` 反推是否超阈值：覆盖成空串时
  // `includes('')` 恒真 ⟹ 每张卡都变红。颜色必须问 contextOverCompactThreshold()，
  // 与 footer 追加提示用的是同一个谓词。
  describe('line colour never derives from the (customizable) hint copy', () => {
    afterEach(() => { setPromptOverrideResolver(undefined); });

    it('stays grey below the threshold even when the hint copy is overridden to an empty string', () => {
      setPromptOverrideResolver((key) => (key === 'card.context.compact_hint' ? '' : undefined));
      const card = build({
        status: 'working',
        usage: { context: { usedTokens: 34_300, windowTokens: 258_400, percentUsed: 13 } },
      });
      const footer = card.elements.find(
        (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('13%'),
      );
      expect(footer.content).toContain("color='grey'");
      expect(footer.content).not.toContain("color='red'");
    });

    it('still turns red over the threshold when the hint copy is overridden to an empty string', () => {
      setPromptOverrideResolver((key) => (key === 'card.context.compact_hint' ? '' : undefined));
      const card = build({
        status: 'working',
        usage: { context: { usedTokens: 220_000, windowTokens: 258_400, percentUsed: 85 } },
      });
      const footer = card.elements.find(
        (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('85%'),
      );
      // 覆盖成空串后提示文字消失，但**颜色仍然正确**——证明颜色不依赖那串文案。
      expect(footer.content).toContain("color='red'");
    });

    it('stays grey below the threshold even when the model name contains the hint text', () => {
      const card = build({
        status: 'working',
        usage: {
          context: { usedTokens: 34_300, windowTokens: 258_400, percentUsed: 13 },
          model: '建议压缩-v2',
        },
      });
      const footer = card.elements.find(
        (e: any) => e.tag === 'markdown' && typeof e.content === 'string' && e.content.includes('13%'),
      );
      expect(footer.content).toContain("color='grey'");
      expect(footer.content).not.toContain("color='red'");
    });
  });
});

describe('buildStreamingCard: interrupted status (transient card-side state)', () => {
  it('renders an orange header with the interrupted label', () => {
    const zh = build({ status: 'interrupted', locale: 'zh' });
    expect(zh.header.template).toBe('orange');
    expect(zh.header.title.content).toContain('已中断');

    const en = build({ status: 'interrupted', locale: 'en' });
    expect(en.header.template).toBe('orange');
    expect(en.header.title.content).toContain('Interrupted');
  });
});

describe('buildStreamingCard: signature stability', () => {
  it('still builds with the original positional args (no new required params)', () => {
    // 新增渲染都不需要新参数：不传 usage 也能建卡。
    const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'working'));
    expect(card.header.template).toBe('blue');
    expect(findButton(headerActions(card), 'stop_turn')).toBeTruthy();
    // 压缩按钮不再依赖 usage/百分比：cliId 缺省回退 claude-code（有输入通道）⟹ 应显示。
    // 这正是本次修复的核心——Claude 会话此前因为拿不到百分比而永远没有这个按钮。
    expect(findButton(headerActions(card), 'compact_session')).toBeTruthy();
    // 没有 usage ⟹ 不渲染任何上下文文字（不会凭空冒出百分比或「建议压缩」）。
    expect(card.elements.some((e: any) => e.tag === 'markdown' && e.content.includes('上下文'))).toBe(false);
  });
});
