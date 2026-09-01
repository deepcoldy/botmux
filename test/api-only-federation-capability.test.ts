import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { registerDeployment, syncDeployment, type FederatedBot } from '../src/services/federation-store.js';
import { buildFederatedRoster } from '../src/services/federation-roster.js';

/**
 * BEHAVIORAL federation capability-propagation test (codex round-11 requirement).
 * A REMOTE apiOnly bot must federate `larkTransportEnabled: false` so the hub
 * excludes it from group membership — the roster is the source of truth the
 * member filter consults. Proves the 4-class matrix at the aggregation layer:
 *   remote normal (true) / remote apiOnly (false) / remote legacy (absent→normal).
 * (Local classes are covered by the createTeamGroup source-lock + config read.)
 */
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'botmux-fed-cap-')); });
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

function bot(larkAppId: string, extra: Partial<FederatedBot> = {}): FederatedBot {
  return { larkAppId, botName: larkAppId, cliId: 'claude-code', ...extra };
}

describe('federation larkTransportEnabled propagation → aggregated roster', () => {
  it('remote apiOnly bot arrives with larkTransportEnabled=false; normal=true; legacy=absent', () => {
    const bots = [
      bot('remote_normal', { larkTransportEnabled: true }),
      bot('remote_apionly', { larkTransportEnabled: false }),
      bot('remote_legacy'), // pre-capability spoke → field absent
    ];
    const { syncToken } = registerDeployment(dataDir, 'default', { deploymentId: 'dep-remote', name: 'Remote', bots });
    expect(syncToken).toBeTruthy();
    // Re-sync to exercise the sanitizer/store round-trip path too.
    syncDeployment(dataDir, syncToken, bots);

    const roster = buildFederatedRoster(dataDir);
    const byId = new Map(roster.bots.map(b => [b.larkAppId, b]));

    expect(byId.get('remote_normal')?.larkTransportEnabled).toBe(true);
    expect(byId.get('remote_apionly')?.larkTransportEnabled).toBe(false);
    // Legacy remote: absent → undefined → member filter treats as normal (kept).
    expect(byId.get('remote_legacy')?.larkTransportEnabled).toBeUndefined();

    // The member-filter predicate (larkTransportEnabled === false) excludes ONLY
    // the remote apiOnly, keeping remote normal AND legacy.
    const excluded = roster.bots.filter(b => b.larkTransportEnabled === false).map(b => b.larkAppId);
    expect(excluded).toEqual(['remote_apionly']);
  });

  it('HUB-LOCAL apiOnly bot also carries larkTransportEnabled=false into the roster (via liveBots)', () => {
    // Regression for the producer-side gap: buildFederatedRoster's LOCAL bot
    // mapping must propagate transport from liveBots, or a hub's own core-only
    // bot reaches spokes as undefined (legacy-normal) and slips group filters.
    const liveBots = [
      { larkAppId: 'local_normal', botName: 'Normal', cliId: 'claude-code', larkTransportEnabled: true },
      { larkAppId: 'local_core', botName: 'CoreOnly', cliId: 'claude-code', larkTransportEnabled: false },
      { larkAppId: 'local_legacy', botName: 'Legacy', cliId: 'claude-code' }, // transport unknown → undefined
    ];
    const roster = buildFederatedRoster(dataDir, 'default', undefined, undefined, liveBots);
    const byId = new Map(roster.bots.map(b => [b.larkAppId, b]));
    expect(byId.get('local_normal')?.larkTransportEnabled).toBe(true);
    expect(byId.get('local_core')?.larkTransportEnabled).toBe(false);
    expect(byId.get('local_legacy')?.larkTransportEnabled).toBeUndefined();
    expect(roster.bots.filter(b => b.larkTransportEnabled === false).map(b => b.larkAppId)).toEqual(['local_core']);
  });
});
