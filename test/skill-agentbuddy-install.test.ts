import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  installAgentbuddySkill,
  installAgentbuddySkillAsync,
  readSkillRegistry,
  removeInstalledSkill,
  updateInstalledSkill,
  updateInstalledSkillAsync,
} from '../src/services/skill-registry-store.js';

// A stand-in for the real `agentbuddy` CLI. It writes the SKILL.md tree that the
// real binary would produce with `--agent claude-code --copy` into $CWD, and
// implements `clear-embedded-telemetry` (strip @telemetry block + spans dir),
// so the wrapper's capture + telemetry-scrub + register path is exercised
// without any network/SSO. FAKE_AB_TELEMETRY=1 makes installs carry telemetry.
// Env knobs used by individual tests:
//   FAKE_AB_FAIL=1         → exit 1 with "needs login" (unauthenticated)
//   FAKE_AB_EMPTY=1        → exit 0 producing nothing
//   FAKE_AB_TELEMETRY=1    → produced skills carry a @telemetry block + spans/
//   FAKE_AB_SCRUB_NOOP=1   → clear-embedded-telemetry exits 0 but strips nothing
//   FAKE_AB_DELAY_MS=<n>   → sync-sleep before producing (force concurrency overlap)
//   FAKE_AB_PRODUCE=a,b    → produce these skill names instead of the requested/default set
const FAKE_AGENTBUDDY = `
const { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } = require('node:fs');
const { join } = require('node:path');
if (process.env.FAKE_AB_FAIL === '1') { process.stderr.write('needs login\\n'); process.exit(1); }
if (process.env.FAKE_AB_EMPTY === '1') { process.exit(0); }
const argv = process.argv.slice(2);
const TEL_START = '<!-- @telemetry:start -->';
const TEL_END = '<!-- @telemetry:end -->';
if (argv[0] === 'clear-embedded-telemetry') {
  if (process.env.FAKE_AB_SCRUB_NOOP === '1') process.exit(0); // exit 0 but leave telemetry in place
  const base = argv[1] || process.cwd();
  const skillsDir = join(base, '.claude', 'skills');
  if (existsSync(skillsDir)) {
    for (const name of readdirSync(skillsDir)) {
      const sk = join(skillsDir, name);
      const md = join(sk, 'SKILL.md');
      if (existsSync(md)) {
        let c = readFileSync(md, 'utf-8');
        const s = c.indexOf(TEL_START), e = c.indexOf(TEL_END);
        if (s >= 0 && e >= 0) c = (c.slice(0, s) + c.slice(e + TEL_END.length)).replace(/\\n{3,}/g, '\\n\\n');
        writeFileSync(md, c);
      }
      rmSync(join(sk, 'spans'), { recursive: true, force: true });
    }
  }
  process.exit(0);
}
const delay = Number(process.env.FAKE_AB_DELAY_MS || 0);
if (delay > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
function writeSkill(name, desc) {
  const dir = join(process.cwd(), '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  let body = '---\\nname: ' + name + '\\ndescription: ' + desc + '\\n---\\n# ' + name;
  if (process.env.FAKE_AB_TELEMETRY === '1') {
    body += '\\n\\n' + TEL_START + '\\nrun spans/telemetry.sh\\n' + TEL_END + '\\n';
    mkdirSync(join(dir, 'spans'), { recursive: true });
    writeFileSync(join(dir, 'spans', 'telemetry.sh'), 'echo hi');
  }
  writeFileSync(join(dir, 'SKILL.md'), body);
  writeFileSync(join(dir, 'helper.md'), 'resource for ' + name);
}
const override = process.env.FAKE_AB_PRODUCE ? process.env.FAKE_AB_PRODUCE.split(',') : null;
if (argv[1] === 'collection') {
  const uid = argv[3];
  const names = override || [uid + '-alpha', uid + '-beta'];
  for (const n of names) writeSkill(n, 'from collection ' + uid);
} else {
  const i = argv.indexOf('--skill');
  const requested = i >= 0 ? argv[i + 1] : 'unnamed';
  const v = argv.indexOf('--version');
  for (const n of (override || [requested])) writeSkill(n, v >= 0 ? ('v' + argv[v + 1]) : 'latest');
}
`;

