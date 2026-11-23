import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { prepareSandboxRelayOutbox, attachSandboxOutbox, buildRelayHostEnv, startOutboxWatcher } from '../src/adapters/backend/sandbox.js';
import { buildFsPolicy, compileToSeatbelt } from '../src/adapters/cli/fs-policy.js';
import { isolationPaneMarkerContent, isolatedPaneReattachSafe } from '../src/adapters/cli/read-isolation.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = realpathSync(mkdtempSync(join(tmpdir(), 'seatbelt-send-'))); roots.push(path); return path; }

describe('Seatbelt host send relay', () => {
  it('reattaches the existing outbox and never recreates a missing live directory', () => {
    const dataDir = root();
    const relay = prepareSandboxRelayOutbox({ sessionId: 'session', dataDir })!;
    expect(relay).not.toBeNull();
    const inode = statSync(relay.outbox).ino;
    expect(attachSandboxOutbox({ sessionId: 'session', dataDir })?.outbox).toBe(relay.outbox);
    expect(statSync(relay.outbox).ino).toBe(inode);
    relay.cleanup();
    expect(attachSandboxOutbox({ sessionId: 'session', dataDir })).toBeNull();
    expect(existsSync(relay.outbox)).toBe(false);
  });

  it('rejects symlinked session and outbox paths without modifying the target', () => {
    for (const leaf of ['session', 'outbox']) {
      const dataDir = root();
      const target = join(dataDir, 'target');
      mkdirSync(target, { mode: 0o755 });
      const parent = join(dataDir, 'sandboxes', 'session');
      mkdirSync(leaf === 'session' ? dirname(parent) : parent, { recursive: true });
      symlinkSync(target, leaf === 'session' ? parent : join(parent, 'outbox'));
      const mode = statSync(target).mode;
      expect(prepareSandboxRelayOutbox({ sessionId: 'session', dataDir })).toBeNull();
      expect(statSync(target).mode).toBe(mode);
    }
  });

  it('removes sandbox classification from host execution without changing the source environment', () => {
    const source = { BOTMUX_SEND_RELAY: '/outbox', BOTMUX_READ_ISOLATED: '1', BOTMUX_READ_ISOLATION: '1', BOTMUX_ORIGIN_CHANNEL_ID: 'channel' };
    const host = buildRelayHostEnv(source);
    for (const key of Object.keys(source)) expect(host).not.toHaveProperty(key);
    expect(source.BOTMUX_READ_ISOLATED).toBe('1');
  });

  it('requires a cold start for the previous pane environment contract', () => {
    const current = JSON.parse(isolationPaneMarkerContent('boot', ['credential', 'read', 'write']));
    const expected = { requiredCapabilities: ['credential', 'read', 'write'] as const, exactCapabilities: true };
    expect(isolatedPaneReattachSafe(JSON.stringify(current), expected)).toBe(true);
    expect(isolatedPaneReattachSafe(JSON.stringify({ ...current, version: 19 }), expected)).toBe(false);
  });

  it.skipIf(process.platform !== 'darwin')('submits from real Seatbelt and acquires the feedback lease only on the authorized host', async () => {
    const dataDir = root();
    const relay = prepareSandboxRelayOutbox({ sessionId: 'session', dataDir })!;
    const project = join(root(), 'project');
    mkdirSync(project);
    const policy = buildFsPolicy({
      platform: 'darwin', homeDir: homedir(), botmuxHome: dataDir, sessionDataDir: dataDir,
      workingDir: project, currentAppId: 'cli_fixture', botHome: join(dataDir, 'bot'),
      outbox: relay.outbox, net: false, execPaths: [], writeRegexes: [],
    });
    policy.rules = policy.rules.filter(rule => rule.access === 'deny' || existsSync(rule.path));
    const profile = join(dataDir, 'policy.sb');
    writeFileSync(profile, compileToSeatbelt(policy));
    const blocked = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/ps', '-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' });
    expect(blocked.status).not.toBe(0);

    const fixture = join(dataDir, 'host-send.mjs');
    const tsxApi = createRequire(import.meta.url).resolve('tsx/esm/api');
    writeFileSync(fixture, `
      import { tsImport } from ${JSON.stringify(tsxApi)};
      import { readdirSync } from 'node:fs';
      const { acquireFeedbackSendLease } = await tsImport(${JSON.stringify(resolve('src/services/feedback-maintenance.ts'))}, import.meta.url);
      if (process.env.BOTMUX_READ_ISOLATED || process.env.BOTMUX_READ_ISOLATION) throw Error('host still classified as isolated');
      const release = acquireFeedbackSendLease(${JSON.stringify(dataDir)});
      const held = readdirSync(${JSON.stringify(join(dataDir, 'feedback-send-leases'))}).length;
      release();
      process.stdout.write(JSON.stringify({ held, remaining: readdirSync(${JSON.stringify(join(dataDir, 'feedback-send-leases'))}).length }));
    `);
    const authorize = vi.fn((claim: { capability?: string }) => claim.capability === 'ab'.repeat(32)
      ? { ok: true as const, origin: { turnId: 'turn' } }
      : { ok: false as const, error: 'stale capability' });
    const stop = startOutboxWatcher(relay.outbox, { ...process.env, BOTMUX_READ_ISOLATED: '1', BOTMUX_READ_ISOLATION: '1', BOTMUX_SEND_RELAY: relay.outbox }, 'session', { cliPath: fixture, authorize });
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    try {
      for (const [id, capability] of [['valid', 'ab'.repeat(32)], ['stale', 'cd'.repeat(32)]]) {
        const req = { contentFile: `${id}.content`, flags: ['--no-mention'], originCapability: capability };
        const script = `printf %s body > ${quote(join(relay.outbox, `${id}.content`))}; printf %s ${quote(JSON.stringify(req))} > ${quote(join(relay.outbox, `${id}.req.json`))}`;
        const submitted = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, '/bin/sh', '-c', script], { encoding: 'utf8' });
        expect(submitted.status, submitted.stderr).toBe(0);
        const responsePath = join(relay.outbox, `${id}.res.json`);
        await vi.waitFor(() => expect(existsSync(responsePath)).toBe(true), { timeout: 10_000 });
        const response = JSON.parse(readFileSync(responsePath, 'utf8'));
        if (id === 'valid') {
          expect(response.code, response.stderr).toBe(0);
          expect(JSON.parse(response.stdout)).toEqual({ held: 1, remaining: 0 });
        } else {
          expect(response.code).not.toBe(0);
          expect(response.stderr).toContain('stale capability');
        }
      }
      expect(authorize).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  }, 30_000);
});
