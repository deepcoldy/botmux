import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { spawnSyncTsScript } from './helpers/ts-runner.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { TurnReplyCardStore } from '../src/services/turn-reply-card.js';
import { SkillFeedbackStore } from '../src/services/skill-feedback-store.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
import { handleSkillFeedbackCardAction } from '../src/im/lark/skill-feedback-card.js';
import { buildTurnTerminalFooterPatch } from '../src/im/lark/card-builder.js';
import { customFinalCardError } from '../src/im/lark/final-card-sections.js';
import { extractCardContent } from '../src/im/lark/message-parser.js';
import { normalizeCompletionProposalInput } from '../src/core/completion-proposal.js';

const fixture = fileURLToPath(new URL('./fixtures/send-reply-card-capture.ts', import.meta.url));
const key = { larkAppId: 'cli_test', sessionId: 'sid_custom_final', turnId: 'om_turn' };
const presentation = { showProcess: true, showToolResults: true, canStop: true };
const customCard = {
  schema: '2.0', config: { width_mode: 'fill', update_multi: true },
  header: { template: 'blue', title: { tag: 'plain_text', content: 'Review summary' } },
  body: { direction: 'vertical', padding: '16px', elements: [
    { tag: 'column_set', columns: [{ tag: 'column', width: 'weighted', weight: 1, elements: [
      { tag: 'markdown', content: '**Review complete**: two suggestions.' },
    ] }] },
    { tag: 'collapsible_panel', expanded: true,
      header: { title: { tag: 'plain_text', content: 'Suggestions' } },
      elements: [{ tag: 'markdown', content: 'Add boundary tests.' }] },
    { tag: 'button', text: { tag: 'plain_text', content: 'Details' },
      behaviors: [{ type: 'open_url', default_url: 'https://example.com/design' }] },
  ] },
};
function captured(stdout: unknown): any[] {
  return String(stdout).split('\n').filter(line => line.startsWith('CAPTURE_REPLY='))
    .map(line => JSON.parse(line.slice('CAPTURE_REPLY='.length)));
}
function setup(cliId = 'codex', feedback = true, scope = 'thread', chatType = 'group') {
  const root = mkdtempSync(join(tmpdir(), 'botmux-custom-final-'));
  const dataDir = join(root, 'data');
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
    sessionId: key.sessionId, turnId: key.turnId,
  }));
  writeFileSync(join(root, 'bots.json'), JSON.stringify([{
    larkAppId: key.larkAppId, larkAppSecret: 'test-secret', cliId, replyCardMode: 'unified',
    brandLabel: 'Example assistant', feedback: { enabled: feedback, audience: 'requester' },
  }]));
  seedPersistedSessionRows(dataDir, key.larkAppId, { [key.sessionId]: {
    sessionId: key.sessionId, status: 'active', cliId, cliSessionId: 'native_custom',
    larkAppId: key.larkAppId, chatId: 'oc_test', rootMessageId: 'om_root', scope, chatType,
    workingDir: root, ownerOpenId: 'ou_requester', lastCallerOpenId: 'ou_requester',
    replyTargets: { [key.turnId]: { updatedAt: new Date().toISOString(), senderOpenId: 'ou_requester',
      participants: [{ openId: 'ou_requester', isBot: false }] } },
    turnReplyContexts: { [key.turnId]: { replyTargetSenderOpenId: 'ou_requester', replyTargetSenderIsBot: false } },
  } });
  const run = (card: unknown = customCard, kind = 'final', args: string[] = []) => spawnSyncTsScript(fixture,
    ['send', '--card-json', JSON.stringify(card), '--response-kind', kind, ...(args.includes('--no-mention') ? [] : ['--mention-back']), ...args], {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { PATH: process.env.PATH, HOME: root, SESSION_DATA_DIR: dataDir, BOTS_CONFIG: join(root, 'bots.json'),
        BOTMUX_SESSION_ID: key.sessionId, BOTMUX_TURN_ID: key.turnId, BOTMUX_LARK_APP_ID: key.larkAppId },
      encoding: 'utf8', timeout: 30_000,
    });
  return { root, dataDir, run };
}

