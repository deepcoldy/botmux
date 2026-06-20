import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  filterMatches,
  loadHookConfigs,
  parseHookCommand,
  prepareHookPayload,
  runHookCommandForTest,
  type HookConfig,
} from '../src/services/hook-runner.js';

let tmpDir = '';

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'botmux-hooks-'));
});

afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = '';
});

describe('parseHookCommand', () => {
  it('splits command strings without invoking a shell', () => {
    expect(parseHookCommand('/usr/bin/env node "two words"')).toEqual({
      file: '/usr/bin/env',
      args: ['node', 'two words'],
    });
  });

  it('rejects empty or malformed command strings', () => {
    expect(() => parseHookCommand('')).toThrow(/empty/i);
    expect(() => parseHookCommand('node "unterminated')).toThrow(/unterminated/i);
  });
});

describe('loadHookConfigs', () => {
  it('loads hooks from hooks.json under the data dir', () => {
    const hooks: HookConfig[] = [
      { event: 'topic.new', command: '/bin/echo topic', timeoutMs: 1000 },
    ];
    writeFileSync(join(tmpDir, 'hooks.json'), JSON.stringify(hooks));

    expect(loadHookConfigs({ dataDir: tmpDir, env: {} })).toEqual(hooks);
  });

  it('lets BOTMUX_HOOKS_JSON override hooks.json', () => {
    writeFileSync(join(tmpDir, 'hooks.json'), JSON.stringify([
      { event: 'topic.new', command: '/bin/echo file' },
    ]));

    expect(loadHookConfigs({
      dataDir: tmpDir,
      env: {
        BOTMUX_HOOKS_JSON: JSON.stringify([
          { event: 'thread.reply', command: '/bin/echo env' },
        ]),
      },
    })).toEqual([{ event: 'thread.reply', command: '/bin/echo env' }]);
  });

  it('drops invalid entries and keeps valid ones', () => {
    writeFileSync(join(tmpDir, 'hooks.json'), JSON.stringify([
      { event: 'unknown', command: '/bin/echo no' },
      { event: 'outbound.send', command: '' },
      { event: 'outbound.reply', command: '/bin/echo ok', timeoutMs: -1 },
    ]));

    expect(loadHookConfigs({ dataDir: tmpDir, env: {} })).toEqual([
      { event: 'outbound.reply', command: '/bin/echo ok', timeoutMs: -1 },
    ]);
  });

  it('normalizes redact full-content allowlist entries', () => {
    writeFileSync(join(tmpDir, 'hooks.json'), JSON.stringify([
      {
        event: 'session.requires_attention',
        command: '/bin/echo attention',
        redact: { fullContentEvents: ['session.requires_attention', 'unknown'] },
      },
    ]));

    expect(loadHookConfigs({ dataDir: tmpDir, env: {} })).toEqual([
      {
        event: 'session.requires_attention',
        command: '/bin/echo attention',
        redact: { fullContentEvents: ['session.requires_attention'] },
      },
    ]);
  });
});

