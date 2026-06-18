import { describe, it, expect } from 'vitest';
import {
  allExpectedInChat,
  renderBotCheckboxes,
  renderRoleProfileBootstrapSummary,
} from '../src/dashboard/web/groups.js';

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

describe('renderRoleProfileBootstrapSummary — create-group profile feedback', () => {
  it('renders a sent bootstrap message summary', () => {
    const html = renderRoleProfileBootstrapSummary('collab-main', 'om_bootstrap', null);

    expect(html).toContain('配置集：collab-main');
    expect(html).toContain('bootstrap 消息已发送：om_bootstrap');
    expect(html).toContain('hint-ok');
  });

  it('renders failure details and escapes interpolated values', () => {
    const html = renderRoleProfileBootstrapSummary(
      '<profile>',
      null,
      '<script>alert(1)</script>',
    );

    expect(html).not.toContain('<profile>');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;profile&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('hint-warn');
  });
});
