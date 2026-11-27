import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  setWecomFleetDesiredStopped,
  updateWecomFleetDesiredState,
  wecomFleetDesiredStatePath,
} from '../src/im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections } from '../src/im/wecom/config/fleet-members.js';
import {
  credentialEnvReleaseLines,
  releaseCredentialEnvStops,
  type CredentialEnvReleaseDeps,
} from '../src/cli/wecom/credential-env-release.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-credential-env-'));
  dirs.push(root);
  const paths: string[] = [];
  const add = (name: string, config: Record<string, unknown>) => {
    const file = join(root, name, 'config.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ botId: `bot-${name}`, coreUrl: 'http://127.0.0.1:18080', allowedUsers: ['u'], ...config }));
    paths.push(file);
    writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths }));
    return wecomConfigId(file);
  };
  return { root, add };
}

function deps(root: string, env: NodeJS.ProcessEnv, reads: string[] = []): CredentialEnvReleaseDeps {
  return {
    env,
    desiredStateExists: () => { reads.push('exists'); return existsSync(wecomFleetDesiredStatePath(root)); },
    readDesired: () => {
      reads.push('desired');
      const snapshot = readWecomFleetDesiredState(root);
      return snapshot.status === 'ok' ? snapshot.connections : undefined;
    },
    listConnections: () => { reads.push('registry'); return listWecomFleetConnections(root); },
    update: mutate => { reads.push('write'); updateWecomFleetDesiredState(mutate, { root }); },
    now: () => new Date('2026-11-18T10:00:00.000Z'),
  };
}

const recordOf = (root: string, configId: string) => {
  const snapshot = readWecomFleetDesiredState(root);
  return snapshot.status === 'ok' ? snapshot.connections.get(configId) : undefined;
};

describe('a connection stopped because the fleet lacked its credential variable', () => {
  it('is recorded running again when the environment the new supervisor starts from has the variable', () => {
    const f = fixture();
    const id = f.add('a', { secretEnv: 'PROBE_WECOM_SECRET' });
    setWecomFleetDesiredStopped(id, 'credential_env_missing', { root: f.root });
    const outcome = releaseCredentialEnvStops(deps(f.root, { PROBE_WECOM_SECRET: 'value-never-printed' }));
    expect(outcome.released.map(r => [r.configId, r.variable])).toEqual([[id, 'PROBE_WECOM_SECRET']]);
    expect(recordOf(f.root, id)).toEqual({ desired: 'running', updatedAt: '2026-11-18T10:00:00.000Z' });
    const lines = credentialEnvReleaseLines(outcome);
    expect([...lines.info, ...lines.warn].join('\n')).not.toContain('value-never-printed');
  });

  it('stays stopped, named in a warning, when the variable is missing or empty here too', () => {
    for (const env of [{}, { PROBE_WECOM_SECRET: '' }]) {
      const f = fixture();
      const id = f.add('a', { secretEnv: 'PROBE_WECOM_SECRET' });
      setWecomFleetDesiredStopped(id, 'credential_env_missing', { root: f.root });
      const before = readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8');
      const reads: string[] = [];
      const outcome = releaseCredentialEnvStops(deps(f.root, env, reads));
      expect(outcome.released).toEqual([]);
      expect(outcome.kept.map(k => k.variable)).toEqual(['PROBE_WECOM_SECRET']);
      expect(readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8')).toBe(before);
      expect(reads).not.toContain('write');
      expect(credentialEnvReleaseLines(outcome).warn.join('\n')).toContain('PROBE_WECOM_SECRET');
    }
  });

  it('leaves every other record alone: a person\'s stop, another reason, running', () => {
    const f = fixture();
    const personStopped = f.add('a', { secretEnv: 'PROBE_WECOM_SECRET' });
    const replaced = f.add('b', { secretEnv: 'PROBE_WECOM_SECRET' });
    const running = f.add('c', { secretEnv: 'PROBE_WECOM_SECRET' });
    setWecomFleetDesiredState(personStopped, 'stopped', { root: f.root });
    setWecomFleetDesiredStopped(replaced, 'replaced', { root: f.root });
    setWecomFleetDesiredState(running, 'running', { root: f.root });
    const before = readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8');
    const reads: string[] = [];
    const outcome = releaseCredentialEnvStops(deps(f.root, { PROBE_WECOM_SECRET: 'x' }, reads));
    expect(outcome).toEqual({ released: [], kept: [] });
    expect(readFileSync(wecomFleetDesiredStatePath(f.root), 'utf8')).toBe(before);
    expect(reads).toEqual(['exists', 'desired']);
  });

  it('does not overwrite a record someone changed between the read and the write', () => {
    const f = fixture();
    const id = f.add('a', { secretEnv: 'PROBE_WECOM_SECRET' });
    setWecomFleetDesiredStopped(id, 'credential_env_missing', { root: f.root });
    const d = deps(f.root, { PROBE_WECOM_SECRET: 'x' });
    const list = d.listConnections;
    d.listConnections = () => {
      setWecomFleetDesiredState(id, 'stopped', { root: f.root });
      return list();
    };
    const outcome = releaseCredentialEnvStops(d);
    expect(outcome.released).toEqual([]);
    expect(recordOf(f.root, id)).toMatchObject({ desired: 'stopped' });
    expect(recordOf(f.root, id)?.reason).toBeUndefined();
  });

  it('reads nothing but one existence check on a host without a WeCom desired-state file', () => {
    const f = fixture();
    const reads: string[] = [];
    expect(releaseCredentialEnvStops(deps(f.root, { PROBE_WECOM_SECRET: 'x' }, reads))).toEqual({ released: [], kept: [] });
    expect(reads).toEqual(['exists']);
  });
});
