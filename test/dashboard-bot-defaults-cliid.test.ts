import { describe, expect, it } from 'vitest';
import { displayCliId } from '../src/dashboard/web/bot-defaults.js';

describe('bot defaults cli label', () => {
  it('prefers /api/bots cliId before session fallback', () => {
    expect(displayCliId({ larkAppId: 'cli_traex', cliId: 'traex' }, 'codex')).toBe('traex');
    expect(displayCliId({ larkAppId: 'cli_traex' }, 'codex')).toBe('codex');
    expect(displayCliId({ larkAppId: 'cli_traex', cliId: '' }, '')).toBe('');
  });
});
