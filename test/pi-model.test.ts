import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPiAdapter, resolvePiModelForSpawn } from '../src/adapters/cli/pi.js';
import { logger } from '../src/utils/logger.js';
import {
  isPiQualifiedModel,
  piSettingsPath,
  readPiDefaultProvider,
  resolvePiModel,
} from '../src/adapters/cli/pi-model.js';

describe('pi model qualification', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    vi.restoreAllMocks();
  });

  function makeHome(settings?: unknown): string {
    const home = mkdtempSync(join(tmpdir(), 'botmux-pi-model-'));
    mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
    if (settings !== undefined) {
      writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify(settings));
    }
    return home;
  }

  function overlayDir(home: string, settings: unknown): string {
    const overlay = join(home, 'overlay');
    mkdirSync(overlay, { recursive: true });
    writeFileSync(join(overlay, 'settings.json'), JSON.stringify(settings));
    return overlay;
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

  it('prefers PI_CODING_AGENT_DIR over ~/.pi (process env)', () => {
    const home = makeHome({ defaultProvider: 'ignored' });
    process.env.PI_CODING_AGENT_DIR = overlayDir(home, { defaultProvider: 'tako' });
    expect(readPiDefaultProvider({ homeDir: home })).toBe('tako');
    expect(piSettingsPath({ homeDir: home })).toBe(join(process.env.PI_CODING_AGENT_DIR, 'settings.json'));
  });

  it('honors PI_CODING_AGENT_DIR / HOME from the injected child env, not process.env', () => {
    const home = makeHome({ defaultProvider: 'from-real-home' });
    const childHome = makeHome({});
    process.env.PI_CODING_AGENT_DIR = overlayDir(home, { defaultProvider: 'from-process-env' });
    const childOverlay = overlayDir(childHome, { defaultProvider: 'from-child-env' });

    // Injected env wins over the daemon process env.
    expect(resolvePiModel('grok-4.6', { env: { PI_CODING_AGENT_DIR: childOverlay } }))
      .toMatchObject({ kind: 'prefixed', provider: 'from-child-env' });

    // HOME in the injected env is used when no overlay is present; a daemon
    // process env pointing elsewhere must not leak in.
    expect(resolvePiModel('grok-4.6', { env: { HOME: childHome } }))
      .toMatchObject({ kind: 'bare', state: 'ok-no-provider' });
  });

  it('prefixes a bare model with defaultProvider', () => {
    const home = makeHome({ defaultProvider: 'team-gateway' });
    expect(resolvePiModel('grok-4.6', home)).toEqual({
      kind: 'prefixed',
      flag: 'team-gateway/grok-4.6',
      provider: 'team-gateway',
      settingsPath: join(home, '.pi', 'agent', 'settings.json'),
    });
  });

  it('leaves provider/id untouched', () => {
    const home = makeHome({ defaultProvider: 'team-gateway' });
    expect(resolvePiModel('tako/grok-4.6', home)).toEqual({ kind: 'qualified', flag: 'tako/grok-4.6' });
  });

  it('keeps a bare model when settings have no defaultProvider', () => {
    const home = makeHome({ defaultModel: 'grok-4.6' });
    expect(resolvePiModel('grok-4.6', home)).toMatchObject({ kind: 'bare', state: 'ok-no-provider' });
  });

  it('reports absent settings distinctly', () => {
    const home = mkdtempSync(join(tmpdir(), 'botmux-pi-model-'));
    expect(resolvePiModel('grok-4.6', home)).toMatchObject({ kind: 'bare', state: 'absent' });
  });

  it('omits the model flag when BotConfig.model is empty', () => {
    const home = makeHome({ defaultProvider: 'team-gateway' });
    expect(resolvePiModel(undefined, home)).toEqual({ kind: 'none' });
    expect(resolvePiModel('   ', home)).toEqual({ kind: 'none' });
  });

  it('flags unreadable settings and keeps the bare model', () => {
    const home = makeHome();
    writeFileSync(join(home, '.pi', 'agent', 'settings.json'), '{not-json');
    const result = resolvePiModel('grok-4.6', home);
    expect(result).toMatchObject({ kind: 'bare', state: 'invalid' });
  });

  describe('resolvePiModelForSpawn logging', () => {
    it('logs the rewrite with both ids, provider and settings path', () => {
      const home = makeHome({ defaultProvider: 'team-gateway' });
      const flag = resolvePiModelForSpawn('grok-4.6', { HOME: home });
      expect(flag).toBe('team-gateway/grok-4.6');
      expect(infoSpy).toHaveBeenCalledTimes(1);
      const msg = String(infoSpy.mock.calls[0][0]);
      expect(msg).toContain('grok-4.6');
      expect(msg).toContain('team-gateway/grok-4.6');
      expect(msg).toContain('team-gateway');
      expect(msg).toContain(join(home, '.pi', 'agent', 'settings.json'));
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('passes an already qualified model without info noise', () => {
      const home = makeHome({ defaultProvider: 'team-gateway' });
      expect(resolvePiModelForSpawn('tako/grok-4.6', { HOME: home })).toBe('tako/grok-4.6');
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('warns when settings are unreadable', () => {
      const home = makeHome();
      writeFileSync(join(home, '.pi', 'agent', 'settings.json'), '{not-json');
      const flag = resolvePiModelForSpawn('grok-4.6', { HOME: home });
      expect(flag).toBe('grok-4.6');
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(String(warnSpy.mock.calls[0][0])).toContain('unreadable');
      expect(infoSpy).not.toHaveBeenCalled();
    });

    it('explains a bare passthrough when no defaultProvider is configured', () => {
      const home = makeHome({ defaultModel: 'grok-4.6' });
      const flag = resolvePiModelForSpawn('grok-4.6', { HOME: home });
      expect(flag).toBe('grok-4.6');
      expect(infoSpy).toHaveBeenCalledTimes(1);
      expect(String(infoSpy.mock.calls[0][0])).toContain('left unqualified');
    });

    it('stays silent when no model is configured', () => {
      const home = makeHome({ defaultProvider: 'team-gateway' });
      expect(resolvePiModelForSpawn(undefined, { HOME: home })).toBeUndefined();
      expect(infoSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('lets the injected child env win over the daemon process env', () => {
      const daemonHome = makeHome({ defaultProvider: 'daemon-provider' });
      const childHome = makeHome({ defaultProvider: 'child-provider' });
      process.env.PI_CODING_AGENT_DIR = join(daemonHome, '.pi', 'agent');
      // Reversing the env merge would resolve to daemon-provider and silently
      // bind the session against the daemon's pi agent dir.
      const flag = resolvePiModelForSpawn(
        'grok-4.6',
        { PI_CODING_AGENT_DIR: join(childHome, '.pi', 'agent') },
      );
      expect(flag).toBe('child-provider/grok-4.6');
    });
  });

  it('adapter.buildArgs qualifies against the per-bot child env and logs it', () => {
    const home = makeHome({ defaultProvider: 'team-gateway' });
    const daemonHome = makeHome({ defaultProvider: 'daemon-provider' });
    // A conflicting overlay on the DAEMON process env must lose to the env the
    // pi child is actually spawned with (reversing the merge in buildArgs
    // silently binds the session to the daemon's agent dir).
    process.env.PI_CODING_AGENT_DIR = join(daemonHome, '.pi', 'agent');
    const adapter = createPiAdapter('/usr/bin/pi', () => '/tmp/boundary.js');
    const args = adapter.buildArgs({
      sessionId: 'sess-pi',
      resume: false,
      model: 'grok-4.6',
      env: { PI_CODING_AGENT_DIR: join(home, '.pi', 'agent') },
    });
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('team-gateway/grok-4.6');
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(String(infoSpy.mock.calls[0][0])).toContain('team-gateway/grok-4.6');
  });
});
