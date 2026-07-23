/**
 * sandbox.test.ts
 *
 * Tests for the DIRECT-mode file sandbox module: the relay security boundary
 * (validateRelayRequest / materializeOutboxFile — the sandbox↔host trust
 * boundary, unchanged by the fs-policy refactor) and the platform gate of
 * prepareDirectSandbox. The pure mount-plan logic lives in fs-policy.ts and is
 * covered by fs-policy.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { buildRelayHostEnv, validateRelayRequest, materializeOutboxFile, prepareDirectSandbox } from '../src/adapters/backend/sandbox.js';
import { createCodexAppAdapter } from '../src/adapters/cli/codex-app.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'sbx-'));

describe('codex-app sandboxExtraExecPaths', () => {
  it('returns exactly the resolved codex bin and never the working dir', () => {
    // pathOverride is absolute → resolveCommand short-circuits (no shell-out / flake).
    const runCodex = '/run/user/1001/fnm_multishells/abc_123/bin/codex';
    const adapter = createCodexAppAdapter(runCodex);
    // build args with a /run working dir — must NOT leak into the exec-path list.
    adapter.buildArgs({ sessionId: 's1', resume: false, workingDir: '/run/user/1001/proj' });
    const extra = adapter.sandboxExtraExecPaths?.();
    expect(extra).toEqual([runCodex]);
    expect(extra).not.toContain('/run/user/1001/proj');
  });
});

describe('prepareDirectSandbox platform gate', () => {
  it('returns null off-linux (worker treats null as a hard error, never silent-unsandboxed)', () => {
    if (process.platform === 'linux') return; // gate only observable off-linux
    const r = prepareDirectSandbox({
      sessionId: 's1', dataDir: tmp(),
      policy: { rules: [], net: true, writeRegexes: [] },
      chdir: '/x', home: '/home/u', cliBin: '/usr/bin/true', cliArgs: [],
    });
    expect(r).toBeNull();
  });
});


// ── validateRelayRequest: pure schema + flag-allowlist boundary (UNCHANGED) ──
// Regression for the "sandbox makes host read an arbitrary path" confused-deputy
// blocker: only plain outbox basenames + allowlisted flags pass; raw argv /
// path flags / sandbox-chosen session-id are rejected.
describe('validateRelayRequest', () => {
  it('forces host-relayed cards to use probe-free lexical link repair', () => {
    expect(buildRelayHostEnv({
      BOTMUX_SEND_RELAY: '/sandbox/outbox',
      BOTMUX_CARD_LOCAL_LINK_MODE: 'filesystem',
      KEEP_ME: 'yes',
    })).toMatchObject({
      BOTMUX_CARD_LOCAL_LINK_MODE: 'lexical',
      KEEP_ME: 'yes',
    });
    expect(buildRelayHostEnv({ BOTMUX_SEND_RELAY: '/sandbox/outbox' }))
      .not.toHaveProperty('BOTMUX_SEND_RELAY');

    expect(buildRelayHostEnv({}, '/private/staging/prepared.md')).toMatchObject({
      BOTMUX_CARD_LOCAL_LINK_MODE: 'disabled',
      BOTMUX_CARD_PREPARED_CONTENT_FILE: '/private/staging/prepared.md',
    });
  });

  it('accepts plain basenames + allowlisted presentation flags', () => {
    const r = validateRelayRequest({
      contentFile: 'c.content',
      preparedContentFile: 'c.card-content',
      attachments: ['a.png'],
      videos: ['replay.mp4'],
      videoCovers: ['cover.png'],
      flags: ['--mention-back', '--mention', 'ou:X', '--voice'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentName).toBe('c.content');
    expect(r.value.preparedContentName).toBe('c.card-content');
    expect(r.value.attachmentNames).toEqual(['a.png']);
    expect(r.value.videoNames).toEqual(['replay.mp4']);
    expect(r.value.videoCoverNames).toEqual(['cover.png']);
    expect(r.value.flags).toEqual(['--mention-back', '--mention', 'ou:X', '--voice']);
  });

  it('accepts a custom card file as a plain outbox basename', () => {
    const r = validateRelayRequest({
      contentFile: 'c.content',
      cardFile: 'card.json',
      flags: ['--no-mention'],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.contentName).toBe('c.content');
    expect(r.value.cardName).toBe('card.json');
    expect(r.value.flags).toEqual(['--no-mention']);
  });

  it('validates and preserves a frozen relay origin', () => {
    const r = validateRelayRequest({
      contentFile: 'c.content',
      flags: ['--no-mention'],
      originTurnId: 'delivery-key',
      originDispatchAttempt: 3,
    });
    expect(r).toMatchObject({
      ok: true,
      value: { originTurnId: 'delivery-key', originDispatchAttempt: 3 },
    });
    expect(validateRelayRequest({
      contentFile: 'c.content', originDispatchAttempt: 1,
    })).toMatchObject({ ok: false });
    expect(validateRelayRequest({
      contentFile: 'c.content', originTurnId: 'delivery-key', originDispatchAttempt: 0,
    })).toMatchObject({ ok: false });
  });

  it('rejects the raw-hostArgs exploit (path-bearing flag not allowlisted)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--content-file', '/root/.botmux/bots.json'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--files', '/root/.ssh/id_rsa'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--card-file', '/root/.botmux/card.json'] }).ok).toBe(false);
  });

  it('rejects a sandbox-supplied --session-id (cannot target another session)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--session-id', 'other'] }).ok).toBe(false);
  });

  it('rejects sandbox-supplied --attention (receiver cannot emit an unledgered daemon hook)', () => {
    expect(validateRelayRequest({
      contentFile: 'c.content',
      flags: ['--attention'],
    })).toMatchObject({ ok: false, error: 'flag not allowed: --attention' });
  });

  it('rejects a value-taking flag whose value is itself a flag (--mention --session-id desync)', () => {
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--mention', '--session-id'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', flags: ['--quote', '--mention'] }).ok).toBe(false);
  });

  it('rejects non-basename content / attachment names (../ traversal)', () => {
    expect(validateRelayRequest({ contentFile: '../../etc/passwd' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', preparedContentFile: '../prepared' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', attachments: ['../secret'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', cardFile: '../card.json' }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', videos: ['../secret.mp4'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'c.content', videoCovers: ['../cover.png'] }).ok).toBe(false);
    expect(validateRelayRequest({ contentFile: 'a/b' }).ok).toBe(false);
    expect(validateRelayRequest({ /* missing contentFile */ flags: [] }).ok).toBe(false);
  });
});

