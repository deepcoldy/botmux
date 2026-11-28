import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import {
  readWecomFleetDesiredState,
  setWecomFleetDesiredState,
  setWecomFleetDesiredStopped,
} from '../src/im/wecom/config/fleet-desired-state.js';
import { listWecomFleetConnections } from '../src/im/wecom/config/fleet-members.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';
import { wecomStatusNotes, type WecomStatusNoteDeps } from '../src/cli/wecom/status-notes.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(config: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wecom-status-notes-'));
  dirs.push(root);
  const file = join(root, 'a', 'config.json');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ botId: 'bot-a', coreUrl: 'http://127.0.0.1:18080', allowedUsers: ['u'], ...config }));
  writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: [file] }));
  const configId = wecomConfigId(file);
  return { root, configId, member: wecomFleetMemberName(configId) };
}

function deps(root: string, reads: string[] = []): WecomStatusNoteDeps {
  return {
    listConnections: () => { reads.push('registry'); return listWecomFleetConnections(root); },
    readDesired: () => {
      reads.push('desired');
      const snapshot = readWecomFleetDesiredState(root);
      return snapshot.status === 'ok' ? snapshot.connections : undefined;
    },
  };
}

describe('botmux status under its table', () => {
  it('says why a WeCom member is down when its gateway stopped it, naming a missing credential variable', () => {
    const f = fixture({ secretEnv: 'PROBE_WECOM_SECRET' });
    setWecomFleetDesiredStopped(f.configId, 'credential_env_missing', { root: f.root });
    const notes = wecomStatusNotes([{ name: f.member, status: 'errored' }], deps(f.root));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(f.member);
    expect(notes[0]).toContain('PROBE_WECOM_SECRET');
  });

  it('says nothing for a running member or a person\'s stop', () => {
    const f = fixture();
    setWecomFleetDesiredState(f.configId, 'stopped', { root: f.root });
    expect(wecomStatusNotes([{ name: f.member, status: 'stopped' }], deps(f.root))).toEqual([]);
    setWecomFleetDesiredStopped(f.configId, 'replaced', { root: f.root });
    expect(wecomStatusNotes([{ name: f.member, status: 'online' }], deps(f.root))).toEqual([]);
  });

  it('reads no WeCom file for a table of Feishu bots and the Dashboard', () => {
    const f = fixture();
    const reads: string[] = [];
    const rows = [{ name: 'botmux-0', status: 'errored' }, { name: 'botmux-dashboard', status: 'stopped' }];
    expect(wecomStatusNotes(rows, deps(f.root, reads))).toEqual([]);
    expect(reads).toEqual([]);
  });
});
