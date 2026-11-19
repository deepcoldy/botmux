import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import {
  findVcMeetingPreparationByChat,
  getVcMeetingPreparation,
  listVcMeetingPreparations,
  putVcMeetingPreparation,
  removeVcMeetingPreparation,
  removeVcMeetingPreparationsForApp,
} from '../src/services/vc-meeting-preparations-store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-vc-prep-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('vc meeting preparations store', () => {
  it('persists a preparation by normalized meeting number and chat', () => {
    const dir = tempDir();
    const record = putVcMeetingPreparation(dir, {
      larkAppId: 'cli_listener',
      meetingNo: '688 542 737',
      meetingLink: 'https://vc-my.larkoffice.com/j/688542737',
      prepChatId: 'oc_preparation',
      agentAppId: 'cli_agent',
      agentSessionId: 'session_agent',
      ownerOpenId: 'ou_owner',
      qaMode: 'auto',
    });

    expect(record.meetingNo).toBe('688542737');
    expect(getVcMeetingPreparation(dir, 'cli_listener', '688-542-737')).toMatchObject({
      prepChatId: 'oc_preparation',
      agentAppId: 'cli_agent',
      qaMode: 'auto',
    });
    expect(findVcMeetingPreparationByChat(dir, 'cli_listener', 'oc_preparation')?.meetingNo).toBe('688542737');
    expect(listVcMeetingPreparations(dir, 'cli_listener')).toHaveLength(1);
  });

  it('removes a preparation without touching other bots', () => {
    const dir = tempDir();
    for (const larkAppId of ['cli_a', 'cli_b']) {
      putVcMeetingPreparation(dir, {
        larkAppId,
        meetingNo: '688542737',
        prepChatId: `oc_${larkAppId}`,
        agentAppId: larkAppId,
        qaMode: 'auto',
      });
    }
    expect(removeVcMeetingPreparation(dir, 'cli_a', '688542737')?.larkAppId).toBe('cli_a');
    expect(getVcMeetingPreparation(dir, 'cli_b', '688542737')).toBeDefined();
  });

  it('serializes read-modify-write with other processes (no lost update)', async () => {
    const dir = tempDir();
    const fp = join(dir, 'vc-meeting-preparations.json');
    // Another daemon holds the store lock across its own read-modify-write.
    const child = spawnTsEvalWithRepoImports(`
      const { withFileLockSync } = await import(${JSON.stringify(new URL('../src/utils/file-lock.js', import.meta.url).pathname)});
      const { existsSync, readFileSync, writeFileSync, renameSync } = await import('node:fs');
      const fp = ${JSON.stringify(fp)};
      withFileLockSync(fp, () => {
        const store = existsSync(fp) ? JSON.parse(readFileSync(fp, 'utf8')) : {};
        process.stdout.write('locked\\n');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
        store['cli_other:123456789'] = {
          larkAppId: 'cli_other', meetingNo: '123456789', prepChatId: 'oc_other',
          agentAppId: 'cli_other', qaMode: 'auto', createdAt: 1, updatedAt: 1,
        };
        writeFileSync(fp + '.tmp', JSON.stringify(store));
        renameSync(fp + '.tmp', fp);
      });
    `, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', chunk => { if (String(chunk).includes('locked')) resolve(); });
      child.once('exit', code => reject(new Error(`child exited early: ${code}`)));
    });

    putVcMeetingPreparation(dir, {
      larkAppId: 'cli_mine',
      meetingNo: '688542737',
      prepChatId: 'oc_mine',
      agentAppId: 'cli_mine',
      qaMode: 'auto',
    });
    expect(await exited).toBe(0);

    expect(getVcMeetingPreparation(dir, 'cli_other', '123456789')).toBeDefined();
    expect(getVcMeetingPreparation(dir, 'cli_mine', '688542737')).toBeDefined();
  }, 20_000);

  it('quarantines a corrupt file before a write instead of silently overwriting it', () => {
    const dir = tempDir();
    const fp = join(dir, 'vc-meeting-preparations.json');
    writeFileSync(fp, '{broken', 'utf-8');

    putVcMeetingPreparation(dir, {
      larkAppId: 'cli_a', meetingNo: '688542737', prepChatId: 'oc_a', agentAppId: 'cli_a', qaMode: 'auto',
    });

    const evidence = readdirSync(dir).filter(name => name.startsWith('vc-meeting-preparations.json.corrupt-'));
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(dir, evidence[0]!), 'utf-8')).toBe('{broken');
    expect(listVcMeetingPreparations(dir, 'cli_a')).toHaveLength(1);
  });

  it('keeps entries it cannot interpret when it rewrites the file', () => {
    const dir = tempDir();
    const fp = join(dir, 'vc-meeting-preparations.json');
    const foreign = { larkAppId: 'cli_future', meetingNo: 'not-a-number', note: 'written by a newer version' };
    writeFileSync(fp, JSON.stringify({ 'cli_future:x': foreign }), 'utf-8');

    putVcMeetingPreparation(dir, {
      larkAppId: 'cli_a', meetingNo: '688542737', prepChatId: 'oc_a', agentAppId: 'cli_a', qaMode: 'auto',
    });
    expect(removeVcMeetingPreparation(dir, 'cli_a', '688542737')).toBeDefined();

    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toEqual({ 'cli_future:x': foreign });
  });

  it('removes all of one bot\'s preparations in one update', () => {
    const dir = tempDir();
    for (const [larkAppId, meetingNo] of [['cli_a', '111111111'], ['cli_a', '222222222'], ['cli_b', '333333333']]) {
      putVcMeetingPreparation(dir, { larkAppId, meetingNo, prepChatId: `oc_${meetingNo}`, agentAppId: larkAppId, qaMode: 'auto' });
    }
    expect(removeVcMeetingPreparationsForApp(dir, 'cli_a')).toBe(2);
    expect(listVcMeetingPreparations(dir, 'cli_a')).toEqual([]);
    expect(listVcMeetingPreparations(dir, 'cli_b')).toHaveLength(1);
  });

  it('still reads a hand-edited top-level array and keeps "__proto__" passthrough entries', () => {
    const dir = tempDir();
    const fp = join(dir, 'vc-meeting-preparations.json');
    writeFileSync(fp, JSON.stringify([{
      larkAppId: 'cli_a', meetingNo: '688542737', prepChatId: 'oc_a', agentAppId: 'cli_a', qaMode: 'auto',
    }]), 'utf-8');
    expect(getVcMeetingPreparation(dir, 'cli_a', '688542737')?.prepChatId).toBe('oc_a');

    writeFileSync(fp, '{"__proto__":{"note":"opaque"},"keep":{"note":"opaque too"}}', 'utf-8');
    putVcMeetingPreparation(dir, { larkAppId: 'cli_b', meetingNo: '123456789', prepChatId: 'oc_b', agentAppId: 'cli_b', qaMode: 'auto' });
    const written = JSON.parse(readFileSync(fp, 'utf-8')) as Record<string, unknown>;
    expect(Object.keys(written).sort()).toEqual(['__proto__', 'cli_b:123456789', 'keep']);
  });

  it('lets a tolerant pre-read leave a corrupt file for the locked write to quarantine and rebuild', () => {
    // /vc prepare does a tolerant informational read, then a strict write:
    // corruption must not block the write path (which quarantines evidence
    // and rebuilds), and the tolerant read itself must never quarantine.
    const dir = tempDir();
    const fp = join(dir, 'vc-meeting-preparations.json');
    putVcMeetingPreparation(dir, {
      larkAppId: 'cli_a', meetingNo: '111111111', prepChatId: 'oc_a', agentAppId: 'cli_a', qaMode: 'auto',
    });
    writeFileSync(fp, '{broken', 'utf-8');

    expect(findVcMeetingPreparationByChat(dir, 'cli_a', 'oc_a')).toBeUndefined();
    expect(readdirSync(dir).filter(name => name.includes('.corrupt'))).toEqual([]);

    putVcMeetingPreparation(dir, {
      larkAppId: 'cli_a', meetingNo: '222222222', prepChatId: 'oc_a', agentAppId: 'cli_a', qaMode: 'auto',
    });
    const evidence = readdirSync(dir).filter(name => name.startsWith('vc-meeting-preparations.json.corrupt-'));
    expect(evidence).toHaveLength(1);
    expect(readFileSync(join(dir, evidence[0]!), 'utf-8')).toBe('{broken');
    const records = listVcMeetingPreparations(dir, 'cli_a');
    expect(records).toHaveLength(1);
    expect(records[0]?.meetingNo).toBe('222222222');
  });
});

