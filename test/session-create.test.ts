import { describe, it, expect } from 'vitest';
import {
  normalizeCreateMode,
  normalizeCreateColumn,
  deriveSessionTitleFromContent,
  parseSpawnRequest,
  composeSpawnCodexAppContext,
  composeSpawnUserContent,
  applyQueuedCodexAppLegacyFallback,
  mergeQueuedCodexAppTurn,
  buildLeadDispatchPreamble,
  buildCollabNote,
} from '../src/core/session-create.js';

describe('normalizeCreateMode / normalizeCreateColumn', () => {
  it('accepts only the valid literals', () => {
    expect(normalizeCreateMode('all')).toBe('all');
    expect(normalizeCreateMode('lead')).toBe('lead');
    expect(normalizeCreateMode('solo')).toBeNull();
    expect(normalizeCreateMode(123)).toBeNull();
    expect(normalizeCreateColumn('in_progress')).toBe('in_progress');
    expect(normalizeCreateColumn('backlog')).toBe('backlog');
    expect(normalizeCreateColumn('todo')).toBeNull();
    expect(normalizeCreateColumn(undefined)).toBeNull();
  });
});

describe('deriveSessionTitleFromContent', () => {
  it('takes the first non-empty line, trimmed', () => {
    expect(deriveSessionTitleFromContent('  \n\n  修复登录 bug  \n更多细节')).toBe('修复登录 bug');
  });
  it('caps very long first lines with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const title = deriveSessionTitleFromContent(long);
    expect(title.length).toBe(51); // 50 chars + …
    expect(title.endsWith('…')).toBe(true);
  });
  it('falls back to a placeholder for blank content', () => {
    expect(deriveSessionTitleFromContent('   \n  ')).toBeTruthy();
  });
});

describe('parseSpawnRequest', () => {
  const base = { chatId: 'oc_abc', content: '做点事', column: 'in_progress', role: 'solo' };

  it('accepts a well-formed request and trims trailing whitespace from content', () => {
    const r = parseSpawnRequest({ ...base, content: 'hello\n\n  ', coworkers: [{ name: 'Bob', openId: 'ou_b' }, { name: '' }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.content).toBe('hello');
      expect(r.value.chatId).toBe('oc_abc');
      expect(r.value.column).toBe('in_progress');
      expect(r.value.role).toBe('solo');
      // empty-name coworker dropped; valid one kept
      expect(r.value.coworkers).toEqual([{ name: 'Bob', openId: 'ou_b' }]);
    }
  });

  it('rejects a non-oc_ chatId', () => {
    expect(parseSpawnRequest({ ...base, chatId: 'om_msg' })).toMatchObject({ ok: false, error: 'bad_chat_id' });
    expect(parseSpawnRequest({ ...base, chatId: '' })).toMatchObject({ ok: false, error: 'bad_chat_id' });
  });

  it('rejects empty / whitespace-only content', () => {
    expect(parseSpawnRequest({ ...base, content: '   ' })).toMatchObject({ ok: false, error: 'empty_content' });
    expect(parseSpawnRequest({ ...base, content: '' })).toMatchObject({ ok: false, error: 'empty_content' });
  });

  it('accepts very long content (no size cap — owner-authed input)', () => {
    const huge = 'a'.repeat(50000);
    const r = parseSpawnRequest({ ...base, content: huge });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.content.length).toBe(50000);
  });

  it('rejects bad column / role', () => {
    expect(parseSpawnRequest({ ...base, column: 'todo' })).toMatchObject({ ok: false, error: 'bad_column' });
    expect(parseSpawnRequest({ ...base, role: 'boss' })).toMatchObject({ ok: false, error: 'bad_role' });
  });

  it('rejects a non-object body', () => {
    expect(parseSpawnRequest(null)).toMatchObject({ ok: false, error: 'bad_request' });
    expect(parseSpawnRequest('nope')).toMatchObject({ ok: false, error: 'bad_request' });
  });
});

