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
});
