/**
 * The worker's `away_summary_focus` case: the daemon asks after a turn's last
 * card settled; only a Claude Code session botmux launched in a tmux or pty
 * pane passes the request on (services/away-summary-focus.ts decides when to
 * write the focus report).
 */
import { describe, expect, it, vi } from 'vitest';
import { awaySummaryFocusRefusal } from '../src/services/away-summary-focus.js';
import { loadWorkerMessageHandler } from './helpers/worker-function-harness.js';

function worker(lastInitConfig: Record<string, unknown>) {
  const scope: Record<string, any> = {
    lastInitConfig,
    awaySummaryFocusRefusal,
    awaySummaryFocus: { request: vi.fn() },
    log: vi.fn(),
    send: vi.fn(),
  };
  return { scope, handle: loadWorkerMessageHandler('away_summary_focus', scope) };
}

describe('worker away_summary_focus', () => {
  it('passes the turn on for Claude Code in a pane botmux launched', async () => {
    const { scope, handle } = worker({ cliId: 'claude-code', cliVersion: '2.1.330 (Claude Code)', backendType: 'tmux' });
    await handle({ type: 'away_summary_focus', turnId: 'om_turn1' });
    expect(scope.awaySummaryFocus.request).toHaveBeenCalledWith('om_turn1');
  });

  it.each([
    [{ cliId: 'relay', cliVersion: '3.28.0 (Relay)', backendType: 'tmux' }, 'not Claude Code'],
    [{ cliId: 'claude-code', cliVersion: '2.1.330 (Claude Code)', backendType: 'tmux', adoptMode: true }, 'adopted pane'],
    [{ cliId: 'claude-code', cliVersion: '2.1.330 (Claude Code)', backendType: 'zmx' }, 'zmx backend'],
    [{ cliId: 'claude-code', backendType: 'tmux' }, 'version "unknown"'],
  ])('writes nothing for %j', async (config, reason) => {
    const { scope, handle } = worker(config);
    await handle({ type: 'away_summary_focus', turnId: 'om_turn1' });
    expect(scope.awaySummaryFocus.request).not.toHaveBeenCalled();
    expect(scope.log.mock.calls.flat().join('\n')).toContain(reason);
  });
});
