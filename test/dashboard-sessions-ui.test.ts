import { describe, expect, it } from 'vitest';
import { canRestartSession, renderCliFilterGroup, restartConfirmMessage } from '../src/dashboard/web/sessions.js';

describe('dashboard sessions filters', () => {
  it('renders CLI filters as same-name checkboxes checked by default for multi-select filtering', () => {
    const html = renderCliFilterGroup();

    expect(html).toContain('type="checkbox"');
    expect(html).toContain('name="cli"');
    expect(html).toContain('value="codex"');
    expect(html).toContain('value="codex-app"');
    expect(html).toContain('value="mira"');
    expect(html).toContain('value="pi"');
    expect(html).toMatch(/value="codex" checked/);
    expect(html).toMatch(/value="pi" checked/);
    expect(html).not.toContain('<select');
  });

  it('builds restart confirmation text with current status and CLI', () => {
    const message = restartConfirmMessage({ status: 'working', cliId: 'codex' });

    expect(message).toContain('当前状态：工作中');
    expect(message).toContain('CLI：codex');
    expect(message).toContain('确认重启');
  });

  it('only shows restart for active botmux-owned sessions whose CLI has started', () => {
    expect(canRestartSession({ status: 'idle', adopt: false })).toBe(true);
    expect(canRestartSession({ status: 'closed', adopt: false })).toBe(false);
    expect(canRestartSession({ status: 'idle', adopt: true })).toBe(false);
    expect(canRestartSession({ status: 'starting', pendingRepo: true })).toBe(false);
  });
});
