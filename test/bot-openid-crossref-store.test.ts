import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeBotOpenIdCrossRef,
  readBotOpenIdCrossRefRecord,
} from '../src/services/bot-openid-crossref-store.js';

describe('bot open_id cross-reference store', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'bot-openids-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('persists observer-scoped group roster identities without duplicate casing', () => {
    expect(mergeBotOpenIdCrossRef(dataDir, 'cli_supervisor', [
      { name: 'Relay-Loopy(D2)', openId: 'ou_seen_by_supervisor' },
      { name: 'not-a-bot', openId: 'cli_remote' },
    ])).toBe(true);
    expect(mergeBotOpenIdCrossRef(dataDir, 'cli_supervisor', [
      { name: 'relay-loopy(d2)', openId: 'ou_seen_by_supervisor_v2' },
    ])).toBe(true);

    expect(readBotOpenIdCrossRefRecord(dataDir, 'cli_supervisor')).toEqual({
      'Relay-Loopy(D2)': 'ou_seen_by_supervisor_v2',
    });
    expect(JSON.parse(readFileSync(join(dataDir, 'bot-openids-cli_supervisor.json'), 'utf-8'))).toEqual({
      'Relay-Loopy(D2)': 'ou_seen_by_supervisor_v2',
    });
  });
});
