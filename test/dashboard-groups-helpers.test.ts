import { describe, it, expect } from 'vitest';
import { allExpectedInChat, renderBotCheckboxes } from '../src/dashboard/web/groups.js';

describe('allExpectedInChat — refreshUntilSeen commit predicate', () => {
  it('empty expected set → true (degenerate case, nothing to wait for)', () => {
    expect(allExpectedInChat({ memberBots: [] }, new Set())).toBe(true);
  });

  it('all expected bots show inChat:true → true (commit canonical snapshot)', () => {
    const row = {
      memberBots: [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: true },
        { larkAppId: 'botC', inChat: false },
      ],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(true);
  });

  it('partial: one expected bot still inChat:false → false (keep optimistic, retry)', () => {
    const row = {
      memberBots: [
        { larkAppId: 'botA', inChat: true },
        { larkAppId: 'botB', inChat: false },
      ],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(false);
  });

  it('expected bot missing from memberBots entirely → false', () => {
    const row = {
      memberBots: [{ larkAppId: 'botA', inChat: true }],
    };
    expect(allExpectedInChat(row, new Set(['botA', 'botB']))).toBe(false);
  });

  it('null/undefined row → false unless expected is empty', () => {
    expect(allExpectedInChat(undefined, new Set(['botA']))).toBe(false);
    expect(allExpectedInChat(null, new Set(['botA']))).toBe(false);
    expect(allExpectedInChat(undefined, new Set())).toBe(true);
  });
});

describe('renderBotCheckboxes — shared bot picker ordering', () => {
  it('renders in the provided dashboard bot order and filters excluded ids', () => {
    const html = renderBotCheckboxes(
      [
        { larkAppId: 'cli_b', botName: 'Beta' },
        { larkAppId: 'cli_a', botName: 'Alpha' },
        { larkAppId: 'cli_c', botName: 'Gamma' },
      ],
      new Set(['cli_a']),
    );

    expect(html).not.toContain('cli_a');
    expect(html.indexOf('cli_b')).toBeGreaterThanOrEqual(0);
    expect(html.indexOf('cli_c')).toBeGreaterThan(html.indexOf('cli_b'));
  });
});