describe('prepareHookPayload', () => {
  it('truncates content-like fields by default and preserves length metadata', () => {
    const longContent = 'x'.repeat(650);

    const payload = prepareHookPayload(
      { event: 'session.idle', command: '/bin/echo idle' },
      {
        event: 'session.idle',
        content: longContent,
        message: 'm'.repeat(601),
        description: 'short',
      },
    );

    expect(payload.content).toHaveLength(600);
    expect(payload.contentLength).toBe(650);
    expect(payload.contentTruncated).toBe(true);
    expect(payload.message).toHaveLength(600);
    expect(payload.messageLength).toBe(601);
    expect(payload.messageTruncated).toBe(true);
    expect(payload.description).toBe('short');
    expect(payload.descriptionLength).toBe(5);
    expect(payload.descriptionTruncated).toBe(false);
  });

  it('truncates long text/label in nested options array', () => {
    const longText = 'o'.repeat(700);
    const payload = prepareHookPayload(
      { event: 'session.requires_attention', command: '/bin/echo' },
      {
        event: 'session.requires_attention',
        options: [
          { text: longText, selected: false },
          { label: longText, value: 'x' },
          { text: 'short', selected: true },
        ],
      },
    );

    const opts = payload['options'] as Array<Record<string, unknown>>;
    expect((opts[0].text as string).length).toBe(600);
    expect((opts[1].label as string).length).toBe(600);
    expect(opts[2].text).toBe('short');
  });

  it('truncates long text/label in the real optionsPreview field too', () => {
    // Mirror the path actually emitted by worker-pool.ts tui_prompt
    // (`optionsPreview: ...`) — the previous fix only covered the synthetic
    // `options` alias, leaving the production emit shape unredacted.
    const longText = 'p'.repeat(700);
    const payload = prepareHookPayload(
      { event: 'session.requires_attention', command: '/bin/echo' },
      {
        event: 'session.requires_attention',
        optionsPreview: [
          { text: longText, selected: false },
          { label: longText, type: 'choice' },
          { text: 'fine', selected: true },
        ],
      },
    );

    const opts = payload['optionsPreview'] as Array<Record<string, unknown>>;
    expect((opts[0].text as string).length).toBe(600);
    expect((opts[1].label as string).length).toBe(600);
    expect(opts[2].text).toBe('fine');
  });

  it('keeps full content for allowlisted events', () => {
    const longContent = 'x'.repeat(650);

    const payload = prepareHookPayload(
      {
        event: 'session.requires_attention',
        command: '/bin/echo attention',
        redact: { fullContentEvents: ['session.requires_attention'] },
      },
      {
        event: 'session.requires_attention',
        content: longContent,
        message: 'm'.repeat(601),
      },
    );

    expect(payload.content).toBe(longContent);
    expect(payload.contentLength).toBe(650);
    expect(payload.contentTruncated).toBe(false);
    expect(payload.message).toBe('m'.repeat(601));
    expect(payload.messageLength).toBe(601);
    expect(payload.messageTruncated).toBe(false);
  });
});

describe('filterMatches', () => {
  it('matches chatId and senderOpenId filters', () => {
    const payload = { event: 'thread.reply' as const, chatId: 'oc_1', senderOpenId: 'ou_1' };

    expect(filterMatches({ chatId: 'oc_1', senderOpenId: 'ou_1' }, payload)).toBe(true);
    expect(filterMatches({ chatId: ['oc_2', 'oc_1'] }, payload)).toBe(true);
    expect(filterMatches({ senderOpenId: ['ou_2'] }, payload)).toBe(false);
    expect(filterMatches({ chatId: 'oc_2' }, payload)).toBe(false);
  });

  it('treats absent filters as a match', () => {
    expect(filterMatches(undefined, { event: 'schedule.fired', chatId: 'oc_1' })).toBe(true);
  });
});

