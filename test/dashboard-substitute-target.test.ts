import { describe, expect, it } from 'vitest';
import { buildSubstituteTarget } from '../src/dashboard/web/bot-defaults-page.js';

// Regression guard for the substitute-target edit path: re-editing a just-resolved email
// target in the same session must not keep the stale resolved open_id (the server prefers
// open_id, so it would substitute the previous person while the UI shows "saved").
describe('buildSubstituteTarget', () => {
  it('drops a stale resolved open_id when a just-resolved email target is re-edited (same session)', () => {
    // add alice@corp.com → Save resolved it to ou_alice, so persisted now carries both;
    // originalIdField is undefined because the row was added this session (never reloaded).
    const target = buildSubstituteTarget({
      idField: 'email',
      idValue: 'bob@corp.com', // user re-typed a different email before the 2nd Save
      name: '',
      persisted: { openId: 'ou_alice', email: 'alice@corp.com', name: 'Alice' },
      originalIdField: undefined,
    });
    expect(target?.email).toBe('bob@corp.com');
    expect(target?.openId).toBeUndefined(); // must re-resolve the new email, not the stale id
  });

  it('keeps the resolved open_id when the row is unchanged (stable id preserved)', () => {
    const target = buildSubstituteTarget({
      idField: 'email',
      idValue: 'alice@corp.com', // unchanged
      name: 'Alice',
      persisted: { openId: 'ou_alice', email: 'alice@corp.com', name: 'Alice' },
      originalIdField: undefined,
    });
    expect(target?.openId).toBe('ou_alice');
    expect(target?.email).toBe('alice@corp.com');
    expect(target?.name).toBe('Alice');
  });

  it('drops the previous id field when the id field is switched', () => {
    const target = buildSubstituteTarget({
      idField: 'email',
      idValue: 'carol@corp.com',
      name: '',
      persisted: { openId: 'ou_carol', name: 'Carol' },
      originalIdField: 'openId',
    });
    expect(target?.email).toBe('carol@corp.com');
    expect(target?.openId).toBeUndefined();
  });

  it('builds a clean target for a brand-new row', () => {
    expect(buildSubstituteTarget({
      idField: 'openId', idValue: 'ou_dan', name: 'Dan', persisted: {}, originalIdField: undefined,
    })).toEqual({ openId: 'ou_dan', name: 'Dan' });
  });

  it('returns null for a blank id value', () => {
    expect(buildSubstituteTarget({
      idField: 'email', idValue: '  ', name: 'x', persisted: {}, originalIdField: undefined,
    })).toBeNull();
  });
});
