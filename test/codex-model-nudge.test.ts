import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { config } from '../src/config.js';
import { globalConfigPath, mergeDashboardConfig } from '../src/global-config.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createTraexAdapter } from '../src/adapters/cli/traex.js';

const override = 'notice.hide_rate_limit_model_nudge=true';

describe('Codex low-quota model-switch protection', () => {
  let fixtureDir: string;
  beforeEach(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), 'botmux-model-nudge-'));
    vi.stubEnv('HOME', fixtureDir);
    vi.stubEnv('CODEX_HOME', join(fixtureDir, '.codex'));
    mkdirSync(dirname(globalConfigPath()), { recursive: true });
    mkdirSync(join(fixtureDir, '.codex'));
    writeFileSync(join(fixtureDir, '.codex/config.toml'), 'model = "gpt-6-astra"\n');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(fixtureDir, { recursive: true, force: true });
  });

  it.each([
    { kind: 'fresh', resume: false },
    { kind: 'resume', resume: true, resumeSessionId: 'existing-thread' },
    { kind: 'fork', resume: true, forkSession: true, resumeSessionId: 'existing-thread' },
    { kind: 'RPC viewer', resume: true, remoteWsUrl: 'ws://127.0.0.1:9000', remoteThreadId: 'existing-thread' },
  ])('protects $kind launches by default and preserves opt-out across reloads', (launch) => {
    const adapter = createCodexAdapter('/usr/bin/codex');
    for (const enabled of [undefined, false, true]) {
      if (enabled !== undefined) mergeDashboardConfig({ hideCodexRateLimitModelNudge: enabled });
      for (const restricted of [false, true]) {
        const args = adapter.buildArgs({
          sessionId: 'botmux-thread', ...launch,
          model: 'gpt-6-astra',
          disableCliBypass: restricted,
          hideRateLimitModelNudge: config.hideCodexRateLimitModelNudge,
        });
        expect(args.includes(override)).toBe(enabled !== false);
        expect(args).not.toContain('notice.hide_rate_limit_model_nudge=false');
        if (enabled !== false) {
          expect(args[args.indexOf(override) - 1]).toBe('-c');
          if (args.includes('existing-thread')) {
            expect(args.indexOf(override)).toBeLessThan(args.indexOf('existing-thread'));
          }
        }
        if (!launch.remoteWsUrl) expect(args[args.indexOf('--model') + 1]).toBe('gpt-6-astra');
      }
    }
    expect(readFileSync(join(fixtureDir, '.codex/config.toml'), 'utf8')).toBe('model = "gpt-6-astra"\n');
  });

  it('ignores malformed persisted values and retains the default protection', () => {
    writeFileSync(globalConfigPath(), JSON.stringify({ dashboard: { hideCodexRateLimitModelNudge: 'false' } }));
    expect(config.hideCodexRateLimitModelNudge).toBe(true);
  });

  it('does not pass Codex-specific notice settings to another CLI', () => {
    const args = createTraexAdapter('/usr/bin/traex').buildArgs({
      sessionId: 'other-cli', resume: false,
      hideRateLimitModelNudge: config.hideCodexRateLimitModelNudge,
    });
    expect(args.join(' ')).not.toContain('hide_rate_limit_model_nudge');
  });
});