describe('custom schema-2 final uses the canonical reply lifecycle', () => {
  it.each([
    { cliId: 'codex', feedback: true, reserved: false, scope: 'thread', chatType: 'group' },
    { cliId: 'claude-code', feedback: false, reserved: false, scope: 'chat', chatType: 'group' },
    { cliId: 'codex', feedback: true, reserved: true, scope: 'thread', chatType: 'group' },
    { cliId: 'claude-code', feedback: false, reserved: true, scope: 'chat', chatType: 'group' },
    { cliId: 'codex', feedback: true, reserved: true, scope: 'chat', chatType: 'p2p' },
  ])('$cliId feedback=$feedback reserved=$reserved $scope/$chatType', async ({ cliId, feedback, reserved, scope, chatType }) => {
    const { root, dataDir, run } = setup(cliId, feedback, scope, chatType);
    let feedbackStore: SkillFeedbackStore | undefined;
    try {
      const replyStore = new TurnReplyCardStore(dataDir);
      const send = vi.fn(async () => 'om_original_card');
      const patch = vi.fn(async () => {});
      const io = { send, patch, beforeEffect: () => {}, isWithdrawn: () => false,
        render: (record: Parameters<typeof buildTurnReplyCard>[0]) => buildTurnReplyCard(record, presentation) };
      if (reserved) {
        await replyStore.prepare(key, { mode: 'unified', chatId: 'oc_test', rootId: 'om_root' });
        await replyStore.update(key, { kind: 'start' }, io);
      }
      const first = run();
      expect(first.status, String(first.stderr)).toBe(0);
      const requests = captured(first.stdout);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe(reserved ? 'PATCH' : 'POST');
      const card = JSON.parse(requests[0].body.content);
      expect(card.header).toEqual(customCard.header);
      expect(card.config).toMatchObject(customCard.config);
      expect(card.body.padding).toBe('16px');
      for (const element of customCard.body.elements) expect(card.body.elements).toContainEqual(element);
      expect(requests[0].body.content.match(/"element_id":"botmux_reply_footer"/g)).toHaveLength(1);
      expect(requests[0].body.content).toContain('Example assistant');
      expect((requests[0].body.content.match(/<at id=ou_requester>/g) ?? []).length).toBe(1);
      expect(buildTurnTerminalFooterPatch(requests[0].body.content, 'completed', 'zh')?.content).toContain('本轮已结束');
      const id = reserved ? 'om_original_card' : 'om_separate_message';
      feedbackStore = await SkillFeedbackStore.open(dataDir);
      const delivery = feedbackStore.findDeliveryByPlatformMessage('lark', key.larkAppId, id)!;
      expect(delivery).toMatchObject({ cardMode: feedback ? 'feedback' : 'card', status: 'delivered' });
      expect(!!delivery.policy).toBe(feedback);
      expect(!!delivery.baseCard).toBe(feedback);
      // Answers are not written to the feedback template. Its policy/control
      // still enables a callback to reconstruct from the delivered custom card.
      expect(JSON.stringify(delivery.baseCard ?? {})).not.toContain('two suggestions');
      if (reserved) {
        expect(replyStore.read(key)).toMatchObject({ messageId: id, finalDelivered: true });
        await replyStore.update(key, { kind: 'terminal', phase: 'completed', durationMs: 1200 }, io);
        expect(send).toHaveBeenCalledTimes(1); // terminal only patches the same card
        expect(replyStore.read(key)?.lastCard).not.toContain('本轮没有提供最终答复');
        expect(JSON.parse(replyStore.read(key)!.lastCard!).header).toEqual(customCard.header);
      }
      const finalCard = reserved ? JSON.parse(replyStore.read(key)!.lastCard!) : card;
      expect(JSON.stringify(finalCard).includes('feedback_submit')).toBe(feedback);
      feedbackStore.recordTurnTerminal({ botAppId: key.larkAppId, sessionId: key.sessionId, turnId: key.turnId,
        status: 'completed', completedAt: new Date().toISOString(), durationMs: 1200 });
      expect(feedbackStore.listTurnCompletionEvents()).toHaveLength(1);
      if (feedback) {
        const callback = await handleSkillFeedbackCardAction({ context: { open_message_id: id },
          operator: { open_id: 'ou_requester', union_id: 'on_requester' }, action: { value: { action: 'feedback_submit', result: 'conclusive_usable' } },
        } as any, key.larkAppId, { store: feedbackStore, loadBaseCard: async () => finalCard });
        expect(callback.card?.data.header).toEqual(customCard.header);
        expect(JSON.stringify(callback.card?.data)).toContain('two suggestions');
      }
      const again = run();
      expect(again.status, String(again.stderr)).toBe(0);
      expect(captured(again.stdout)).toHaveLength(0);
      expect(String(again.stdout)).toContain('"replayed":true');
      const changed = run({ ...customCard, header: { ...customCard.header, template: 'red' } });
      expect(changed.status).not.toBe(0);
      expect(captured(changed.stdout)).toHaveLength(0);
      const progress = run(customCard, 'progress');
      expect(progress.status).not.toBe(0);
      expect(captured(progress.stdout)).toHaveLength(0);
      const markers = readFileSync(join(dataDir, 'turn-sends', `${key.sessionId}.jsonl`), 'utf8').trim().split('\n').map(s => JSON.parse(s));
      expect(markers[0]).toMatchObject({ terminalCarrier: 'standard_reply_card' });
      expect(markers[0].previewText).toContain('two suggestions');
    } finally { feedbackStore?.close(); rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    { name: 'schema 1', card: { elements: [{ tag: 'markdown', content: 'legacy' }] }, args: [] },
    { name: 'reserved footer', card: { ...customCard, body: { elements: [{ tag: 'markdown', element_id: 'botmux_reply_footer', content: 'fake' }] } }, args: [] },
    { name: 'callback', card: { ...customCard, body: { elements: [{ tag: 'button', text: { tag: 'plain_text', content: 'fake' }, behaviors: [{ type: 'callback', value: { action: 'feedback_submit' } }] }] } }, args: [] },
    { name: 'top-level', card: customCard, args: ['--top-level'] },
    { name: 'cross-chat', card: customCard, args: ['--chat-id', 'oc_elsewhere'] },
  ])('rejects $name without a send', ({ card, args }) => {
    const { root, run } = setup();
    try {
      const result = run(card, 'final', args);
      expect(result.status).not.toBe(0);
      expect(captured(result.stdout)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects a valid completion proposal at the custom-card mutual exclusion gate', () => {
    const { root, run } = setup();
    try {
      const proposal = { title: 'Next step', body: 'Add more boundary tests.',
        acceptLabel: 'Continue', dismissLabel: 'Not now' };
      const path = join(root, 'proposal.json');
      writeFileSync(path, JSON.stringify(proposal));
      // An absent or invalid file would fail independently of the mutual
      // exclusion gate and let removal of customCardRequested go undetected.
      expect(normalizeCompletionProposalInput(JSON.parse(readFileSync(path, 'utf8')))).toEqual(proposal);
      const result = run(customCard, 'final', ['--completion-proposal-file', path]);
      expect(result.status, String(result.stderr)).toBe(2);
      expect(String(result.stderr)).toContain('Completion Proposal 仅支持当前会话内的标准 final 卡');
      expect(captured(result.stdout)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('retains ordinary custom progress without host final chrome', () => {
    const { root, run } = setup();
    try {
      const result = run(customCard, 'progress');
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = captured(result.stdout);
      expect(requests).toHaveLength(1);
      expect(requests[0].body.content).not.toContain('Example assistant');
      expect(requests[0].body.content).not.toContain('feedback_submit');
      expect(JSON.parse(requests[0].body.content).header).toEqual(customCard.header);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('supports --no-mention without dropping final chrome', () => {
    const { root, run } = setup();
    try {
      const result = run(customCard, 'final', ['--no-mention']);
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = captured(result.stdout);
      expect(requests).toHaveLength(1);
      expect(requests[0].body.content).not.toContain('<at');
      expect(requests[0].body.content).toContain('Example assistant');
      expect(requests[0].body.content).toContain('feedback_submit');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    { name: 'body markdown', extracted: true, card: { ...customCard, body: { elements: [
      { tag: 'markdown', content: 'For <at id=ou_other></at>' },
    ] } } },
    { name: 'collapsible panel title', extracted: false, card: { ...customCard, body: { elements: [
      { tag: 'collapsible_panel', expanded: true,
        header: { title: { tag: 'markdown', content: 'For <at id=ou_other></at>' } },
        elements: [{ tag: 'markdown', content: 'Add boundary tests.' }] },
    ] } } },
    { name: 'card subtitle', extracted: false, card: { ...customCard, header: { ...customCard.header,
      subtitle: { tag: 'plain_text', content: 'For <at id=ou_other></at>' },
    } } },
  ])('does not swallow native notifications in $name by patching a running card', async ({ card, extracted }) => {
    const { root, dataDir, run } = setup();
    try {
      // Header-only mentions are absent from extracted text: they specifically
      // exercise the whole-card payload gate, not the pre-existing text gate.
      expect(extractCardContent(JSON.stringify(card)).includes('<at')).toBe(extracted);
      const store = new TurnReplyCardStore(dataDir);
      const io = { send: async () => 'om_original_card', patch: async () => {}, beforeEffect: () => {}, isWithdrawn: () => false,
        render: (record: Parameters<typeof buildTurnReplyCard>[0]) => buildTurnReplyCard(record, presentation) };
      await store.prepare(key, { mode: 'unified', chatId: 'oc_test', rootId: 'om_root' });
      await store.update(key, { kind: 'start' }, io);
      const result = run(card);
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = captured(result.stdout);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe('POST');
      expect(requests[0].body.content).toContain('<at id=ou_other>');
      expect(store.read(key)?.messageId).toBe('om_original_card');
      expect(store.read(key)?.finalDelivered).not.toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    { input: 'false', updateMulti: false, reserved: false },
    { input: 'omitted', updateMulti: undefined, reserved: false },
    { input: 'false', updateMulti: false, reserved: true },
    { input: 'omitted', updateMulti: undefined, reserved: true },
  ])('forces update_multi when input is $input and reserved=$reserved', async ({ updateMulti, reserved }) => {
    const { root, dataDir, run } = setup();
    try {
      const store = new TurnReplyCardStore(dataDir);
      const io = { send: async () => 'om_original_card', patch: async () => {}, beforeEffect: () => {}, isWithdrawn: () => false,
        render: (record: Parameters<typeof buildTurnReplyCard>[0]) => buildTurnReplyCard(record, presentation) };
      if (reserved) {
        await store.prepare(key, { mode: 'unified', chatId: 'oc_test', rootId: 'om_root' });
        await store.update(key, { kind: 'start' }, io);
      }
      const result = run({ ...customCard, config: {
        width_mode: 'fill', ...(updateMulti === undefined ? {} : { update_multi: updateMulti }),
      } });
      expect(result.status, String(result.stderr)).toBe(0);
      const requests = captured(result.stdout);
      expect(requests).toHaveLength(1);
      expect(requests[0].method).toBe(reserved ? 'PATCH' : 'POST');
      const deliveredCard = JSON.parse(requests[0].body.content);
      expect(deliveredCard.config).toMatchObject({ width_mode: 'fill', update_multi: true });
      if (reserved) {
        expect(store.read(key)).toMatchObject({ messageId: 'om_original_card', finalDelivered: true });
        // Unified cards reveal feedback only when the turn reaches terminal.
        await store.update(key, { kind: 'terminal', phase: 'completed', durationMs: 1200 }, io);
        expect(JSON.parse(store.read(key)!.lastCard!).config.update_multi).toBe(true);
      }
      expect(reserved ? store.read(key)!.lastCard! : requests[0].body.content).toContain('feedback_submit');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each([
    { name: 'schema 1', card: { elements: [{ tag: 'markdown', content: 'legacy' }] }, args: [],
      error: '自定义 final 卡片必须是 schema 2.0 且包含 body.elements' },
    { name: 'top-level', card: customCard, args: ['--top-level'],
      error: '自定义 final 卡片仅支持当前会话内回复' },
    { name: 'cross-chat', card: customCard, args: ['--chat-id', 'oc_elsewhere'],
      error: '自定义 final 卡片仅支持当前会话内回复' },
    { name: 'into another topic', card: customCard, args: ['--into', 'om_elsewhere'],
      error: '自定义 final 卡片仅支持当前会话内回复' },
  ])('rejects $name at the custom-final boundary when feedback is disabled', ({ card, args, error }) => {
    const { root, run } = setup('codex', false);
    try {
      // With feedback disabled no feedback-specific guard can mask a missing
      // custom-final destination check. Assert its diagnostic as well as no IO.
      const result = run(card, 'final', args);
      expect(result.status, String(result.stderr)).toBe(2);
      expect(String(result.stderr)).toContain(error);
      expect(captured(result.stdout)).toHaveLength(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects nested host IDs but accepts caller layout IDs', () => {
    expect(customFinalCardError(customCard)).toBeUndefined();
    expect(customFinalCardError({ ...customCard, body: { elements: [
      { tag: 'column_set', columns: [{ tag: 'column', elements: [{ tag: 'markdown', element_id: 'botmux_feedback' }] }] },
    ] } })).toContain('botmux_');
  });
});
