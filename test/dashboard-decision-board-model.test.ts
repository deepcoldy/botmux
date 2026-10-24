/**
 * 决策看板页面的纯逻辑：路由、草稿比较与「管家改过」提示、提交确认框的条目与请求体、
 * 批次状态、管家配置的保存载荷（与服务端校验同口径）。
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_ACTOR_LABEL_KEYS,
  BOARD_EMPTY_VIEW_KEYS,
  BOARD_EVENT_KIND_KEYS,
  BOARD_FILES_PER_DRAFT,
  BOARD_IMAGE_MAX_BYTES,
  BOARD_STATE_LABEL_KEYS,
  BOARD_VIEW_LABEL_KEYS,
  batchView,
  boardErrorText,
  boardItemHash,
  boardRelativeTime,
  boardSummaryHash,
  checkBoardImages,
  draftNeedsReview,
  isDraftEmpty,
  orderSubmitCandidates,
  parseBoardHash,
  questionOneLine,
  sameDraftContent,
  stateChipText,
  stewardErrorText,
  stewardFormFrom,
  stewardGuideProblem,
  stewardPayload,
  submitCandidateFromDetail,
  submitPayloadItems,
  submitScope,
  type BoardBatch,
  type BoardItem,
  type StewardForm,
} from '../src/dashboard/web/decision-board-model.js';
import { BOARD_STATES, BOARD_VIEWS, normalizeStewardConfig } from '../src/core/decision-board/model.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { findDashboardRoute } from '../src/dashboard/web/dashboard-routes.js';

const zh = createDashboardTranslator('zh');
const en = createDashboardTranslator('en');

function item(patch: Partial<BoardItem> = {}): BoardItem {
  return {
    seq: 31, title: '同机 bot 授信方式', state: 'decide', options: [
      { key: 'A', label: '恢复', effect: '默认开' },
      { key: 'B', label: '只信同 owner' },
    ],
    recommend: 'A', rev: 3, createdAt: 1, updatedAt: 2, stateAt: 2, ...patch,
  };
}

describe('decision board routes', () => {
  it('parses summary, per-board and detail hashes, and rejects other pages', () => {
    expect(parseBoardHash('#/board')).toEqual({});
    expect(parseBoardHash('#/board?bot=cli_a&view=active&q=%20pr%20')).toEqual({ appId: 'cli_a', view: 'active', q: 'pr' });
    expect(parseBoardHash('#/board/cli_a')).toEqual({ appId: 'cli_a' });
    expect(parseBoardHash('#/board/cli_a/12')).toEqual({ appId: 'cli_a', seq: 12 });
    expect(parseBoardHash('#/board?view=bogus')).toEqual({});
    expect(parseBoardHash('#/bot-defaults')).toBeNull();
    expect(parseBoardHash('#/boards')).toBeNull();
  });

  it('round-trips the hashes it builds', () => {
    expect(parseBoardHash(boardItemHash('cli_a', 7))).toEqual({ appId: 'cli_a', seq: 7 });
    const summary = boardSummaryHash({ appId: 'cli_a', view: 'all', q: 'botmux' });
    expect(parseBoardHash(summary)).toEqual({ appId: 'cli_a', view: 'all', q: 'botmux' });
    // 默认视图不写进地址。
    expect(boardSummaryHash({ appId: 'cli_a', view: 'decide' })).toBe('#/board?bot=cli_a');
  });

  it('every board address mounts the board page, without swallowing the Bot config page', () => {
    for (const hash of ['#/board', '#/board?bot=cli_a', '#/board/cli_a', boardItemHash('cli_a', 3)]) {
      expect(findDashboardRoute(hash)?.id, hash).toBe('decision-board');
    }
    expect(findDashboardRoute('#/bot-defaults?bot=cli_a')?.id).toBe('bot-defaults');
  });
});

describe('labels', () => {
  it('has a label in both languages for every state, view, actor and event kind the server can send', () => {
    for (const state of BOARD_STATES) {
      expect(zh(BOARD_STATE_LABEL_KEYS[state]), state).not.toBe(BOARD_STATE_LABEL_KEYS[state]);
      expect(en(BOARD_STATE_LABEL_KEYS[state]), state).not.toBe(BOARD_STATE_LABEL_KEYS[state]);
    }
    for (const view of BOARD_VIEWS) {
      for (const key of [BOARD_VIEW_LABEL_KEYS[view], BOARD_EMPTY_VIEW_KEYS[view]]) {
        expect(zh(key), key).not.toBe(key);
        expect(en(key), key).not.toBe(key);
      }
    }
    for (const key of [...Object.values(BOARD_ACTOR_LABEL_KEYS), ...Object.values(BOARD_EVENT_KIND_KEYS)]) {
      expect(zh(key), key).not.toBe(key);
      expect(en(key), key).not.toBe(key);
    }
  });

  it('shows the free-text stage next to the state, and only the state when there is none', () => {
    expect(stateChipText('decide', '在审', zh)).toBe(`${zh(BOARD_STATE_LABEL_KEYS.decide)}·在审`);
    expect(stateChipText('done', '  ', zh)).toBe(zh(BOARD_STATE_LABEL_KEYS.done));
  });

  it('turns a markdown question into a one-line preview', () => {
    expect(questionOneLine('\n## 恢复 **同机** bot 的 `operate` 权限吗？\n\n- 细节')).toBe('恢复 同机 bot 的 operate 权限吗？');
    expect(questionOneLine('看 [PR](https://example.com/1) 再定')).toBe('看 PR 再定');
    expect(questionOneLine('x'.repeat(200)).length).toBeLessThanOrEqual(80);
  });

  it('renders relative times through the translator', () => {
    const now = 10 * 86_400_000;
    expect(boardRelativeTime(now - 5_000, now, zh)).toBe(zh('decisionBoard.timeJustNow'));
    expect(boardRelativeTime(now - 5 * 60_000, now, zh)).toBe(zh('decisionBoard.timeMinutes', { n: 5 }));
    expect(boardRelativeTime(now - 3 * 3_600_000, now, en)).toBe(en('decisionBoard.timeHours', { n: 3 }));
    expect(boardRelativeTime(now - 30 * 3_600_000, now, zh)).toBe(zh('decisionBoard.timeYesterday'));
    expect(boardRelativeTime(now - 4 * 86_400_000, now, zh)).toBe(zh('decisionBoard.timeDays', { n: 4 }));
  });
});

describe('drafts', () => {
  it('treats a draft with no choice, blank text and no images as empty (the server deletes it)', () => {
    expect(isDraftEmpty({ text: ' \n ', fileIds: [] })).toBe(true);
    expect(isDraftEmpty({ choice: 'A', text: '', fileIds: [] })).toBe(false);
    expect(isDraftEmpty({ text: '', fileIds: ['f1'] })).toBe(false);
  });

  it('compares draft content the way the server stores it', () => {
    expect(sameDraftContent({ text: 'a\r\nb', fileIds: [] }, { text: 'a\nb', fileIds: [] })).toBe(true);
    expect(sameDraftContent({ text: '  ', fileIds: [] }, { text: '', fileIds: [] })).toBe(true);
    expect(sameDraftContent({ choice: 'A', text: 'x', fileIds: [] }, { choice: 'B', text: 'x', fileIds: [] })).toBe(false);
    expect(sameDraftContent({ text: 'x', fileIds: ['a', 'b'] }, { text: 'x', fileIds: ['b', 'a'] })).toBe(false);
  });

  it('warns only when the steward changed the item after the draft was written', () => {
    expect(draftNeedsReview({ baseRev: 2 }, { rev: 3 })).toBe(true);
    expect(draftNeedsReview({ baseRev: 3 }, { rev: 3 })).toBe(false);
    expect(draftNeedsReview(null, { rev: 3 })).toBe(false);
  });

  it('counts the other drafts on the board for the detail page submit button', () => {
    const drafts = [{ seq: 31, updatedAt: 1 }, { seq: 27, updatedAt: 2 }, { seq: 12, updatedAt: 3 }];
    expect(submitScope(drafts, 31, true)).toEqual({ own: true, others: 2, total: 3 });
    // 本项刚存的草稿还不在列表里时也照样算上。
    expect(submitScope(drafts.slice(1), 31, true)).toEqual({ own: true, others: 2, total: 3 });
    expect(submitScope(drafts, 31, false)).toEqual({ own: false, others: 2, total: 2 });
  });

  it('rejects images the server would reject, before uploading', () => {
    expect(checkBoardImages([{ type: 'image/png', size: 10 }], 0)).toEqual({ ok: true });
    expect(checkBoardImages([{ type: 'image/svg+xml', size: 10 }], 0)).toEqual({ ok: false, reason: 'type' });
    expect(checkBoardImages([{ type: 'image/jpeg', size: BOARD_IMAGE_MAX_BYTES + 1 }], 0)).toEqual({ ok: false, reason: 'size' });
    expect(checkBoardImages([{ type: 'image/webp', size: 1 }], BOARD_FILES_PER_DRAFT)).toEqual({ ok: false, reason: 'count' });
  });
});

describe('submit confirmation', () => {
  const draft = { seq: 31, author: 'owner', choice: 'A', text: 'A，开关放 Bot 配置页', fileIds: ['f1', 'f2'], baseRev: 2, updatedAt: 1234 };

  it('describes each draft with its choice, recommendation, images and stale flag', () => {
    expect(submitCandidateFromDetail({ item: item(), draft })).toEqual({
      seq: 31, title: '同机 bot 授信方式', state: 'decide', choice: 'A', choiceLabel: '恢复', recommended: true,
      text: 'A，开关放 Bot 配置页', imageCount: 2, draftUpdatedAt: 1234, stale: true,
    });
    expect(submitCandidateFromDetail({ item: item({ rev: 2 }), draft: { ...draft, choice: 'B' } })).toMatchObject({ recommended: false, stale: false, choiceLabel: '只信同 owner' });
  });

  it('skips items whose draft is gone (submitted or cleared elsewhere)', () => {
    expect(submitCandidateFromDetail({ item: item() })).toBeNull();
  });

  it('lists the current item first and sends only the checked items with the draft version seen', () => {
    const base = submitCandidateFromDetail({ item: item(), draft })!;
    const list = orderSubmitCandidates([
      { ...base, seq: 12, draftUpdatedAt: 10 },
      { ...base, seq: 31, draftUpdatedAt: 20 },
      { ...base, seq: 27, draftUpdatedAt: 30 },
    ], 27);
    expect(list.map(c => c.seq)).toEqual([27, 12, 31]);
    expect(submitPayloadItems(list, new Set([12]))).toEqual([{ seq: 27, draftUpdatedAt: 30 }, { seq: 31, draftUpdatedAt: 20 }]);
  });
});

describe('batches', () => {
  const batch = (patch: Partial<BoardBatch>): BoardBatch => ({ id: 8, author: 'local', createdAt: 0, delivery: 'pending', attempts: 1, ...patch });

  it('offers redelivery and the Bot config link when the steward has no chat', () => {
    const view = batchView(batch({ delivery: 'failed', error: 'steward_chat_missing' }), 0, zh);
    expect(view).toMatchObject({ tone: 'error', needsChat: true, canRedeliver: true, reason: zh('decisionBoard.errStewardChatMissing') });
    expect(batchView(batch({ delivery: 'failed', error: 'boom' }), 0, zh)).toMatchObject({ needsChat: false, canRedeliver: true, reason: 'boom' });
  });

  it('does not offer redelivery for delivered batches or ones still being delivered', () => {
    const now = 3_600_000;
    expect(batchView(batch({ delivery: 'delivered' }), now, zh)).toMatchObject({ tone: 'ok', canRedeliver: false });
    expect(batchView(batch({ createdAt: now }), now, zh).canRedeliver).toBe(false);
    // dispatched（in-flight）显示「投递中」、不给重投，也不按成功渲染。
    expect(batchView(batch({ delivery: 'dispatched' }), now, zh))
      .toMatchObject({ labelKey: 'decisionBoard.batchPending', tone: 'warn', canRedeliver: false });
    // 真正 pending 挂很久（进程死在 dispatched 落盘前的毫秒窗口）：给手动重投。
    expect(batchView(batch({ createdAt: 0 }), now, zh).canRedeliver).toBe(true);
  });

  it('renders interrupted stale deliveries as failures with a re-deliver action', () => {
    const view = batchView(batch({ delivery: 'failed', error: 'delivery_interrupted' }), 0, zh);
    expect(view).toMatchObject({ tone: 'error', canRedeliver: true, reason: zh('decisionBoard.errDeliveryInterrupted') });
  });

  it('shows the server message in Chinese, and translates known error codes otherwise', () => {
    const body = { ok: false, error: 'draft_changed', message: '#31 的草稿在别处改过，刷新后再提交' };
    expect(boardErrorText(body, 409, zh, 'zh')).toBe(body.message);
    expect(boardErrorText(body, 409, en, 'en')).toBe(en('decisionBoard.errDraftChanged'));
    expect(boardErrorText({ ok: false, error: 'daemon_offline' }, 503, zh, 'zh')).toBe(zh('decisionBoard.errDaemonOffline'));
    expect(boardErrorText(undefined, 502, en, 'en')).toBe(en('decisionBoard.errGeneric', { error: 'HTTP 502' }));
  });
});

describe('steward config payload', () => {
  const forms: StewardForm[] = [
    { enabled: false, chatId: '', guideMode: 'append', guideText: '' },
    { enabled: true, chatId: '', guideMode: 'append', guideText: '' },
    { enabled: true, chatId: 'oc_abc', guideMode: 'append', guideText: '  推进标准：合码按 STANDARD.md 执行\r\n' },
    { enabled: true, chatId: 'oc_abc', guideMode: 'replace', guideText: '只汇报' },
    { enabled: false, chatId: 'oc_abc', guideMode: 'append', guideText: '' },
  ];

  it('sends null for the default and omits the default append mode', () => {
    expect(stewardPayload(forms[0]!)).toBeNull();
    expect(stewardPayload(forms[1]!)).toEqual({ enabled: true });
    expect(stewardPayload(forms[2]!)).toEqual({ enabled: true, chatId: 'oc_abc', guideText: '推进标准：合码按 STANDARD.md 执行' });
    expect(stewardPayload(forms[3]!)).toEqual({ enabled: true, chatId: 'oc_abc', guideMode: 'replace', guideText: '只汇报' });
  });

  it('produces exactly what the server validator accepts and stores', () => {
    for (const form of forms) {
      const payload = stewardPayload(form);
      expect(normalizeStewardConfig(payload), JSON.stringify(form)).toEqual({ ok: true, value: payload });
      // 读回来再存一次不变。
      expect(stewardPayload(stewardFormFrom(payload))).toEqual(payload);
    }
  });

  it('catches "replace" without text before the server does', () => {
    const form: StewardForm = { enabled: true, chatId: 'oc_abc', guideMode: 'replace', guideText: ' ' };
    expect(stewardGuideProblem(form)).toBe('replace_empty');
    expect(normalizeStewardConfig({ enabled: true, chatId: 'oc_abc', guideMode: 'replace' }).ok).toBe(false);
    expect(stewardGuideProblem({ ...form, guideText: '只汇报' })).toBeNull();
  });

  it('strips the machine prefix from validation errors', () => {
    expect(stewardErrorText('invalid_steward: 选了「替换预置」就要填写自定义提示词', zh)).toBe('选了「替换预置」就要填写自定义提示词');
    expect(stewardErrorText('daemon_offline', zh)).toBe(zh('decisionBoard.errDaemonOffline'));
  });
});