describe('composeSpawnUserContent', () => {
  it('solo returns the content untouched', () => {
    expect(composeSpawnUserContent({ content: 'do X', role: 'solo' })).toBe('do X');
  });

  it('lead prepends an orchestration preamble listing the sub-bots', () => {
    const out = composeSpawnUserContent({
      content: 'split the work',
      role: 'lead',
      coworkers: [{ name: 'Coder', openId: 'ou_c' }, { name: 'Reviewer' }],
    });
    expect(out).toContain('<botmux_lead_dispatch>');
    expect(out).toContain('Coder');
    expect(out).toContain('ou_c');
    expect(out).toContain('Reviewer'); // open_id-less coworker still listed by name
    expect(out.endsWith('split the work')).toBe(true);
  });

  it('lead with no sub-bots still wraps but notes there are none', () => {
    const out = composeSpawnUserContent({ content: 'go', role: 'lead', coworkers: [] });
    expect(out).toContain('<botmux_lead_dispatch>');
    expect(out.endsWith('go')).toBe(true);
  });

  it('collab prepends a coordination note naming the peers', () => {
    const out = composeSpawnUserContent({
      content: 'build it',
      role: 'collab',
      coworkers: [{ name: 'A' }, { name: 'B' }],
    });
    expect(out).toContain('<botmux_collab>');
    expect(out).toContain('A');
    expect(out).toContain('B');
    expect(out.endsWith('build it')).toBe(true);
  });

  it('collab with no peers degrades to plain content (no note)', () => {
    expect(composeSpawnUserContent({ content: 'solo work', role: 'collab', coworkers: [] })).toBe('solo work');
  });
});

describe('Codex App dashboard input composition', () => {
  it('keeps role metadata separate from the raw dashboard task', () => {
    const context = composeSpawnCodexAppContext({
      role: 'lead', coworkers: [{ name: 'Coder', openId: 'ou_c' }],
    });
    expect(context).toContain('<botmux_lead_dispatch>');
    expect(context).toContain('Coder');
    expect(context).not.toContain('用户原始任务');
    expect(composeSpawnCodexAppContext({ role: 'solo' })).toBeUndefined();
  });

  it('same-process activation merges queued and current raw text without leaking wrappers', () => {
    const merged = mergeQueuedCodexAppTurn({
      queued: true,
      queuedText: '最初 dashboard 任务',
      queuedMessageContext: '<botmux_lead_dispatch>协调信息</botmux_lead_dispatch>',
      currentText: '群里的第一条补充',
      currentMessageContext: '<sender>晓雪</sender>',
    });
    expect(merged.text).toBe('最初 dashboard 任务\n\n群里的第一条补充');
    expect(merged.text).not.toContain('botmux_lead_dispatch');
    expect(merged.messageContext).toBe(
      '<botmux_lead_dispatch>协调信息</botmux_lead_dispatch>\n\n<sender>晓雪</sender>',
    );
  });

  it('drops an incomplete sidecar only for a legacy queued snapshot', () => {
    const structured = {
      content: '<user_message>最初任务\n\n开始吧</user_message>',
      codexAppInput: { text: '开始吧' },
    };
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: true,
      queuedText: undefined,
    })).toEqual({ content: structured.content });
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: true,
      queuedText: 42,
    })).toEqual({ content: structured.content });

    // Presence, not truthiness, identifies the new persisted schema.
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: true,
      queuedText: '',
    })).toBe(structured);
    expect(applyQueuedCodexAppLegacyFallback(structured, {
      queued: false,
      queuedText: undefined,
    })).toBe(structured);

    const legacyOnly = { content: structured.content };
    expect(applyQueuedCodexAppLegacyFallback(legacyOnly, {
      queued: true,
      queuedText: undefined,
    })).toBe(legacyOnly);
  });

  it('non-queued turns keep the current clean input unchanged', () => {
    expect(mergeQueuedCodexAppTurn({
      queued: false,
      queuedText: '不应出现',
      currentText: '本轮消息',
      currentMessageContext: '<sender>A</sender>',
    })).toEqual({ text: '本轮消息', messageContext: '<sender>A</sender>' });
  });
});

describe('buildLeadDispatchPreamble / buildCollabNote', () => {
  it('preamble lists each coworker on its own line', () => {
    const p = buildLeadDispatchPreamble([{ name: 'X', openId: 'ou_x' }, { name: 'Y' }]);
    expect(p).toContain('- X (open_id: ou_x)');
    expect(p).toContain('- Y');
  });
  it('collab note is empty when there are no peers', () => {
    expect(buildCollabNote([])).toBe('');
  });
});