describe('runHookCommandForTest', () => {
  it('writes the JSON payload to stdin and resolves without shell expansion', async () => {
    const script = join(tmpDir, 'stdin-writer.js');
    const output = join(tmpDir, 'payload.json');
    writeFileSync(script, `
      import { writeFileSync } from 'node:fs';
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => writeFileSync(process.argv[2], input));
    `);

    const result = await runHookCommandForTest(
      { event: 'outbound.send', command: `${process.execPath} ${script} ${output}` },
      { event: 'outbound.send', chatId: 'oc_1', messageId: 'om_1' },
    );

    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(output, 'utf-8'))).toMatchObject({
      event: 'outbound.send',
      chatId: 'oc_1',
      messageId: 'om_1',
    });
  });

  it('does not leak parent secrets into hook env', async () => {
    const script = join(tmpDir, 'env-dump.js');
    const output = join(tmpDir, 'env.json');
    writeFileSync(script, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(process.argv[2], JSON.stringify(process.env));
    `);

    process.env.LARK_APP_SECRET = 'super-secret';
    process.env.GITHUB_TOKEN = 'ghp_secret';

    await runHookCommandForTest(
      { event: 'outbound.send', command: `${process.execPath} ${script} ${output}` },
      { event: 'outbound.send' },
    );

    const env = JSON.parse(readFileSync(output, 'utf-8')) as Record<string, string>;
    expect(env.LARK_APP_SECRET).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.BOTMUX_HOOK_EVENT).toBe('outbound.send');
    expect(env.PATH).toBeDefined();

    delete process.env.LARK_APP_SECRET;
    delete process.env.GITHUB_TOKEN;
  });

  it('reports spawn failures without throwing', async () => {
    const result = await runHookCommandForTest(
      { event: 'topic.new', command: '/definitely/not/a/command' },
      { event: 'topic.new' },
    );

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/spawn/i);
  });

  it('kills timed-out hook processes', async () => {
    const script = join(tmpDir, 'hang.js');
    writeFileSync(script, 'setInterval(() => {}, 1000);');

    const started = Date.now();
    const result = await runHookCommandForTest(
      { event: 'schedule.fired', command: `${process.execPath} ${script}`, timeoutMs: 50 },
      { event: 'schedule.fired', status: 'ok' },
    );

    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('does not keep CLI-style emitHookEvent processes alive for running hooks', () => {
    const started = Date.now();
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        [
          "const { emitHookEvent } = await import('./src/services/hook-runner.ts');",
          "emitHookEvent('outbound.send', { content: 'hello' });",
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          BOTMUX_HOOKS_JSON: JSON.stringify([
            { event: 'outbound.send', command: '/bin/sleep 1', timeoutMs: 5000 },
          ]),
        },
        timeout: 2500,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('emitHookEventLocal spawns locally even when session env leaked into the process', async () => {
    // Regression guard for the daemon self-forward storm: the daemon's
    // /api/hooks/emit handler runs hooks via emitHookEventLocal, which must
    // execute locally and never re-enter the CLI forward gate — even when
    // session-scoped env leaked into the process (e.g. pm2 startOrRestart
    // injecting the caller's environment after an in-session `botmux restart`).
    const marker = join(tmpDir, 'daemon-local-spawn-touched');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        [
          "const { emitHookEventLocal } = await import('./src/services/hook-runner.ts');",
          "emitHookEventLocal('outbound.send', { content: 'hi' });",
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          BOTMUX_SESSION_ID: 'sid-leaked-into-daemon',
          BOTMUX_LARK_APP_ID: 'cli_leaked_into_daemon',
          BOTMUX_HOOKS_JSON: JSON.stringify([
            { event: 'outbound.send', command: `/usr/bin/touch ${marker}`, timeoutMs: 5000 },
          ]),
        },
        timeout: 5000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // fireAndForget lets the emitting process exit before the hook child
    // finishes — poll briefly for the marker instead of asserting instantly.
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    expect(existsSync(marker)).toBe(true);
  });

  it('CLI context forwards to daemon instead of spawning locally', () => {
    // Behavioural proof of the daemon-supervised path: when BOTMUX_SESSION_ID
    // and BOTMUX_LARK_APP_ID are set (CLI session), emitHookEvent forwards to
    // the daemon and does NOT spawn the hook locally. Here no daemon is
    // running, so findOnlineDaemon returns null and the forward silently
    // drops — the local-spawn marker file therefore must not appear.
    const marker = join(tmpDir, 'local-spawn-touched');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        [
          "const { emitHookEvent } = await import('./src/services/hook-runner.ts');",
          "emitHookEvent('outbound.send', { content: 'hi' });",
        ].join('\n'),
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        env: {
          ...process.env,
          BOTMUX_SESSION_ID: 'sid-forward-test',
          BOTMUX_LARK_APP_ID: 'cli_no_such_daemon',
          BOTMUX_HOOKS_JSON: JSON.stringify([
            { event: 'outbound.send', command: `/usr/bin/touch ${marker}`, timeoutMs: 5000 },
          ]),
        },
        timeout: 5000,
      },
    );

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    // Give any (unintended) spawned hook child a moment to land its file.
    expect(existsSync(marker)).toBe(false);
  });
});
