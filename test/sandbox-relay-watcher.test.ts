import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { startOutboxWatcher } from '../src/adapters/backend/sandbox.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('sandbox relay watcher host handoff', () => {
  it('materializes prepared card bytes and passes only the private path to the host child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-relay-watcher-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);

    const fixture = join(root, 'relay-host-fixture.mjs');
    writeFileSync(fixture, `
      import { readFileSync } from 'node:fs';
      const argv = process.argv.slice(2);
      const value = flag => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
      };
      const rawPath = value('--content-file');
      const preparedPath = process.env.BOTMUX_CARD_PREPARED_CONTENT_FILE;
      process.stdout.write(JSON.stringify({
        command: argv[0],
        argv,
        raw: readFileSync(rawPath, 'utf8'),
        prepared: readFileSync(preparedPath, 'utf8'),
        selected: preparedPath ? readFileSync(preparedPath, 'utf8') : readFileSync(rawPath, 'utf8'),
        rawPath,
        preparedPath,
        localLinkMode: process.env.BOTMUX_CARD_LOCAL_LINK_MODE,
        relayEnv: process.env.BOTMUX_SEND_RELAY ?? null,
        sessionId: value('--session-id'),
      }));
    `);

    const id = 'request-1';
    const rawName = `${id}.content`;
    const preparedName = `${id}.card-content`;
    const reqName = `${id}.req.json`;
    writeFileSync(join(outbox, rawName), 'RAW');
    writeFileSync(join(outbox, preparedName), 'PREPARED');
    writeFileSync(join(outbox, reqName), JSON.stringify({
      contentFile: rawName,
      preparedContentFile: preparedName,
      flags: ['--no-mention'],
    }));

    const stop = startOutboxWatcher(outbox, {
      ...process.env,
      BOTMUX_SEND_RELAY: outbox,
      BOTMUX_CARD_PREPARED_CONTENT_FILE: '/untrusted/stale-prepared.md',
    }, 'forced-session', { cliPath: fixture });

    try {
      const responsePath = join(outbox, `${id}.res.json`);
      await vi.waitFor(() => expect(existsSync(responsePath)).toBe(true), { timeout: 5_000 });

      const response = JSON.parse(readFileSync(responsePath, 'utf8')) as {
        code: number;
        stdout: string;
        stderr: string;
      };
      expect(response.code, response.stderr).toBe(0);
      const child = JSON.parse(response.stdout) as {
        command: string;
        argv: string[];
        raw: string;
        prepared: string;
        selected: string;
        rawPath: string;
        preparedPath: string;
        localLinkMode: string;
        relayEnv: string | null;
        sessionId: string;
      };

      expect(child).toMatchObject({
        command: 'send',
        raw: 'RAW',
        prepared: 'PREPARED',
        selected: 'PREPARED',
        localLinkMode: 'disabled',
        relayEnv: null,
        sessionId: 'forced-session',
      });
      expect(dirname(child.rawPath)).toBe(join(root, 'relay-staging'));
      expect(dirname(child.preparedPath)).toBe(join(root, 'relay-staging'));
      expect(child.argv).toContain(child.rawPath);
      expect(child.argv).not.toContain(child.preparedPath);
      expect(child.preparedPath.startsWith(`${outbox}/`)).toBe(false);

      expect(existsSync(join(outbox, reqName))).toBe(false);
      expect(existsSync(child.rawPath)).toBe(false);
      expect(existsSync(child.preparedPath)).toBe(false);
      expect(readdirSync(join(root, 'relay-staging'))).toEqual([]);
    } finally {
      stop();
    }
  });

  it('never promotes sandbox-supplied origin fields without host authorization (fail closed)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-relay-forged-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);

    const fixture = join(root, 'origin-echo.mjs');
    writeFileSync(fixture, `
      process.stdout.write(JSON.stringify({
        authorized: process.env.BOTMUX_HOST_RELAY_AUTHORIZED ?? null,
        turnId: process.env.BOTMUX_TURN_ID ?? null,
        dispatchAttempt: process.env.BOTMUX_DISPATCH_ATTEMPT ?? null,
        sessionId: process.env.BOTMUX_SESSION_ID ?? null,
      }));
    `);

    const id = 'forged-1';
    writeFileSync(join(outbox, `${id}.content`), 'RAW');
    writeFileSync(join(outbox, `${id}.req.json`), JSON.stringify({
      contentFile: `${id}.content`,
      flags: ['--no-mention'],
      // Sandbox-forged durable origin — the sandbox controls every byte here and
      // must never have it promoted to a trusted origin without a host authorize.
      originTurnId: 'forged-turn',
      originDispatchAttempt: 99,
    }));

    // baseEnv also carries stale/inherited trust markers that must be scrubbed.
    const stop = startOutboxWatcher(outbox, {
      ...process.env,
      BOTMUX_TURN_ID: 'stale-inherited-turn',
      BOTMUX_DISPATCH_ATTEMPT: '7',
      BOTMUX_HOST_RELAY_AUTHORIZED: '',
    }, 'forced-session', { cliPath: fixture }); // deliberately no authorize hook

    try {
      const responsePath = join(outbox, `${id}.res.json`);
      await vi.waitFor(() => expect(existsSync(responsePath)).toBe(true), { timeout: 5_000 });
      const response = JSON.parse(readFileSync(responsePath, 'utf8')) as { code: number; stdout: string; stderr: string };
      expect(response.code, response.stderr).toBe(0);
      const child = JSON.parse(response.stdout) as {
        authorized: string | null; turnId: string | null; dispatchAttempt: string | null; sessionId: string | null;
      };
      // The host re-exec itself is trusted, but with no authorize decision the
      // durable origin is dropped and inherited markers scrubbed — the forged
      // originTurnId/dispatchAttempt never reach the host send.
      expect(child.authorized).toBe('1');
      expect(child.turnId).toBeNull();
      expect(child.dispatchAttempt).toBeNull();
      expect(child.sessionId).toBe('forced-session');
    } finally {
      stop();
    }
  });

  it('rejects a relay whose claimed origin capability fails host authorization', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-relay-reject-'));
    roots.push(root);
    const outbox = join(root, 'outbox');
    mkdirSync(outbox);

    const fixture = join(root, 'should-not-run.mjs');
    writeFileSync(fixture, `process.stdout.write(JSON.stringify({ ran: true }));`);

    const id = 'reject-1';
    writeFileSync(join(outbox, `${id}.content`), 'RAW');
    writeFileSync(join(outbox, `${id}.req.json`), JSON.stringify({
      contentFile: `${id}.content`,
      flags: ['--no-mention'],
      originCapability: 'deadbeef'.repeat(4), // 32-char hex, but the host rejects it
    }));

    const authorize = vi.fn(() => ({ ok: false as const, error: 'origin_mismatch: relay capability is stale' }));
    const stop = startOutboxWatcher(outbox, { ...process.env }, 'forced-session', { cliPath: fixture, authorize });

    try {
      const responsePath = join(outbox, `${id}.res.json`);
      await vi.waitFor(() => expect(existsSync(responsePath)).toBe(true), { timeout: 5_000 });
      const response = JSON.parse(readFileSync(responsePath, 'utf8')) as { code: number; stdout: string; stderr: string };
      // Rejected before any host child is spawned; the fixture never runs.
      expect(response.code).toBe(2);
      expect(response.stdout).toBe('');
      expect(response.stderr).toContain('relay rejected');
      expect(authorize).toHaveBeenCalledWith({ capability: 'deadbeef'.repeat(4) });
    } finally {
      stop();
    }
  });
});