describe('agentbuddy skill install', () => {
  let home: string;
  let fakeBin: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'botmux-ab-home-'));
    vi.stubEnv('HOME', home);
    fakeBin = join(mkdtempSync(join(tmpdir(), 'botmux-ab-bin-')), 'fake-agentbuddy.cjs');
    writeFileSync(fakeBin, FAKE_AGENTBUDDY);
    vi.stubEnv('BOTMUX_AGENTBUDDY_CMD', `node ${fakeBin}`);
    vi.stubEnv('FAKE_AB_FAIL', '');
    vi.stubEnv('FAKE_AB_EMPTY', '');
    vi.stubEnv('FAKE_AB_TELEMETRY', '');
    vi.stubEnv('FAKE_AB_SCRUB_NOOP', '');
    vi.stubEnv('FAKE_AB_DELAY_MS', '');
    vi.stubEnv('FAKE_AB_PRODUCE', '');
    vi.stubEnv('BOTMUX_AGENTBUDDY_KEEP_TELEMETRY', '');
    // Long agentbuddy runs would make the per-identifier lock wait forever on a
    // stuck holder; keep the lock's wait budget small + fast in tests.
    vi.stubEnv('BOTMUX_AGENTBUDDY_TIMEOUT_MS', '10000');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  it('installs a single skill and records an agentbuddy source', () => {
    const pkgs = installAgentbuddySkill({ group: 'example.com/team/mkt', skill: 'deploy', version: '1.2.3' });

    expect(pkgs.map((p) => p.name)).toEqual(['deploy']);
    const skill = readSkillRegistry().skills.deploy;
    expect(skill.description).toBe('v1.2.3');
    expect(skill.source).toEqual({
      type: 'agentbuddy',
      identifier: 'example.com/team/mkt/deploy@1.2.3',
      group: 'example.com/team/mkt',
      skill: 'deploy',
      version: '1.2.3',
    });
    // bundled resources are copied into the store alongside SKILL.md
    expect(existsSync(join(skill.rootDir, 'helper.md'))).toBe(true);
  });

  it('installs every skill in a collection, each re-installable via the collection', () => {
    const pkgs = installAgentbuddySkill({ collection: 'col123abc' });

    expect(pkgs.map((p) => p.name).sort()).toEqual(['col123abc-alpha', 'col123abc-beta']);
    expect(readSkillRegistry().skills['col123abc-alpha'].source).toEqual({
      type: 'agentbuddy',
      identifier: 'collection/col123abc',
      collection: 'col123abc',
      skill: 'col123abc-alpha',
    });
  });

  it('strips embedded telemetry before copying the skill into the store', () => {
    vi.stubEnv('FAKE_AB_TELEMETRY', '1');
    const [pkg] = installAgentbuddySkill({ group: 'g/h', skill: 'deploy' });

    const stored = readFileSync(join(pkg.rootDir, 'SKILL.md'), 'utf-8');
    expect(stored).not.toContain('@telemetry');
    expect(stored).toContain('# deploy');
    expect(existsSync(join(pkg.rootDir, 'spans'))).toBe(false);
  });

  it('keeps telemetry when BOTMUX_AGENTBUDDY_KEEP_TELEMETRY is set', () => {
    vi.stubEnv('FAKE_AB_TELEMETRY', '1');
    vi.stubEnv('BOTMUX_AGENTBUDDY_KEEP_TELEMETRY', '1');
    const [pkg] = installAgentbuddySkill({ group: 'g/h', skill: 'deploy' });

    expect(readFileSync(join(pkg.rootDir, 'SKILL.md'), 'utf-8')).toContain('@telemetry');
    expect(existsSync(join(pkg.rootDir, 'spans'))).toBe(true);
  });

  it('updates an installed agentbuddy skill by re-running its source', () => {
    installAgentbuddySkill({ group: 'example.com/team/mkt', skill: 'deploy', version: '1.2.3' });
    const result = updateInstalledSkill('deploy');

    expect(result.ok).toBe(true);
    expect(readSkillRegistry().skills.deploy.source).toMatchObject({ type: 'agentbuddy', version: '1.2.3' });
  });

  it('removes the store copy on uninstall', () => {
    const [pkg] = installAgentbuddySkill({ group: 'g/h', skill: 'deploy' });
    expect(existsSync(pkg.rootDir)).toBe(true);

    expect(removeInstalledSkill('deploy')).toEqual({ ok: true });
    expect(readSkillRegistry().skills.deploy).toBeUndefined();
    expect(existsSync(pkg.rootDir)).toBe(false);
  });

  it('surfaces a clean error when the CLI is missing or unauthenticated', () => {
    vi.stubEnv('BOTMUX_AGENTBUDDY_CMD', join(home, 'does-not-exist'));
    expect(() => installAgentbuddySkill({ group: 'g/h', skill: 'deploy' })).toThrow(/agentbuddy_not_found/);

    vi.stubEnv('BOTMUX_AGENTBUDDY_CMD', `node ${fakeBin}`);
    vi.stubEnv('FAKE_AB_FAIL', '1');
    expect(() => installAgentbuddySkill({ group: 'g/h', skill: 'deploy' })).toThrow(/agentbuddy_command_failed: .*needs login/);
  });

  it('errors when the CLI produces no skill', () => {
    vi.stubEnv('FAKE_AB_EMPTY', '1');
    expect(() => installAgentbuddySkill({ group: 'g/h', skill: 'deploy' })).toThrow(/agentbuddy_no_skill_produced/);
  });

  it('serializes concurrent same-identifier installs (no staging clobber)', async () => {
    vi.stubEnv('FAKE_AB_DELAY_MS', '150'); // hold the staging so the two would overlap unlocked
    const opts = { group: 'g/h', skill: 'deploy' };
    const [a, b] = await Promise.all([installAgentbuddySkillAsync(opts), installAgentbuddySkillAsync(opts)]);
    expect(a.map((p) => p.name)).toEqual(['deploy']);
    expect(b.map((p) => p.name)).toEqual(['deploy']);
    expect(readSkillRegistry().skills.deploy).toBeTruthy();
  });

  it('sync install fast-fails (no event-loop deadlock) while an async op for the same identifier is in-flight', async () => {
    vi.stubEnv('FAKE_AB_DELAY_MS', '200');
    const opts = { group: 'g/h', skill: 'deploy' };
    const asyncP = installAgentbuddySkillAsync(opts); // takes the in-process lock entry synchronously
    // A blocking sync acquire here would freeze the loop and deadlock the async
    // holder; instead it must fast-fail rather than dead-wait to the timeout.
    expect(() => installAgentbuddySkill(opts)).toThrow(/agentbuddy_busy/);
    await expect(asyncP).resolves.toMatchObject([{ name: 'deploy' }]);
  });

  it('updates an agentbuddy skill via the async (non-blocking) path', async () => {
    installAgentbuddySkill({ group: 'g/h', skill: 'deploy', version: '1.0.0' });
    const result = await updateInstalledSkillAsync('deploy');
    expect(result).toMatchObject({ ok: true, skill: { name: 'deploy', source: { type: 'agentbuddy' } } });
  });

  it('update aborts with no side effects when the target skill was renamed upstream', () => {
    installAgentbuddySkill({ group: 'g/h', skill: 'deploy' });
    vi.stubEnv('FAKE_AB_PRODUCE', 'renamed'); // upstream renamed the skill
    expect(updateInstalledSkill('deploy')).toEqual({ ok: false, reason: 'agentbuddy_update_failed' });
    // aborted before any store/registry write: no 'renamed' entry, 'deploy' untouched
    expect(readSkillRegistry().skills.renamed).toBeUndefined();
    expect(readSkillRegistry().skills.deploy).toBeTruthy();
  });

  it('collection update aborts (no re-sync of others) when the member was removed', () => {
    installAgentbuddySkill({ collection: 'col1' }); // → col1-alpha, col1-beta
    const betaBefore = readSkillRegistry().skills['col1-beta'].updatedAt;
    vi.stubEnv('FAKE_AB_PRODUCE', 'col1-beta'); // collection dropped col1-alpha
    expect(updateInstalledSkill('col1-alpha')).toEqual({ ok: false, reason: 'agentbuddy_update_failed' });
    // aborted before write: sibling col1-beta not re-synced, col1-alpha still present
    expect(readSkillRegistry().skills['col1-beta'].updatedAt).toBe(betaBefore);
    expect(readSkillRegistry().skills['col1-alpha']).toBeTruthy();
  });

  it('fails closed if telemetry survives a no-op scrub (stale/drifted agentbuddy)', () => {
    vi.stubEnv('FAKE_AB_TELEMETRY', '1');
    vi.stubEnv('FAKE_AB_SCRUB_NOOP', '1'); // scrub exits 0 but strips nothing
    expect(() => installAgentbuddySkill({ group: 'g/h', skill: 'deploy' })).toThrow(/agentbuddy_telemetry_not_stripped/);
    expect(readSkillRegistry().skills.deploy).toBeUndefined(); // nothing registered
  });
});
