import { describe, expect, it } from 'vitest';
import {
  TMUX_UPGRADE_ACTION_RUN,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE,
  TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL,
  TMUX_UPGRADE_ACTION_SWITCH_NOW,
  buildTmuxUpgradeCard,
  type TmuxUpgradeCardModel,
  type TmuxUpgradePhase,
} from '../src/core/tmux-upgrade-card.js';
import { isBotmuxCardAction } from '../src/core/card-action-namespace.js';
import { TMUX_UPGRADE_ACTIONS } from '../src/core/tmux-upgrade-card.js';

function model(phase: TmuxUpgradePhase, over: Partial<TmuxUpgradeCardModel> = {}): TmuxUpgradeCardModel {
  return {
    phase,
    min: '3.4',
    why: 'WHY-SENTENCE',
    client: '3.3a',
    server: '3.3a',
    serverSessions: 7,
    ...over,
  };
}

function buttons(cardJson: string): any[] {
  const card = JSON.parse(cardJson);
  return card.elements.filter((e: any) => e.tag === 'action').flatMap((e: any) => e.actions);
}
function text(cardJson: string): string {
  return JSON.parse(cardJson).elements.filter((e: any) => e.tag === 'markdown').map((e: any) => e.content).join('\n');
}

const auto = { auto: true, display: 'apt-get update && apt-get install -y tmux', tmuxPath: '/usr/bin/tmux' };

describe('tmux upgrade card', () => {
  it('reminder: versions, the reason, and ONE upgrade button bound to the card nonce', () => {
    const json = buildTmuxUpgradeCard(model('needs_upgrade', { plan: auto }), 'nonce-1', 'zh');
    expect(text(json)).toContain('3.3a');
    expect(text(json)).toContain('3.4');
    expect(text(json)).toContain('WHY-SENTENCE');
    expect(buttons(json)).toEqual([expect.objectContaining({ value: { action: TMUX_UPGRADE_ACTION_RUN, nonce: 'nonce-1' } })]);
  });

  it('reminder without an automatic route: no button, the manual way instead', () => {
    for (const reason of ['unmanaged_binary', 'needs_sudo', 'no_candidate', 'tmux_missing', 'unsupported_platform'] as const) {
      const json = buildTmuxUpgradeCard(model('needs_upgrade', {
        plan: { auto: false, reason, tmuxPath: '/home/u/.local/bin/tmux', manualCommand: 'sudo apt-get install -y tmux', hint: 'HINT' },
      }), 'n', 'en');
      expect(buttons(json)).toEqual([]);
      expect(text(json)).toContain('HINT');
    }
  });

  it('upgrading: live log tail, no buttons, fences in output neutralised', () => {
    const json = buildTmuxUpgradeCard(model('upgrading', {
      plan: auto, startedAt: 0, now: 12_000,
      log: [...Array.from({ length: 30 }, (_, i) => `l${i}`), 'line ```oops```'],
    }), 'n', 'zh');
    expect(buttons(json)).toEqual([]);
    const body = text(json);
    expect(body).toContain('l29');
    expect(body).toContain('oops');
    expect(body).not.toMatch(/\bl5\b/); // only the tail is shown
    expect(body.match(/```/g)?.length).toBe(2); // the block's own fence only
    expect(body).toContain('12');
  });

  it('failure keeps a retry button only when an automatic route exists', () => {
    expect(buttons(buildTmuxUpgradeCard(model('upgrade_failed', { plan: auto, error: 'E1' }), 'n', 'zh'))
      .map(b => b.value.action)).toEqual([TMUX_UPGRADE_ACTION_RUN]);
    expect(buttons(buildTmuxUpgradeCard(model('upgrade_failed', {
      plan: { auto: false, reason: 'needs_sudo' }, error: 'E1',
    }), 'n', 'zh'))).toEqual([]);
  });

  it('pending switch: idle (recommended) + now, and "now" asks for confirmation first', () => {
    const json = buildTmuxUpgradeCard(model('pending_switch', { client: '3.5a' }), 'n', 'zh');
    const btns = buttons(json);
    expect(btns.map(b => b.value.action)).toEqual([TMUX_UPGRADE_ACTION_SWITCH_IDLE, TMUX_UPGRADE_ACTION_SWITCH_NOW]);
    const now = btns.find(b => b.value.action === TMUX_UPGRADE_ACTION_SWITCH_NOW);
    expect(now.type).toBe('danger');
    expect(now.confirm?.title?.content).toBeTruthy();
    expect(now.confirm?.text?.content).toContain('7'); // sessions that will stop
    expect(btns.find(b => b.value.action === TMUX_UPGRADE_ACTION_SWITCH_IDLE).confirm).toBeUndefined();
  });

  it('awaiting idle: progress + "switch now" + cancel', () => {
    const json = buildTmuxUpgradeCard(model('awaiting_idle', { client: '3.5a', idleReady: 3, idleCheckedAt: 1 }), 'n', 'en');
    expect(buttons(json).map(b => b.value.action)).toEqual([TMUX_UPGRADE_ACTION_SWITCH_NOW, TMUX_UPGRADE_ACTION_SWITCH_IDLE_CANCEL]);
    expect(text(json)).toMatch(/3 of 7/);
  });

  it('a shared default server is never offered a switch', () => {
    for (const phase of ['pending_switch', 'awaiting_idle', 'switch_failed'] as const) {
      expect(buttons(buildTmuxUpgradeCard(model(phase, { sharedServer: true }), 'n', 'zh'))).toEqual([]);
    }
  });

  it('switching / done carry no buttons; done reports what happened', () => {
    expect(buttons(buildTmuxUpgradeCard(model('switching', { log: ['x'] }), 'n', 'zh'))).toEqual([]);
    const done = buildTmuxUpgradeCard(model('done', { client: '3.5a', suspended: 5, interrupted: 2 }), 'n', 'zh');
    expect(buttons(done)).toEqual([]);
    expect(text(done)).toContain('5');
    expect(text(done)).toContain('2');
  });

  it('every phase renders in both locales with a distinct header colour per outcome', () => {
    const phases: TmuxUpgradePhase[] = ['needs_upgrade', 'upgrading', 'upgrade_failed', 'pending_switch', 'awaiting_idle', 'switching', 'switch_failed', 'done'];
    for (const locale of ['zh', 'en'] as const) {
      for (const phase of phases) {
        const card = JSON.parse(buildTmuxUpgradeCard(model(phase, { plan: auto }), 'n', locale));
        expect(card.header.title.content).toBeTruthy();
        expect(card.header.title.content).not.toContain('tmux_upgrade.'); // no missing i18n key
        expect(JSON.stringify(card)).not.toMatch(/tmux_upgrade\.[a-z_.]+/);
      }
    }
    const color = (p: TmuxUpgradePhase) => JSON.parse(buildTmuxUpgradeCard(model(p), 'n', 'zh')).header.template;
    expect(color('upgrade_failed')).toBe(color('switch_failed'));
    expect(color('done')).not.toBe(color('upgrade_failed'));
  });

  it('button actions live in the reserved core namespace', () => {
    for (const action of TMUX_UPGRADE_ACTIONS) expect(isBotmuxCardAction(action)).toBe(true);
  });
});
