import { describe, expect, it } from 'vitest';
import { editFailedPrompt } from '../src/services/failed-prompt-edit.js';
import { appendFailedPromptActions, buildFailedPromptEditCard } from '../src/im/lark/failed-prompt-card.js';
import type { FailedTurnRecord } from '../src/types.js';
const record: FailedTurnRecord = { turnId: 'failed', userPrompt: 'Original prompt',
  cliInput: '<sender>frozen identity</sender>\n<user_message>Original prompt</user_message>\n<attachments hint="original"><image n="1" path="/fixture/photo.png" /><file n="1" path="/fixture/notes.txt" /></attachments>',
  failedAt: '2026-11-25T00:00:00Z', retryCount: 0, status: 'failed', directFailure: true,
  traexPromptCheckpoint: { sessionId: 'native', offset: 123, prefixHash: 'a'.repeat(64) },
  attachments: [{ type: 'image', path: '/fixture/photo.png', name: 'photo.png', resourceKey: 'img_original' },
    { type: 'file', path: '/fixture/notes.txt', name: 'notes.txt' }] };
describe('edit failed prompt', () => {
  it('keeps the frozen identity and original image when text is edited', () => {
    const edited = editFailedPrompt(record, 'New <sender> & text', true)!;
    expect(edited.content).toContain('<sender>frozen identity</sender>');
    expect(edited.content).toContain('New &lt;sender&gt; &amp; text');
    expect(edited.content).toContain('path="/fixture/photo.png"');
    expect(edited.attachments).toHaveLength(2);
    expect(record.userPrompt).toBe('Original prompt');
  });
  it('removes selected image hints and replay metadata while keeping files', () => {
    const edited = editFailedPrompt(record, 'New text', false)!;
    expect(edited.content).not.toContain('<image');
    expect(edited.content).toContain('/fixture/notes.txt');
    expect(edited.attachments?.map(a => a.type)).toEqual(['file']);
  });
  it('rejects ambiguous envelopes and unsupported structured image removal', () => {
    expect(editFailedPrompt({ ...record, cliInput: '<user_message>a</user_message><user_message>b</user_message>' }, 'x', true)).toBeUndefined();
    expect(editFailedPrompt({ ...record, codexAppInput: { text: 'original' } as any }, 'x', false)).toBeUndefined();
  });
});
describe('failed prompt cards', () => {
  const base = JSON.stringify({ schema: '2.0', body: { elements: [{ tag: 'markdown', element_id: 'botmux_reply_footer', content: 'signature' }] } });
  const render = (over: Partial<FailedTurnRecord> = {}) => JSON.parse(appendFailedPromptActions(base, {
    record: { ...record, ...over }, cliId: 'traex', localOwnedSession: true, turnId: 'failed', rootId: 'root', sessionId: 'session', locale: 'en' }));
  it('renders the saved prompt and image with Retry and Edit pinned to this failure', () => {
    const card = render(); const json = JSON.stringify(card);
    expect(json).toContain('Retry'); expect(json).toContain('Edit prompt'); expect(json).toContain('img_original');
    expect(json).toContain('signature'); expect(json).toContain('"turn_id":"failed"');
    expect(json).toContain('"mode":"resend"');
    expect(json).toContain('unchanged image may fail again');
  });
  it('offers Continue with a side-effect explanation when proof is absent', () => {
    const json = JSON.stringify(render({ directFailure: undefined, traexPromptCheckpoint: undefined }));
    expect(json).toContain('Continue from current state');
    expect(json).not.toContain('Edit prompt'); expect(json).not.toContain('"mode":"resend"');
    expect(json).toContain('cannot undo file edits');
  });
  it('prefills the editor, defaults to keep, and only submits on explicit retry', () => {
    const card = JSON.parse(buildFailedPromptEditCard(record, { rootId: 'root', sessionId: 'session' }, 'en'));
    const form = card.body.elements.find((e: any) => e.tag === 'form');
    expect(form.elements[0].default_value).toBe('Original prompt');
    expect(form.elements[1].initial_option).toBe('keep');
    expect(form.elements[2]).toMatchObject({ action_type: 'form_submit', behaviors: [{ value: { action: 'retry_edited_prompt', turn_id: 'failed' } }] });
    expect(JSON.stringify(card)).toContain('replacement attachment');
  });
  it('does not attach controls to a different turn or unowned session', () => {
    for (const over of [{ turnId: 'other' }, { localOwnedSession: false }, { cliId: 'codex' }]) {
      expect(appendFailedPromptActions(base, { record, cliId: 'traex', localOwnedSession: true, turnId: 'failed', rootId: 'root', sessionId: 'session', ...over })).toBe(base);
    }
  });
});
