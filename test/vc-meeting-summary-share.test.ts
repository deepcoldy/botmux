import { mkdtempSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { shareVcMeetingSummary } from '../src/services/vc-meeting-summary-share.js';
import type { VcMeetingImTurnOrigin } from '../src/types.js';

let dir: string;
const origin: VcMeetingImTurnOrigin = {
  listenerAppId: 'listener', meetingId: 'meeting', memberId: 'minutes', memberEpoch: 1,
  agentAppId: 'agent', ownerBootId: 'boot', ownerEpoch: 1, membershipGeneration: 1,
  sinkOwnerGeneration: 1, receiverSessionId: 'session', larkMessageId: 'om_human',
  replyTargetSenderOpenId: 'ou_requester', summaryShareTargetChatId: 'oc_destination',
};
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'summary-share-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
function harness() {
  return { dataDir: dir, origin: { ...origin }, content: 'Decisions and actions',
    assertAuthority: vi.fn(), checkAccess: vi.fn(async () => {}), send: vi.fn(async () => 'om_sent') };
}
describe('managed summary sharing', () => {
  it('freezes destination/content and survives retry/restart without sending twice', async () => {
    const input = harness();
    expect(await shareVcMeetingSummary(input)).toMatchObject({ ok: true, replay: false, chatId: 'oc_destination' });
    expect(input.send).toHaveBeenCalledWith('oc_destination', input.content, expect.stringMatching(/^vcs_/));
    const restarted = harness();
    expect(await shareVcMeetingSummary(restarted)).toMatchObject({ ok: true, replay: true, messageId: 'om_sent' });
    expect(restarted.send).not.toHaveBeenCalled();
    expect(await shareVcMeetingSummary({ ...input, content: 'different' })).toMatchObject({ ok: false, errorCode: 'summary_share_content_conflict' });
    expect(input.send).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent retries', async () => {
    const input = harness();
    const results = await Promise.all([shareVcMeetingSummary(input), shareVcMeetingSummary(input)]);
    expect(input.send).toHaveBeenCalledTimes(1);
    expect(results.some(result => result.ok)).toBe(true);
  });
  it('does not resend after an ambiguous send or lost receipt acknowledgement', async () => {
    const input = harness();
    input.send.mockRejectedValueOnce(new Error('timeout after send'));
    expect(await shareVcMeetingSummary(input)).toMatchObject({ ok: false, errorCode: 'summary_share_result_unknown_check_target_before_retry' });
    expect(await shareVcMeetingSummary(harness())).toMatchObject({ ok: false });
    expect(input.send).toHaveBeenCalledTimes(1);
  });
  it('checks authority again after membership I/O and refuses revoked turns', async () => {
    const input = harness();
    input.checkAccess.mockImplementation(async () => { input.assertAuthority.mockImplementation(() => { throw new Error('revoked'); }); });
    await expect(shareVcMeetingSummary(input)).rejects.toThrow('revoked');
    expect(input.send).not.toHaveBeenCalled();
    expect(await shareVcMeetingSummary(harness())).toMatchObject({ ok: true });
  });
  it('does not create a send claim when target access fails', async () => {
    const input = harness();
    input.checkAccess.mockRejectedValueOnce(new Error('bot not in chat'));
    await expect(shareVcMeetingSummary(input)).rejects.toThrow('bot not in chat');
    expect(input.send).not.toHaveBeenCalled();
    expect(await shareVcMeetingSummary(input)).toMatchObject({ ok: true });
  });
  it('fails closed on corrupt evidence, missing grant, oversize text and mention payloads', async () => {
    const input = harness();
    for (const content of ['', 'x'.repeat(30001), '<at user_id="ou_other">all</at>']) {
      expect(await shareVcMeetingSummary({ ...input, content })).toMatchObject({ ok: false });
    }
    expect(await shareVcMeetingSummary({ ...input, origin: { ...origin, summaryShareTargetChatId: undefined } })).toMatchObject({ ok: false });
    expect(input.send).not.toHaveBeenCalled();
    await shareVcMeetingSummary(input);
    const folder = join(dir, 'vc-meeting-summary-shares');
    writeFileSync(join(folder, readdirSync(folder).find(name => name.endsWith('.json'))!), '{broken');
    await expect(shareVcMeetingSummary(input)).rejects.toThrow();
    expect(input.send).toHaveBeenCalledTimes(1);
  });
});
