import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startOutboxWatcher } from '../src/adapters/backend/sandbox.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

const roots: string[] = [];
const refId = 'lr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const placeholder = `{{botmux_link:${refId}}}`;
const unknownPlaceholder = '{{botmux_link:lr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb}}';
const exactUrl = 'https://auth.example.test/approve';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setupRelay() {
  const root = mkdtempSync(join(tmpdir(), 'botmux-sandbox-link-ref-'));
  roots.push(root);
  const outbox = join(root, 'outbox');
  const dataDir = join(root, 'data');
  const sessionId = 'sid_sandbox_link_ref';
  const turnId = 'om_sandbox_link_ref';
  const botsPath = join(root, 'bots.json');
  mkdirSync(outbox);
  mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
  writeFileSync(join(dataDir, '.botmux-cli-pids', String(process.pid)), JSON.stringify({
    sessionId,
    turnId,
  }));
  writeFileSync(botsPath, JSON.stringify([{
    larkAppId: 'cli_sandbox_link_ref',
    larkAppSecret: 'test-secret',
    cliId: 'codex',
    replyCardMode: 'legacy',
  }]));
  seedPersistedSessionRows(dataDir, 'cli_sandbox_link_ref', {
    [sessionId]: {
      sessionId,
      status: 'active',
      cliId: 'codex',
      larkAppId: 'cli_sandbox_link_ref',
      chatId: 'oc_test',
      rootMessageId: 'om_root',
      scope: 'thread',
      chatType: 'group',
      workingDir: root,
      pid: process.pid,
    },
  });

  const fixture = resolve('test/fixtures/send-reply-card-capture.ts');
  const tsxApi = resolve('node_modules/tsx/dist/esm/api/index.mjs');
  const wrapper = join(root, 'host-send.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node
process.stdout.write('HOST_ENV=' + JSON.stringify({
  adminMode: process.env.BOTMUX_LINK_REFS_MODE ?? null,
  turnMode: process.env.BOTMUX_LINK_REF_TURN_MODE ?? null,
}) + '\\n');
const fixture = ${JSON.stringify(pathToFileURL(fixture).href)};
if (typeof Bun !== 'undefined') {
  await import(fixture);
} else {
  const { tsImport } = await import(${JSON.stringify(pathToFileURL(tsxApi).href)});
  await tsImport(fixture, import.meta.url);
}
`);
  chmodSync(wrapper, 0o755);
  return { root, outbox, dataDir, sessionId, turnId, botsPath, wrapper };
}

async function waitForResponse(outbox: string, id: string) {
  const responsePath = join(outbox, `${id}.res.json`);
  await vi.waitFor(() => expect(existsSync(responsePath)).toBe(true), { timeout: 15_000 });
  return JSON.parse(readFileSync(responsePath, 'utf8')) as {
    code: number;
    stdout: string;
    stderr: string;
  };
}

describe('sandbox relay LinkRef handoff', () => {
  it('uses only the authorized frozen mode and expands before the provider call', async () => {
    const state = setupRelay();
    const id = 'enabled';
    writeFileSync(join(state.outbox, `${id}.content`), `授权：${placeholder}`);
    writeFileSync(join(state.outbox, `${id}.req.json`), JSON.stringify({
      contentFile: `${id}.content`,
      flags: ['--no-mention', '--response-kind', 'auxiliary'],
      originCapability: 'a'.repeat(64),
      linkRefMode: 'disabled',
      linkRefMapping: { [refId]: 'https://attacker.invalid/' },
    }));
    const authorize = vi.fn(() => ({
      ok: true as const,
      origin: { turnId: state.turnId, linkRefMode: 'enabled' as const },
    }));
    const stop = startOutboxWatcher(state.outbox, {
      PATH: process.env.PATH,
      HOME: state.root,
      SESSION_DATA_DIR: state.dataDir,
      BOTS_CONFIG: state.botsPath,
      BOTMUX_LARK_APP_ID: 'cli_sandbox_link_ref',
      BOTMUX_DAEMON_IPC_PORT: '7951',
      BOTMUX_LINK_REFS_MODE: 'enabled',
      BOTMUX_LINK_REF_TURN_MODE: 'disabled',
      BOTMUX_TEST_LINK_REF_ID: refId,
      BOTMUX_TEST_LINK_REF_URL: exactUrl,
    }, state.sessionId, { cliPath: state.wrapper, authorize });

    try {
      const response = await waitForResponse(state.outbox, id);
      expect(response.code, response.stderr).toBe(0);
      expect(authorize).toHaveBeenCalledWith({ capability: 'a'.repeat(64) });
      const lines = response.stdout.split('\n');
      expect(lines.find(line => line.startsWith('HOST_ENV='))).toBe(
        'HOST_ENV={"adminMode":null,"turnMode":"enabled"}',
      );
      const replies = lines.filter(line => line.startsWith('CAPTURE_REPLY='));
      expect(replies).toHaveLength(1);
      expect(replies[0]).toContain(exactUrl);
      expect(replies[0]).not.toContain(placeholder);
      expect(response.stdout).not.toContain('attacker.invalid');
    } finally {
      stop();
    }
  });

  it('returns exit 2 for an unknown ref before the provider call', async () => {
    const state = setupRelay();
    const id = 'unknown';
    writeFileSync(join(state.outbox, `${id}.content`), `授权：${unknownPlaceholder}`);
    writeFileSync(join(state.outbox, `${id}.req.json`), JSON.stringify({
      contentFile: `${id}.content`,
      flags: ['--no-mention', '--response-kind', 'auxiliary'],
      originCapability: 'b'.repeat(64),
    }));
    const stop = startOutboxWatcher(state.outbox, {
      PATH: process.env.PATH,
      HOME: state.root,
      SESSION_DATA_DIR: state.dataDir,
      BOTS_CONFIG: state.botsPath,
      BOTMUX_LARK_APP_ID: 'cli_sandbox_link_ref',
      BOTMUX_DAEMON_IPC_PORT: '7951',
      BOTMUX_TEST_LINK_REF_ID: refId,
      BOTMUX_TEST_LINK_REF_URL: exactUrl,
    }, state.sessionId, {
      cliPath: state.wrapper,
      authorize: () => ({
        ok: true as const,
        origin: { turnId: state.turnId, linkRefMode: 'enabled' as const },
      }),
    });

    try {
      const response = await waitForResponse(state.outbox, id);
      expect(response.code).toBe(2);
      expect(response.stderr).toContain('botmux send refused: link_ref_unknown');
      expect(response.stdout).not.toContain('CAPTURE_REPLY=');
    } finally {
      stop();
    }
  });

  it('scrubs both mode variables when the authorized turn is disabled', async () => {
    const state = setupRelay();
    const id = 'disabled';
    const echo = join(state.root, 'env-echo.mjs');
    writeFileSync(echo, `process.stdout.write(JSON.stringify({
      argv: process.argv.slice(2),
      adminMode: process.env.BOTMUX_LINK_REFS_MODE ?? null,
      turnMode: process.env.BOTMUX_LINK_REF_TURN_MODE ?? null,
    }));`);
    writeFileSync(join(state.outbox, `${id}.content`), 'plain content');
    writeFileSync(join(state.outbox, `${id}.req.json`), JSON.stringify({
      contentFile: `${id}.content`,
      flags: ['--no-mention'],
      originCapability: 'c'.repeat(64),
      linkRefMode: 'enabled',
    }));
    const stop = startOutboxWatcher(state.outbox, {
      PATH: process.env.PATH,
      BOTMUX_LINK_REFS_MODE: 'enabled',
      BOTMUX_LINK_REF_TURN_MODE: 'enabled',
    }, state.sessionId, {
      cliPath: echo,
      authorize: () => ({ ok: true as const, origin: { turnId: state.turnId } }),
    });

    try {
      const response = await waitForResponse(state.outbox, id);
      expect(response.code, response.stderr).toBe(0);
      const observed = JSON.parse(response.stdout) as {
        argv: string[];
        adminMode: string | null;
        turnMode: string | null;
      };
      expect(observed.adminMode).toBeNull();
      expect(observed.turnMode).toBeNull();
      expect(observed.argv).toEqual([
        'send', '--no-mention', '--content-file', expect.any(String),
        '--session-id', state.sessionId,
      ]);
    } finally {
      stop();
    }
  });
});
