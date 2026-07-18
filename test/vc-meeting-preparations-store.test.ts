import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findVcMeetingPreparationByChat,
  getVcMeetingPreparation,
  listVcMeetingPreparations,
  putVcMeetingPreparation,
  removeVcMeetingPreparation,
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
});
