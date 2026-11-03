import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectObservedGroupContextCard } from '../src/services/group-context-card-source.js';
import { markGroupContextCardPurpose } from '../src/im/lark/group-context-card.js';

let dir: string;
const imageList = JSON.stringify({ elements: [[{ tag: 'img', image_key: 'img_v3_public' }]] });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'group-card-source-'));
  vi.stubEnv('SESSION_DATA_DIR', dir);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

describe('group-context card producer evidence', () => {
  it.each(['cli_observer', 'cli_peer'])('requires image details for known application %s', senderId => {
    writeFileSync(join(dir, 'bots-info.json'), JSON.stringify([{ larkAppId: 'cli_peer', botName: 'Peer' }]));
    expect(projectObservedGroupContextCard(imageList, 'cli_observer', senderId)).toEqual({ kind: 'unresolved' });
  });

  it('uses only the current observer app open-id cross-reference for peer bots', () => {
    writeFileSync(join(dir, 'bots-info.json'), JSON.stringify([{ larkAppId: 'cli_peer', botName: 'Peer', botOpenId: 'ou_other_app_scope' }]));
    writeFileSync(join(dir, 'bot-openids-cli_observer.json'), JSON.stringify({ peer: 'ou_observed_peer' }));
    writeFileSync(join(dir, 'bot-openids-cli_other.json'), JSON.stringify({ Peer: 'ou_wrong_observer' }));
    expect(projectObservedGroupContextCard(imageList, 'cli_observer', 'ou_observed_peer')).toEqual({ kind: 'unresolved' });
    expect(projectObservedGroupContextCard(imageList, 'cli_observer', 'ou_other_app_scope')).toBeUndefined();
    expect(projectObservedGroupContextCard(imageList, 'cli_observer', 'ou_wrong_observer')).toBeUndefined();
  });

  it('accepts the observer app own bot identity without reusing a peer open-id', () => {
    writeFileSync(join(dir, 'bots-info.json'), JSON.stringify([{ larkAppId: 'cli_observer', botName: 'Self', botOpenId: 'ou_self' }]));
    expect(projectObservedGroupContextCard(imageList, 'cli_observer', 'ou_self')).toEqual({ kind: 'unresolved' });
  });

  it.each(['missing', 'corrupt', 'unknown-name'])('does not require third-party details with %s identity metadata', mode => {
    if (mode === 'corrupt') writeFileSync(join(dir, 'bots-info.json'), '{');
    if (mode === 'unknown-name') {
      writeFileSync(join(dir, 'bots-info.json'), JSON.stringify([{ larkAppId: 'cli_peer', botName: 'Peer' }]));
      writeFileSync(join(dir, 'bot-openids-cli_observer.json'), JSON.stringify({ Other: 'ou_external' }));
    }
    expect(projectObservedGroupContextCard(imageList, 'cli_observer', 'ou_external')).toBeUndefined();
  });

  it('recognizes explicit protocol markers independently of producer metadata', () => {
    const raw = JSON.stringify(markGroupContextCardPurpose({ schema: '2.0', body: { elements: [
      { tag: 'img', img_key: 'img_v3_public', alt: { tag: 'plain_text', content: 'Preview' } },
    ] } }, 'runtime'));
    expect(projectObservedGroupContextCard(raw, 'cli_observer', 'cli_external')).toEqual({ kind: 'runtime' });
  });
});
