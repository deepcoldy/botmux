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
  it('renders when context percentUsed is available', () => {
    const card = build({ status: 'working', usage: { context: { percentUsed: 45 } } });
    const btn = findButton(headerActions(card), 'compact_session');
    expect(btn).toBeTruthy();
    expect(btn.text.content).toContain('压缩');
    expect(btn.value.action).toBe('compact_session');
    expect(btn.value.root_id).toBe(ROOT);
    expect(btn.value.session_id).toBe(SID);
  });

  it('is hidden when usage is absent or carries no context window (graceful degradation)', () => {
    expect(findButton(headerActions(build({ status: 'working' })), 'compact_session')).toBeFalsy();
    expect(findButton(headerActions(build({ status: 'working', usage: { context: null } })), 'compact_session')).toBeFalsy();
    expect(findButton(headerActions(build({ status: 'working', usage: {} })), 'compact_session')).toBeFalsy();
  });
});

describe('buildStreamingCard: context-headroom indicator', () => {
  it('renders a grey indicator below the threshold', () => {
    const card = build({ status: 'working', usage: { context: { percentUsed: 45 } } });
    // hidden 模式 + 无 usedTokens → pushStreamBody 不产出 markdown，指示条是首个 markdown。
    const md = card.elements.find((e: any) => e.tag === 'markdown');
    expect(md).toBeTruthy();
    expect(md.content).toContain('45%');
    expect(md.content).toContain("color='grey'");
    expect(md.content).not.toContain('建议压缩');
  });

  it('turns red and suggests compacting at or above the default 80% threshold', () => {
    const card = build({ status: 'working', usage: { context: { percentUsed: 85 } } });
    const md = card.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content).toContain('85%');
    expect(md.content).toContain("color='red'");
    expect(md.content).toContain('建议压缩');
  });

  it('respects a configured threshold (dashboard.contextCompactThreshold)', () => {
    mergeDashboardConfig({ contextCompactThreshold: 50 });
    expect(contextCompactThreshold()).toBe(50);
    const card = build({ status: 'working', usage: { context: { percentUsed: 60 } } });
    const md = card.elements.find((e: any) => e.tag === 'markdown');
    expect(md.content).toContain("color='red'");
    expect(md.content).toContain('建议压缩');
  });

  it('falls back to the default 80 for invalid threshold values', () => {
    for (const bad of [0, 101, -5, 'foo']) {
      mergeDashboardConfig({ contextCompactThreshold: bad as any });
      expect(contextCompactThreshold()).toBe(DEFAULT_CONTEXT_COMPACT_THRESHOLD);
    }
    // 80 本身合法、生效；79 仍灰色。
    mergeDashboardConfig({ contextCompactThreshold: 80 });
    expect(contextCompactThreshold()).toBe(80);
  });

  it('renders nothing without context data (graceful degradation)', () => {
    const card = build({ status: 'working' });
    expect(card.elements.some((e: any) => e.tag === 'markdown' && e.content.includes('上下文'))).toBe(false);
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
    // 新增渲染全部是条件性的：不传 usage / 不传新参数时卡片与之前等价。
    const card = parse(buildStreamingCard(SID, ROOT, URL, TITLE, '', 'working'));
    expect(card.header.template).toBe('blue');
    expect(findButton(headerActions(card), 'stop_turn')).toBeTruthy();
    expect(findButton(headerActions(card), 'compact_session')).toBeFalsy();
  });
});
