/**
 * Canonical shared-message identity across live events and history reads.
 *
 * Proven production defect: a live event resolved `@_user_1` to `@Alex …`
 * while the later history read of the SAME platform version dropped the
 * placeholder, so the store minted a second revision (seq 890 → 891) and the
 * next turn re-supplied the message as new. Only a representation difference
 * explained by structured mention evidence (same mention identities, same
 * platform version) collapses; any other change in body, whitespace, target,
 * attachments or version is a real revision.
 *
 * Run: bun x vitest run --project unit test/group-context-canonical-revision.test.ts
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  upsertGroupContextMessage, getGroupContextMessage, listGroupContextMessages, markGroupContextMessageDeleted,
  _resetGroupContextStoreForTest, type GroupContextMessageInput,
} from '../src/services/group-context-store.js';
import {
  groupContextRepresentationsMatch, groupContextMentionIdentities, sameGroupContextMentions, sameGroupContextPlatformVersion,
} from '../src/services/group-context-content.js';
import { setGroupContextSettingsResolver, ingestGroupContextEvent, _resetGroupContextIngestForTest } from '../src/services/group-context-ingest.js';
import { captureNativeGroupContextInput, observePublishedGroupMessage } from '../src/services/group-context-runtime.js';
import { setGroupContextSettings } from '../src/services/group-context-settings-store.js';

const APP = 'cli_app';
const CHAT = 'oc_room';
const CREATE = 1_791_240_348_974;
const ALEX = { key: '@_user_1', name: 'Alex', openId: 'ou_alex' };
let dataDir: string;

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-group-ctx-canonical-'));
  vi.stubEnv('SESSION_DATA_DIR', dataDir);
  _resetGroupContextStoreForTest();
  _resetGroupContextIngestForTest();
  setGroupContextSettingsResolver(() => ({ enabled: true }));
  // History observation reads the persisted settings, not the ingest resolver.
  await setGroupContextSettings(CHAT, { enabled: true }, dataDir);
});
afterEach(() => {
  _resetGroupContextStoreForTest();
  _resetGroupContextIngestForTest();
  vi.unstubAllEnvs();
  rmSync(dataDir, { recursive: true, force: true });
});

function row(over: Partial<GroupContextMessageInput> = {}): GroupContextMessageInput {
  return {
    messageId: 'om_scope', chatId: CHAT, senderId: 'ou_user', senderType: 'user', msgType: 'text',
    text: '@Alex 感觉这个上下文自动补充的范围有点问题', mentions: [ALEX], rawText: '@_user_1 感觉这个上下文自动补充的范围有点问题',
    createTime: CREATE, updateTime: CREATE, resourceRefs: [], sourceAppId: APP,
    ...over,
  };
}

function event(messageId: string, text: string, mention?: { name: string; openId: string }, updateTime: number | undefined = CREATE) {
  return {
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: messageId, chat_id: CHAT, chat_type: 'group', message_type: 'text',
      content: JSON.stringify({ text }),
      ...(mention ? { mentions: [{ key: '@_user_1', name: mention.name, id: { open_id: mention.openId }, id_type: 'open_id' }] } : {}),
      create_time: String(CREATE), ...(updateTime !== undefined ? { update_time: String(updateTime) } : {}),
    },
  };
}

function historyMessage(messageId: string, text: string, opts: { mentions?: Array<{ name: string; openId: string }>; updateTime?: number } = {}) {
  return historyMessageWith(messageId, text, opts);
}

function historyMessageWith(messageId: string, text: string, opts: { mentions?: Array<{ name: string; openId?: string; unionId?: string }>; updateTime?: number } = {}) {
  return {
    message_id: messageId, chat_id: CHAT, msg_type: 'text', create_time: String(CREATE),
    ...(opts.updateTime !== undefined ? { update_time: String(opts.updateTime) } : {}),
    sender: { id: 'ou_user', sender_type: 'user' }, body: { content: JSON.stringify({ text }) },
    ...(opts.mentions ? { mentions: opts.mentions.map((m, i) => ({ key: `@_user_${i + 1}`, name: m.name,
      ...(m.openId ? { id: m.openId, id_type: 'open_id' } : { id: m.unionId, id_type: 'union_id' }) })) } : {}),
  };
}

describe('structured mention equivalence', () => {
  const alice = { key: '@_user_1', name: 'Alice', openId: 'ou_alice' };
  const bobby = { key: '@_user_2', name: 'Bobby', openId: 'ou_bobby' };

  it('binds placeholders to identities in body order', () => {
    expect(groupContextMentionIdentities([alice, bobby], '@_user_1 pay @_user_2')).toEqual(['open:ou_alice', 'open:ou_bobby']);
    expect(groupContextMentionIdentities([{ ...alice, key: '@_user_2' }, { ...bobby, key: '@_user_1' }], '@_user_1 pay @_user_2')).toEqual(['open:ou_bobby', 'open:ou_alice']);
    // A repeated placeholder is a repeated binding; an unused entry is still asserted.
    expect(groupContextMentionIdentities([alice, bobby], '@_user_1 and @_user_1')).toEqual(['open:ou_alice', 'open:ou_alice', 'open:ou_bobby']);
    // Without a raw body only the identity set is known.
    expect(groupContextMentionIdentities([bobby, alice])).toEqual(['open:ou_alice', 'open:ou_bobby']);
    expect(sameGroupContextMentions([alice, bobby], [{ ...alice, key: '@_user_2' }, { ...bobby, key: '@_user_1' }], '@_user_1 pay @_user_2', '@_user_1 pay @_user_2')).toBe(false);
    expect(sameGroupContextMentions([alice], [{ key: '@_user_2', name: 'Alice', openId: 'ou_alice' }])).toBe(true);
  });

  it('matches on the raw body and compatible identities, never on name stripping', () => {
    const raw = '@_user_1 感觉有点问题';
    expect(groupContextRepresentationsMatch({ text: '@Alex 感觉有点问题', rawText: raw, mentions: [ALEX] }, { text: '感觉有点问题', rawText: raw })).toBe(true);
    expect(groupContextRepresentationsMatch({ text: '感觉有点问题', rawText: raw }, { text: '@Alex 感觉有点问题', rawText: raw, mentions: [ALEX] })).toBe(true);
    // Same identity, different display name: same body.
    expect(groupContextRepresentationsMatch({ text: '@Alice approve', rawText: '@_user_1 approve', mentions: [alice] }, { text: '@Alice Example approve', rawText: '@_user_1 approve', mentions: [{ ...alice, name: 'Alice Example' }] })).toBe(true);
    // Different or swapped targets never merge.
    expect(groupContextRepresentationsMatch({ text: '@Alice approve', rawText: '@_user_1 approve', mentions: [alice] }, { text: '@Bobby approve', rawText: '@_user_1 approve', mentions: [{ ...bobby, key: '@_user_1' }] })).toBe(false);
    expect(groupContextRepresentationsMatch({ text: '@Alice pay @Bobby', rawText: '@_user_1 pay @_user_2', mentions: [alice, bobby] }, { text: '@Bobby pay @Alice', rawText: '@_user_1 pay @_user_2', mentions: [{ ...bobby, key: '@_user_1' }, { ...alice, key: '@_user_2' }] })).toBe(false);
    // Literal prose is part of the body; an identical display text with a different raw body is a change.
    expect(groupContextRepresentationsMatch({ text: '@Alex approve', rawText: '@_user_1 approve', mentions: [ALEX] }, { text: '@Alex approve', rawText: '@Alex approve' })).toBe(false);
    // Legacy rows without a raw body match only byte-identical display text.
    expect(groupContextRepresentationsMatch({ text: '@Alex 感觉有点问题', mentions: [ALEX] }, { text: '感觉有点问题', rawText: raw })).toBe(false);
    expect(groupContextRepresentationsMatch({ text: '@Alex 感觉有点问题', mentions: [ALEX] }, { text: '@Alex 感觉有点问题', rawText: raw, mentions: [ALEX] })).toBe(true);
    expect(groupContextRepresentationsMatch({ text: 'install @scope/old' }, { text: 'install @scope/new' })).toBe(false);
    expect(groupContextRepresentationsMatch({ text: 'mail a@one.test' }, { text: 'mail a@two.test' })).toBe(false);
  });

  it('accepts a platform version only when proven equal or proven unedited', () => {
    expect(sameGroupContextPlatformVersion(CREATE, CREATE, CREATE)).toBe(true);
    expect(sameGroupContextPlatformVersion(CREATE, undefined, CREATE)).toBe(true);
    expect(sameGroupContextPlatformVersion(CREATE, CREATE, undefined)).toBe(true);
    expect(sameGroupContextPlatformVersion(CREATE, undefined, CREATE + 1)).toBe(false);
    expect(sameGroupContextPlatformVersion(CREATE, undefined, undefined)).toBe(false);
    expect(sameGroupContextPlatformVersion(CREATE, CREATE, CREATE + 5_000)).toBe(false);
  });
});

describe('store: live event vs history read of the same platform version', () => {
  it('does not mint a revision and keeps the mention-bearing body', () => {
    const live = upsertGroupContextMessage(APP, row());
    const history = upsertGroupContextMessage(APP, row({ text: '感觉这个上下文自动补充的范围有点问题', mentions: undefined, senderName: 'Participant' }));
    expect(history).toEqual({ seq: live.seq, revision: 0, inserted: false });
    const stored = getGroupContextMessage(APP, CHAT, 'om_scope')!;
    expect(stored.text).toBe('@Alex 感觉这个上下文自动补充的范围有点问题');
    expect(stored.mentions).toEqual([ALEX]);
    expect(stored.senderName).toBe('Participant');
    expect(listGroupContextMessages(APP, CHAT, { afterSeq: 0, throughSeq: 10, limit: 10 }).messages).toHaveLength(1);
  });

  it('upgrades a history-first body to the live representation in place', () => {
    const history = upsertGroupContextMessage(APP, row({ text: '感觉这个上下文自动补充的范围有点问题', mentions: undefined }));
    const live = upsertGroupContextMessage(APP, row());
    expect(live).toEqual({ seq: history.seq, revision: 0, inserted: false });
    const stored = getGroupContextMessage(APP, CHAT, 'om_scope')!;
    expect(stored.text).toBe('@Alex 感觉这个上下文自动补充的范围有点问题');
    expect(stored.mentions).toEqual([ALEX]);
    // The same live event again is an ordinary duplicate.
    expect(upsertGroupContextMessage(APP, row()).inserted).toBe(false);
  });

  it('records every real change as a revision', () => {
    const first = upsertGroupContextMessage(APP, row());
    // Genuine edit (new platform version, changed body).
    expect(upsertGroupContextMessage(APP, row({ text: '@Alex 感觉这个上下文自动补充的范围有点问题！', rawText: '@_user_1 感觉这个上下文自动补充的范围有点问题！', updateTime: CREATE + 5_000 })).inserted).toBe(true);
    // Attachment change.
    expect(upsertGroupContextMessage(APP, row({ updateTime: CREATE + 5_000, resourceRefs: [{ type: 'image', key: 'img_1' }] })).inserted).toBe(true);
    // A different message with the stripped body is its own record.
    expect(upsertGroupContextMessage(APP, row({ messageId: 'om_other', text: '感觉这个上下文自动补充的范围有点问题', mentions: undefined })).inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_scope')!.seq).toBeGreaterThan(first.seq);
    expect(markGroupContextMessageDeleted(APP, CHAT, 'om_scope', { deletedAt: CREATE + 9_000, sourceAppId: APP }).inserted).toBe(true);
    expect(getGroupContextMessage(APP, CHAT, 'om_scope')!.deleted).toBe(true);
  });

  it('never collapses plain-text differences, changed targets or unknown versions', () => {
    const cases: Array<[string, Partial<GroupContextMessageInput>, Partial<GroupContextMessageInput>]> = [
      ['literal', { text: 'install @scope/old', rawText: 'install @scope/old', mentions: undefined }, { text: 'install @scope/new', rawText: 'install @scope/new', mentions: undefined }],
      ['target', { text: '@Alice approve', rawText: '@_user_1 approve', mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }] }, { text: '@Bobby approve', rawText: '@_user_1 approve', mentions: [{ key: '@_user_1', name: 'Bobby', openId: 'ou_bobby' }] }],
      ['swap', { text: '@Alice pay @Bobby', rawText: '@_user_1 pay @_user_2', mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }, { key: '@_user_2', name: 'Bobby', openId: 'ou_bobby' }] }, { text: '@Bobby pay @Alice', rawText: '@_user_1 pay @_user_2', mentions: [{ key: '@_user_1', name: 'Bobby', openId: 'ou_bobby' }, { key: '@_user_2', name: 'Alice', openId: 'ou_alice' }] }],
      ['target_without_evidence', { text: '@Alice approve', rawText: '@Alice approve', mentions: undefined }, { text: '@Bobby approve', rawText: '@Bobby approve', mentions: undefined }],
      ['code', { text: '```py\n@cached\ndef f(): pass\n```', rawText: undefined, mentions: undefined }, { text: '```py\n@logged\ndef f(): pass\n```', rawText: undefined, mentions: undefined }],
      ['indent', { text: 'if a:\n    if b:\n        go()', rawText: undefined, mentions: undefined }, { text: 'if a:\n    if b:\n    go()', rawText: undefined, mentions: undefined }],
      ['missing_version', { text: '@Alice approve', rawText: '@_user_1 approve', mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }], updateTime: undefined }, { text: 'approve', rawText: '@_user_1 approve', mentions: undefined, updateTime: undefined }],
      ['true_new_version', { text: '@Alice approve', rawText: '@_user_1 approve', mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }] }, { text: 'approve', rawText: '@_user_1 approve', mentions: undefined, updateTime: CREATE + 1 }],
    ];
    for (const [id, left, right] of cases) {
      upsertGroupContextMessage(APP, row({ messageId: `om_${id}`, rawText: undefined, ...left }));
      expect(upsertGroupContextMessage(APP, row({ messageId: `om_${id}`, rawText: undefined, ...right })).inserted, id).toBe(true);
    }
  });
});

describe('ingest and history read of one message', () => {
  it.each([
    ['Alice Example', '@_user_1 approve', '@Alice Example approve'],
    ['Alice', 'hello@_user_1 approve', 'hello@Alice approve'],
  ])('keeps one revision for mention %s with raw %j', (name, raw, resolved) => {
    const mention = { name, openId: `ou_${name.replace(/\s+/g, '_')}` };
    expect(ingestGroupContextEvent(APP, event('om_m', raw, mention))).toBe('stored');
    // A history read without structured mentions drops the placeholder.
    observePublishedGroupMessage(APP, historyMessage('om_m', raw, { updateTime: CREATE }));
    // A history read with structured mentions renders the same body as the event.
    observePublishedGroupMessage(APP, historyMessage('om_m', raw, { mentions: [mention], updateTime: CREATE }));
    const stored = getGroupContextMessage(APP, CHAT, 'om_m')!;
    expect(stored.revision).toBe(0);
    expect(stored.text).toBe(resolved);
    expect(stored.mentions?.map(m => m.name)).toEqual([name]);
  });

  it('treats a receive event without update_time and a history read with update_time == create_time as one version', () => {
    expect(ingestGroupContextEvent(APP, event('om_nu', '@_user_1 approve', { name: 'Alice', openId: 'ou_alice' }, undefined))).toBe('stored');
    observePublishedGroupMessage(APP, historyMessage('om_nu', '@_user_1 approve', { updateTime: CREATE }));
    const stored = getGroupContextMessage(APP, CHAT, 'om_nu')!;
    expect(stored.revision).toBe(0);
    expect(stored.text).toBe('@Alice approve');
    // A later edit is still a revision.
    observePublishedGroupMessage(APP, historyMessage('om_nu', '@_user_1 approve!', { mentions: [{ name: 'Alice', openId: 'ou_alice' }], updateTime: CREATE + 2_000 }));
    expect(getGroupContextMessage(APP, CHAT, 'om_nu')!.revision).toBe(1);
  });

  it('captures the live input seq when history stored the stripped body first, and never a different target', () => {
    upsertGroupContextMessage(APP, row({ text: '感觉这个上下文自动补充的范围有点问题', mentions: undefined }));
    const live = event('om_scope', '@_user_1 感觉这个上下文自动补充的范围有点问题', { name: 'Alex', openId: 'ou_alex' });
    expect(ingestGroupContextEvent(APP, live)).toBe('duplicate');
    const stored = getGroupContextMessage(APP, CHAT, 'om_scope')!;
    expect(captureNativeGroupContextInput(APP, live)).toEqual([stored.seq]);
    expect(listGroupContextMessages(APP, CHAT, { afterSeq: 0, throughSeq: 10, limit: 10 }).messages).toHaveLength(1);
    upsertGroupContextMessage(APP, row({ messageId: 'om_wrong', text: '@Bobby approve', rawText: '@_user_1 approve', mentions: [{ key: '@_user_1', name: 'Bobby', openId: 'ou_bobby' }] }));
    expect(captureNativeGroupContextInput(APP, event('om_wrong', '@_user_1 approve', { name: 'Alice', openId: 'ou_alice' }))).toEqual([]);
    upsertGroupContextMessage(APP, row({ messageId: 'om_plain', text: '@Bobby approve', rawText: '@Bobby approve', mentions: undefined }));
    expect(captureNativeGroupContextInput(APP, event('om_plain', '@_user_1 approve', { name: 'Alice', openId: 'ou_alice' }))).toEqual([]);
  });
});

describe('mention identity through the real ingest/history chain', () => {
  // `null` = the platform sent no update_time (a default parameter cannot express that).
  const event2 = (messageId: string, text: string, mention: { name: string; openId?: string; unionId?: string }, updateTime: number | null = CREATE) => ({
    sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
    message: {
      message_id: messageId, chat_id: CHAT, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text }),
      mentions: [{ key: '@_user_1', name: mention.name, id: { ...(mention.openId ? { open_id: mention.openId } : {}), ...(mention.unionId ? { union_id: mention.unionId } : {}) } }],
      create_time: String(CREATE), ...(updateTime !== null ? { update_time: String(updateTime) } : {}),
    },
  });

  it.each([
    ['same platform version', CREATE],
    ['a newer platform version', CREATE + 1_000],
    ['an unknown platform version', null],
  ])('keeps a changed target under the same display name as a revision (%s)', (_label, second) => {
    ingestGroupContextEvent(APP, event2('om_t', '@_user_1 approve', { name: 'Alex', openId: 'ou_first' }));
    expect(ingestGroupContextEvent(APP, event2('om_t', '@_user_1 approve', { name: 'Alex', openId: 'ou_second' }, second))).toBe('stored');
    const stored = getGroupContextMessage(APP, CHAT, 'om_t')!;
    expect(stored.revision).toBe(1);
    expect(stored.mentions?.[0].openId).toBe('ou_second');
    expect(stored.rawText).toBe('@_user_1 approve');
  });

  it('keeps one revision when only the display name of the same identity changes', () => {
    ingestGroupContextEvent(APP, event2('om_r', '@_user_1 approve', { name: 'Alice', openId: 'ou_same' }));
    observePublishedGroupMessage(APP, historyMessage('om_r', '@_user_1 approve', { mentions: [{ name: 'Alice Example', openId: 'ou_same' }], updateTime: CREATE }));
    const stored = getGroupContextMessage(APP, CHAT, 'om_r')!;
    expect(stored.revision).toBe(0);
    expect(stored.text).toBe('@Alice Example approve');
  });

  it('keeps a literal @Name in the prose: a mention-less history read is the same version, a real deletion is not', () => {
    ingestGroupContextEvent(APP, event2('om_l', '@_user_1 literal @Alice approve', { name: 'Alice', openId: 'ou_alice' }));
    observePublishedGroupMessage(APP, historyMessage('om_l', '@_user_1 literal @Alice approve', { updateTime: CREATE }));
    let stored = getGroupContextMessage(APP, CHAT, 'om_l')!;
    expect(stored.revision).toBe(0);
    expect(stored.text).toBe('@Alice literal @Alice approve');
    observePublishedGroupMessage(APP, historyMessage('om_l', 'literal approve', { updateTime: CREATE }));
    stored = getGroupContextMessage(APP, CHAT, 'om_l')!;
    expect(stored.revision).toBe(1);
    expect(stored.text).toBe('literal approve');
    expect(stored.mentions).toBeUndefined();
  });

  it('does not attach stale mention identities to a later literal observation of the same display text', () => {
    ingestGroupContextEvent(APP, event2('om_s', '@_user_1 approve', { name: 'Alex', openId: 'ou_alex' }));
    // The same display text, now literal (no placeholder, no mentions): a different body.
    observePublishedGroupMessage(APP, historyMessage('om_s', '@Alex approve', { updateTime: CREATE + 1_000 }));
    const stored = getGroupContextMessage(APP, CHAT, 'om_s')!;
    expect(stored.revision).toBe(1);
    expect(stored.mentions).toBeUndefined();
    expect(stored.rawText).toBe('@Alex approve');
  });

  it('carries union_id identities and never confirms a different target', () => {
    const live = event2('om_u', '@_user_1 approve', { name: 'Alex', unionId: 'on_first' });
    ingestGroupContextEvent(APP, live);
    expect(getGroupContextMessage(APP, CHAT, 'om_u')!.mentions).toEqual([{ key: '@_user_1', name: 'Alex', unionId: 'on_first' }]);
    expect(captureNativeGroupContextInput(APP, event2('om_u', '@_user_1 approve', { name: 'Alex', unionId: 'on_second' }))).toEqual([]);
    expect(captureNativeGroupContextInput(APP, live)).toEqual([getGroupContextMessage(APP, CHAT, 'om_u')!.seq]);
  });

  it.each([
    ['same platform version', CREATE],
    ['a newer platform version', CREATE + 1_000],
    ['an unknown platform version', null],
  ])('treats swapped targets with an unchanged identity set as a revision (%s)', (_label, second) => {
    const pair = (swap: boolean, updateTime: number | null) => ({
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: 'om_swap', chat_id: CHAT, chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@_user_1 pay @_user_2' }),
        mentions: [
          { key: '@_user_1', name: swap ? 'Bob' : 'Alice', id: { open_id: swap ? 'ou_bob' : 'ou_alice' } },
          { key: '@_user_2', name: swap ? 'Alice' : 'Bob', id: { open_id: swap ? 'ou_alice' : 'ou_bob' } },
        ],
        create_time: String(CREATE), ...(updateTime !== null ? { update_time: String(updateTime) } : {}),
      },
    });
    const first = pair(false, second === null ? null : CREATE);
    ingestGroupContextEvent(APP, first);
    expect(ingestGroupContextEvent(APP, pair(true, second))).toBe('stored');
    const stored = getGroupContextMessage(APP, CHAT, 'om_swap')!;
    expect(stored.revision).toBe(1);
    expect(stored.mentions?.map(m => m.openId)).toEqual(['ou_bob', 'ou_alice']);
    // The old order no longer describes the stored message.
    expect(captureNativeGroupContextInput(APP, first)).toEqual([]);
  });

  it('reads a text body by its message type even when the prose looks like the internal post form', () => {
    const raw = '{"post":{"author":"@_user_1","reviewer":"@_user_2"}}';
    const ev = (messageId: string, swap: boolean, updateTime: number) => ({
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: messageId, chat_id: CHAT, chat_type: 'group', message_type: 'text', create_time: String(CREATE), update_time: String(updateTime),
        content: JSON.stringify({ text: raw }),
        mentions: [
          { key: '@_user_1', name: swap ? 'Bob' : 'Alice', id: { open_id: swap ? 'ou_bob' : 'ou_alice' } },
          { key: '@_user_2', name: swap ? 'Alice' : 'Bob', id: { open_id: swap ? 'ou_alice' : 'ou_bob' } },
        ],
      },
    });
    for (const [messageId, version] of [['om_json_same', CREATE], ['om_json_newer', CREATE + 1_000]] as const) {
      const first = ev(messageId, false, CREATE);
      ingestGroupContextEvent(APP, first);
      expect(ingestGroupContextEvent(APP, ev(messageId, true, version))).toBe('stored');
      const stored = getGroupContextMessage(APP, CHAT, messageId)!;
      expect(stored.revision).toBe(1);
      expect(stored.rawText).toBe(raw);
      expect(stored.mentions?.map(m => m.openId)).toEqual(['ou_bob', 'ou_alice']);
      expect(captureNativeGroupContextInput(APP, first)).toEqual([]);
    }
    // The identity order is positional for text regardless of what the prose contains.
    expect(groupContextMentionIdentities([{ key: '@_user_2', name: 'B', openId: 'ou_b' }, { key: '@_user_1', name: 'A', openId: 'ou_a' }], raw, 'text')).toEqual(['open:ou_a', 'open:ou_b']);
  });

  it('derives mention identities from post inline at-nodes without a top-level mentions list', () => {
    const post = (messageId: string, target: string, name: string, updateTime: number) => ({
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: messageId, chat_id: CHAT, chat_type: 'group', message_type: 'post', create_time: String(CREATE), update_time: String(updateTime),
        content: JSON.stringify({ zh_cn: { title: '', content: [[{ tag: 'at', user_id: target, user_name: name }, { tag: 'text', text: ' approve' }]] } }),
      },
    });
    for (const [id, version] of [['om_post_same', CREATE], ['om_post_newer', CREATE + 1_000]] as const) {
      ingestGroupContextEvent(APP, post(id, 'ou_first', 'Alex', CREATE));
      expect(ingestGroupContextEvent(APP, post(id, 'ou_second', 'Alex', version))).toBe('stored');
      const stored = getGroupContextMessage(APP, CHAT, id)!;
      expect(stored.revision).toBe(1);
      expect(stored.rawText).toBe('{"post":{"title":"","content":[[{"at":"ou_second"},{"t":" approve"}]]}}');
      expect(stored.mentions).toEqual([{ key: '@_at:ou_second', name: 'Alex', openId: 'ou_second' }]);
      expect(captureNativeGroupContextInput(APP, post(id, 'ou_third', 'Alex', version))).toEqual([]);
      expect(captureNativeGroupContextInput(APP, post(id, 'ou_second', 'Alex', version))).toEqual([stored.seq]);
    }
    ingestGroupContextEvent(APP, post('om_post_rename', 'ou_same', 'Alex', CREATE));
    expect(ingestGroupContextEvent(APP, post('om_post_rename', 'ou_same', 'Alex Example', CREATE))).toBe('duplicate');
    expect(getGroupContextMessage(APP, CHAT, 'om_post_rename')).toMatchObject({ revision: 0, text: '@Alex Example approve' });
  });

  it('derives post identities from the content nodes on both paths, with a top-level list only enriching them', () => {
    const at = (id: string, name: string) => ({ tag: 'at', user_id: id, user_name: name });
    const txt = (text: string) => ({ tag: 'text', text });
    const postEvent = (messageId: string, nodes: unknown[], mentions?: unknown[], updateTime = CREATE) => ({
      sender: { sender_id: { open_id: 'ou_user' }, sender_type: 'user' },
      message: {
        message_id: messageId, chat_id: CHAT, chat_type: 'group', message_type: 'post', create_time: String(CREATE), update_time: String(updateTime),
        content: JSON.stringify({ zh_cn: { title: '', content: [nodes] } }), ...(mentions ? { mentions } : {}),
      },
    });
    const history = (e: ReturnType<typeof postEvent>) => ({
      message_id: e.message.message_id, chat_id: CHAT, msg_type: 'post', create_time: String(CREATE), update_time: String(CREATE),
      sender: { id: 'ou_user', sender_type: 'user' }, body: { content: e.message.content },
    });
    // Event with a top-level `@_user_N` list vs history without one: one version.
    const e = postEvent('om_p', [at('ou_zed', 'Zed'), txt(' ask '), at('ou_amy', 'Amy')],
      [{ key: '@_user_1', name: 'Zed', id: { open_id: 'ou_zed' } }, { key: '@_user_2', name: 'Amy', id: { open_id: 'ou_amy' } }]);
    ingestGroupContextEvent(APP, e);
    observePublishedGroupMessage(APP, history(e));
    const stored = getGroupContextMessage(APP, CHAT, 'om_p')!;
    expect(stored.revision).toBe(0);
    expect(stored.mentions?.map(m => m.key)).toEqual(['@_at:ou_zed', '@_at:ou_amy']);
    expect(captureNativeGroupContextInput(APP, e)).toEqual([stored.seq]);
    // A bot target typed app_id in the list; the node id stays the identity on both paths.
    const b = postEvent('om_b', [at('cli_peer', 'Peer'), txt(' approve')], [{ key: '@_user_1', name: 'Peer', id: 'cli_peer', id_type: 'app_id' }]);
    ingestGroupContextEvent(APP, b);
    observePublishedGroupMessage(APP, history(b));
    expect(getGroupContextMessage(APP, CHAT, 'om_b')).toMatchObject({ revision: 0, mentions: [{ key: '@_at:cli_peer', name: 'Peer', appId: 'cli_peer' }] });
    // Literal text that looks like a marker never collides with a real at-node: moving it is an edit.
    const left = postEvent('om_c', [txt('@_at:ou_alice pay '), at('ou_alice', 'Alice')]);
    const right = postEvent('om_c', [at('ou_alice', 'Alice'), txt(' pay @_at:ou_alice')], undefined, CREATE + 1_000);
    ingestGroupContextEvent(APP, left);
    expect(ingestGroupContextEvent(APP, right)).toBe('stored');
    expect(getGroupContextMessage(APP, CHAT, 'om_c')?.revision).toBe(1);
    expect(captureNativeGroupContextInput(APP, left)).toEqual([]);
  });

  it('treats a row recorded without a raw body conservatively: one extra revision, never a lossy merge', () => {
    // A row as the previous release stored it: display text with mentions, no raw body.
    upsertGroupContextMessage(APP, row({ messageId: 'om_legacy', text: '@Alice literal @Alice approve', rawText: undefined, mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }] }));
    // A genuine edit observed through history: must become a consistent new revision.
    observePublishedGroupMessage(APP, historyMessage('om_legacy', 'literal approve', { updateTime: CREATE }));
    const edited = getGroupContextMessage(APP, CHAT, 'om_legacy')!;
    expect(edited).toMatchObject({ revision: 1, text: 'literal approve', rawText: 'literal approve' });
    expect(edited.mentions).toBeUndefined();
    // An identical display text with evidence upgrades the legacy row in place.
    upsertGroupContextMessage(APP, row({ messageId: 'om_legacy2', text: '@Alice approve', rawText: undefined, mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }] }));
    expect(upsertGroupContextMessage(APP, row({ messageId: 'om_legacy2', text: '@Alice approve', rawText: '@_user_1 approve', mentions: [{ key: '@_user_1', name: 'Alice', openId: 'ou_alice' }] })).inserted).toBe(false);
    expect(getGroupContextMessage(APP, CHAT, 'om_legacy2')).toMatchObject({ revision: 0, rawText: '@_user_1 approve' });
  });

  it('binds an input under two unknown versions only when the representation is byte-identical', () => {
    const live = event2('om_k', '@_user_1 approve', { name: 'Alice', openId: 'ou_alice' }, null);
    ingestGroupContextEvent(APP, live);
    const stored = getGroupContextMessage(APP, CHAT, 'om_k')!;
    expect(stored.updateTime).toBeUndefined();
    expect(captureNativeGroupContextInput(APP, live)).toEqual([stored.seq]);
    const stripped = { ...live, message: { ...live.message, content: JSON.stringify({ text: 'approve' }), mentions: [] } };
    expect(captureNativeGroupContextInput(APP, stripped)).toEqual([]);
  });
});
