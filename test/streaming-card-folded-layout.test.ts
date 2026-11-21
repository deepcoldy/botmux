import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import { resolveStreamingCardFoldedLayout, type StreamingCardButtonId } from '../src/im/lark/streaming-card-buttons.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-folded-layout-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('BOTMUX_COORDINATION_MODE', undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function build(options: {
  folded?: boolean;
  cli?: 'codex' | 'claude-code' | 'traex' | 'mojo';
  mode?: 'hidden' | 'screenshot';
  status?: 'working' | 'idle' | 'limited';
  adopt?: boolean;
  hidden?: StreamingCardButtonId[];
  terminal?: string;
  keysOpen?: boolean;
} = {}) {
  return JSON.parse(buildStreamingCard(
    'session', 'root', options.terminal ?? 'https://terminal.example.test/s/session',
    'Task', '', options.status ?? 'working', options.cli ?? 'codex',
    options.mode ?? 'hidden', 'nonce', undefined, options.adopt, true, 'zh',
    undefined, undefined, false, undefined, undefined, undefined, undefined,
    undefined, options.hidden ?? [], false, undefined, options.keysOpen ?? false,
    undefined, options.folded,
  ));
}

function buttons(node: any): any[] {
  if (!node || typeof node !== 'object') return [];
  if (node.tag === 'button') return [node];
  return Object.values(node).flatMap(value =>
    Array.isArray(value) ? value.flatMap(buttons) : buttons(value));
}

function actions(card: any): string[] {
  return buttons(card).map(button => button.value?.action ?? 'terminal');
}

function payloads(card: any): string[] {
  return buttons(card)
    .filter(button => button.value?.action !== 'toggle_keys_panel' && button.value?.action !== 'term_action')
    .map(button => JSON.stringify(button.value ?? button.multi_url))
    .sort();
}

describe('streaming-card folded layout', () => {
  it.each([{ value: undefined }, { value: true }, { value: 'false' }, { value: null }])(
    'keeps existing configs folded unless explicitly false: $value', ({ value }) => {
      expect(resolveStreamingCardFoldedLayout({ streamingCardFoldedLayout: value })).toBe(true);
    },
  );

  it('resolves explicit false to classic layout', () => {
    expect(resolveStreamingCardFoldedLayout({ streamingCardFoldedLayout: false })).toBe(false);
  });

  it.each(['hidden', 'screenshot'] as const)('leaves default card JSON unchanged in %s mode', mode => {
    expect(build({ mode })).toEqual(build({ mode, folded: true }));
    expect(build({ mode }).elements.some((element: any) => element.tag === 'collapsible_panel')).toBe(true);
  });

  it('restores the original direct action row and order without a More Actions panel', () => {
    const card = build({ folded: false });
    expect(card.elements.some((element: any) => element.tag === 'collapsible_panel')).toBe(false);
    expect(actions(card)).toEqual([
      'toggle_display', 'terminal', 'get_write_link', 'compact_session', 'stop_turn', 'close',
    ]);
    expect(card.elements.find((element: any) => element.tag === 'action').layout).toBeUndefined();
  });

  it.each(['codex', 'claude-code', 'traex', 'mojo'] as const)(
    'keeps the same callback/URL payloads and visibility guards for %s', cli => {
      for (const status of ['working', 'idle', 'limited'] as const) {
        for (const adopt of [false, true]) {
          const options = { cli, status, adopt, hidden: ['stop'] as StreamingCardButtonId[] };
          expect(payloads(build({ ...options, folded: false })))
            .toEqual(payloads(build({ ...options, folded: true })));
          expect(actions(build({ ...options, folded: false }))).not.toContain('stop_turn');
          expect(actions(build({ ...options, folded: false })))
            .toContain(adopt ? 'disconnect' : 'close');
        }
      }
    },
  );

  it.each(['hidden', 'screenshot'] as const)('does not resurrect disabled controls in classic %s mode', mode => {
    const card = build({ folded: false, mode, hidden: ['output', 'terminal', 'writeLink', 'compact', 'stop', 'close', 'substitute'] });
    expect(buttons(card).filter(button => button.value?.action !== 'term_action')).toEqual([]);
  });

  it('restores both original terminal-key rows independently of saved folded-panel state', () => {
    const card = build({ folded: false, mode: 'screenshot' });
    expect(card).toEqual(build({ folded: false, mode: 'screenshot', keysOpen: true }));
    const rows = card.elements.filter((element: any) =>
      element.tag === 'action' && element.actions?.some((button: any) => button.value?.action === 'term_action'));
    expect(rows.map((row: any) => row.actions.length)).toEqual([5, 6]);
    expect(rows[0].actions.map((button: any) => button.text.content)).toEqual(['Esc', '^C', 'Tab', '␣ Space', '↵ Enter']);
    expect(rows.flatMap((row: any) => row.actions.map((button: any) => button.value.key)))
      .toEqual(['esc', 'ctrlc', 'tab', 'space', 'enter', 'left', 'up', 'down', 'right', 'half_page_up', 'half_page_down']);
    expect(actions(card)).not.toContain('toggle_keys_panel');
  });

  it('does not expose terminal keys for hidden output or remote CLIs in classic mode', () => {
    expect(actions(build({ folded: false }))).not.toContain('term_action');
    expect(actions(build({ folded: false, mode: 'screenshot', cli: 'mojo', terminal: '' }))).not.toContain('term_action');
  });

  it('preserves primary-mode display intent and classic layout across rebuilds', () => {
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    const card = build({ folded: false });
    expect(buttons(card).find(button => button.value?.action === 'toggle_display').value)
      .toMatchObject({ target_display_mode: 'screenshot', card_nonce: 'nonce', session_id: 'session' });
    expect(actions(build({ folded: false, mode: 'screenshot' })).filter(action => action === 'term_action')).toHaveLength(11);
    expect(build({ folded: false })).toEqual(card);
  });

  it('does not depend on a usage snapshot or a terminal link to honor classic layout', () => {
    const card = build({ folded: false, terminal: '' });
    expect(actions(card)).toContain('toggle_display');
    expect(actions(card)).not.toContain('terminal');
    expect(actions(card)).not.toContain('get_write_link');
    expect(card.elements.some((element: any) => element.tag === 'collapsible_panel')).toBe(false);
  });
});
