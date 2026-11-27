import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { beginFeedbackMaintenance, inspectFeedbackMaintenance } from '../src/services/feedback-maintenance.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { wecomFleetMemberName } from '../src/im/wecom/contract/fleet-member.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
  await rm(join(process.env.HOME!, '.botmux', 'fleet-state.json'), { force: true });
});

async function blockersWithFleetRow(name: string, migrationId: string): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'feedback-wecom-member-'));
  directories.push(directory);
  const home = process.env.HOME!;
  await mkdir(join(home, '.botmux'), { recursive: true });
  // A live pid (this process) with no registered participant.
  await writeFile(join(home, '.botmux', 'fleet-state.json'), JSON.stringify({ procs: [{ name, pid: process.pid }] }));
  await beginFeedbackMaintenance(directory, migrationId);
  return (await inspectFeedbackMaintenance(directory, migrationId)).blockers;
}

describe('feedback maintenance and WeCom gateway members', () => {
  it('does not count a live WeCom gateway row as an unsupported daemon', async () => {
    const name = wecomFleetMemberName(wecomConfigId('/home/u/.botmux/wecom/config.json'));
    expect(await blockersWithFleetRow(name, 'wecom-member')).not.toContain(`unsupported_daemon:${process.pid}`);
  });

  it('still blocks on a live Feishu daemon row in the same position', async () => {
    expect(await blockersWithFleetRow('botmux-production', 'feishu-member')).toContain(`unsupported_daemon:${process.pid}`);
  });
});