// ── materializeOutboxFile: TOCTOU-safe read of an outbox file (UNCHANGED) ────
describe('materializeOutboxFile (TOCTOU)', () => {
  it('copies a regular outbox file into the private dest', () => {
    const outbox = tmp(); const stage = tmp();
    writeFileSync(join(outbox, 'c.content'), 'hello');
    const dest = join(stage, 'out');
    expect(materializeOutboxFile(outbox, 'c.content', dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('hello');
  });

  it('refuses a symlink swapped into the outbox pointing at a host file (no exfil)', () => {
    const outbox = tmp(); const stage = tmp(); const secretDir = tmp();
    const secret = join(secretDir, 'bots.json');
    writeFileSync(secret, 'SECRET_FROM_HOST');
    symlinkSync(secret, join(outbox, 'c.content'));
    const dest = join(stage, 'out');
    expect(materializeOutboxFile(outbox, 'c.content', dest)).toBe(false);  // O_NOFOLLOW rejects
    expect(existsSync(dest)).toBe(false);  // nothing materialized → nothing to exfil
  });

  it('refuses a missing or non-regular file', () => {
    const outbox = tmp(); const stage = tmp();
    expect(materializeOutboxFile(outbox, 'nope', join(stage, 'o'))).toBe(false);
  });

  it('does NOT hang on a FIFO and rejects it (O_NONBLOCK + fstat-reject)', () => {
    // Regression: a malicious agent drops a FIFO into the rw-bound outbox; without
    // O_NONBLOCK the synchronous openSync blocks forever (no writer), freezing the
    // worker event loop. With O_NONBLOCK the open returns immediately and the
    // fstat reject (isFile() false) refuses it — no hang, no materialization.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const outbox = tmp(); const stage = tmp();
    try { execFileSync('mkfifo', [join(outbox, 'evil')], { stdio: 'ignore' }); }
    catch { return; } // mkfifo unavailable in this env — skip
    const dest = join(stage, 'o');
    const start = Date.now();
    const r = materializeOutboxFile(outbox, 'evil', dest);
    const elapsed = Date.now() - start;
    expect(r).toBe(false);            // rejected (not a regular file)
    expect(existsSync(dest)).toBe(false);
    expect(elapsed).toBeLessThan(2000); // returned immediately, did NOT block
  });
});
