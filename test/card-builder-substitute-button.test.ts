import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import { globalConfigPath, invalidateGlobalConfigCache } from '../src/global-config.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-card-substitute-'));
  vi.stubEnv('HOME', home);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  invalidateGlobalConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  rmSync(home, { recursive: true, force: true });
});

function build(opts: {
  enabled?: boolean;
  control?: { enabled: boolean } | undefined;
  hidden?: string[];
} = {}): any {
  const json = buildStreamingCard(
    'sess-sub',
    'om_root_sub',
    'https://example.com/term',
    'Substitute Task',
    '',
    'working' as any,
    'claude-code' as any,
    'hidden' as any,
    undefined,
    undefined,
    false,
    false,
    'zh' as any,
    undefined,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (opts.hidden ?? []) as any,
    false,
    opts.control,
  );
  return JSON.parse(json);
}

function cardButtons(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap(cardButtons);
  return [
    ...(node.tag === 'button' ? [node] : []),
    ...Object.values(node).flatMap(cardButtons),
  ];
}

function substituteButton(card: any): any {
  return cardButtons(card).find((button: any) => button.value?.action === 'toggle_substitute');
}

describe('buildStreamingCard: per-group substitute toggle', () => {
  it('does not render without a resolved control (fail-closed)', () => {
    expect(substituteButton(build({ control: undefined }))).toBeFalsy();
  });

  it('renders the close action when the group is currently enabled', () => {
    const btn = substituteButton(build({ control: { enabled: true } }));
    expect(btn).toBeTruthy();
    expect(btn.text.content).toContain('关闭替身模式');
    expect(btn.value.action).toBe('toggle_substitute');
    expect(btn.value.desired).toBe('off');
    expect(btn.value.root_id).toBe('om_root_sub');
    expect(btn.value.session_id).toBe('sess-sub');
  });

  it('renders the open action when the group is currently disabled', () => {
    const btn = substituteButton(build({ control: { enabled: false } }));
    expect(btn).toBeTruthy();
    expect(btn.text.content).toContain('开启替身模式');
    expect(btn.value.desired).toBe('on');
  });

  it('honors hiddenStreamingCardButtons=substitute', () => {
    expect(substituteButton(build({ control: { enabled: true }, hidden: ['substitute'] }))).toBeFalsy();
  });

  it('keeps display and session controls reachable', () => {
    const card = build({ control: { enabled: true } });
    const actions = cardButtons(card).map((button: any) => button.value?.action ?? 'url');
    expect(actions).toContain('toggle_display');
    expect(actions).toContain('toggle_substitute');
    expect(actions).toContain('close');
  });
});
