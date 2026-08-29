import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createPiAdapter } from '../src/adapters/cli/pi.js';
import {
  isPiQualifiedModel,
  piSettingsPath,
  readPiDefaultProvider,
  resolvePiModelFlag,
} from '../src/adapters/cli/pi-model.js';

describe('pi model qualification', () => {
  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
  });

  function makeHome(settings?: Record<string, unknown>): string {
    const home = mkdtempSync(join(tmpdir(), 'botmux-pi-model-'));
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    if (settings) {
      writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify(settings));
    }
    return home;
  }

  it('treats provider/id as already qualified', () => {
    expect(isPiQualifiedModel('team-gateway/grok-4.6')).toBe(true);
    expect(isPiQualifiedModel('grok-4.6')).toBe(false);
  });

  it('reads defaultProvider from settings.json', () => {
    const home = makeHome({ defaultProvider: 'team-gateway', defaultModel: 'grok-4.6' });
    expect(readPiDefaultProvider(home)).toBe('team-gateway');
    expect(piSettingsPath(home)).toBe(join(home, '.pi', 'agent', 'settings.json'));
  });

  it('prefers PI_CODING_AGENT_DIR over ~/.pi', () => {
    const home = makeHome({ defaultProvider: 'ignored' });
    const overlay = join(home, 'overlay');
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, 'settings.json'), JSON.stringify({ defaultProvider: 'tako' }));
    process.env.PI_CODING_AGENT_DIR = overlay;
    expect(readPiDefaultProvider(home)).toBe('tako');
  });

  it('prefixes a bare model with defaultProvider', () => {
    const home = makeHome({ defaultProvider: 'team-gateway' });
    expect(resolvePiModelFlag('grok-4.6', home)).toBe('team-gateway/grok-4.6');
  });

  it('leaves provider/id untouched', () => {
    const home = makeHome({ defaultProvider: 'team-gateway' });
    expect(resolvePiModelFlag('tako/grok-4.6', home)).toBe('tako/grok-4.6');
  });

  it('keeps a bare model when settings have no defaultProvider', () => {
    const home = makeHome({ defaultModel: 'grok-4.6' });
    expect(resolvePiModelFlag('grok-4.6', home)).toBe('grok-4.6');
  });

  it('omits the model flag when BotConfig.model is empty', () => {
    expect(resolvePiModelFlag(undefined, makeHome({ defaultProvider: 'team-gateway' }))).toBeUndefined();
    expect(resolvePiModelFlag('   ', makeHome({ defaultProvider: 'team-gateway' }))).toBeUndefined();
  });

  it('ignores unreadable settings and keeps the bare model', () => {
    const home = makeHome();
    writeFileSync(join(home, '.pi', 'agent', 'settings.json'), '{not-json');
    expect(resolvePiModelFlag('grok-4.6', home)).toBe('grok-4.6');
  });

  it('buildArgs still accepts an already-qualified model', () => {
    const args = createPiAdapter('/usr/bin/pi').buildArgs({
      sessionId: 'sess-pi',
      resume: false,
      model: 'team-gateway/grok-4.6',
    });
    expect(args).toEqual([
      '--session-id', 'sess-pi',
      '--model', 'team-gateway/grok-4.6',
    ]);
  });
});
