import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tsRunnerPrefix, tsEvalArgs } from './helpers/ts-runner.js';
import { __setLoopbackTransportForTests } from '../src/core/loopback-fetch.js';

import {
  filterMatches,
  emitHookEvent,
  emitHookEventLocal,
  evaluatePromptGate,
  forwardEmitToDaemon,
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

describe('managed hook forwarding', () => {
  it('uses only the frozen protected port and exact original tuple', async () => {
    // The forwarder deliberately uses the proxy-immune loopback transport (node:http),
    // so stubbing `globalThis.fetch` no longer intercepts it — that stub made the
    // test open a REAL connection to port 4310 and record zero calls. Inject the
    // transport seam instead; the assertions below are unchanged.
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    const originalTransport = __setLoopbackTransportForTests(fetchMock as never);
    try {
      await forwardEmitToDaemon(
        'outbound.send',
        { event: 'outbound.send', content: 'old payload' },
        'poisoned-discovery-app',
        {
          ipcPort: 4310,
          sessionId: 'sid-original',
          capability: 'ab'.repeat(32),
          turnId: 'turn-original',
          dispatchAttempt: 3,
        },
      );
    } finally {
      __setLoopbackTransportForTests(originalTransport);
    }

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://127.0.0.1:4310/api/hooks/emit');
    expect(JSON.parse(String((init as RequestInit).body))).toMatchObject({
      sessionId: 'sid-original',
      originCapability: 'ab'.repeat(32),
      originTurnId: 'turn-original',
      originDispatchAttempt: 3,
    });
  });

  it('forwards managed origin even when session env is blank instead of running local hooks', async () => {
    const marker = join(tmpDir, 'must-not-run-local');
    const oldSession = process.env.BOTMUX_SESSION_ID;
    const oldApp = process.env.BOTMUX_LARK_APP_ID;
    const oldHooks = process.env.BOTMUX_HOOKS_JSON;
    const fetchMock = vi.fn(async () => new Response(null, { status: 202 }));
    process.env.BOTMUX_SESSION_ID = '';
    process.env.BOTMUX_LARK_APP_ID = '';
    process.env.BOTMUX_HOOKS_JSON = JSON.stringify([
      { event: 'outbound.send', command: `/usr/bin/touch ${marker}` },
    ]);
    // Same reason as above: intercept the loopback transport, not globalThis.fetch.
    const originalTransport = __setLoopbackTransportForTests(fetchMock as never);
    try {
      emitHookEvent('outbound.send', { content: 'managed' }, {
        managedOrigin: {
          ipcPort: 4311,
          sessionId: 'sid-managed',
          capability: 'cd'.repeat(32),
          turnId: 'turn-managed',
        },
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await new Promise(resolve => setTimeout(resolve, 25));
      expect(existsSync(marker)).toBe(false);
    } finally {
      __setLoopbackTransportForTests(originalTransport);
      if (oldSession === undefined) delete process.env.BOTMUX_SESSION_ID;
      else process.env.BOTMUX_SESSION_ID = oldSession;
      if (oldApp === undefined) delete process.env.BOTMUX_LARK_APP_ID;
      else process.env.BOTMUX_LARK_APP_ID = oldApp;
      if (oldHooks === undefined) delete process.env.BOTMUX_HOOKS_JSON;
      else process.env.BOTMUX_HOOKS_JSON = oldHooks;
    }
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
    // Node needs `--import tsx` on top of the eval args because the snippet
    // imports a repo .ts module; Bun runs TypeScript natively.
    const { command, prefixArgs } = tsRunnerPrefix();
    const result = spawnSync(
      command,
      [
        ...prefixArgs,
        ...tsEvalArgs(
          [
            "const { emitHookEvent } = await import('./src/services/hook-runner.ts');",
            "emitHookEvent('outbound.send', { content: 'hello' });",
          ].join('\n'),
        ).args,
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
    const { command, prefixArgs } = tsRunnerPrefix();
    const result = spawnSync(
      command,
      [
        ...prefixArgs,
        ...tsEvalArgs(
          [
            "const { emitHookEventLocal } = await import('./src/services/hook-runner.ts');",
            "emitHookEventLocal('outbound.send', { content: 'hi' });",
          ].join('\n'),
        ).args,
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
    const { command, prefixArgs } = tsRunnerPrefix();
    const result = spawnSync(
      command,
      [
        ...prefixArgs,
        ...tsEvalArgs(
          [
            "const { emitHookEvent } = await import('./src/services/hook-runner.ts');",
            "emitHookEvent('outbound.send', { content: 'hi' });",
          ].join('\n'),
        ).args,
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

// ─── 同步前置校验闸（sync gate hooks） ──────────────────────────────────────

describe('sync gate hooks (prompt.submit)', () => {
  /** 写一个按参数决定行为的 hook 脚本，返回可直接放进 command 的路径。 */
  function writeHook(name: string, body: string): string {
    const script = join(tmpDir, name);
    writeFileSync(script, body);
    return `${process.execPath} ${script}`;
  }

  function gateHooks(hooks: HookConfig[]): void {
    process.env.BOTMUX_HOOKS_JSON = JSON.stringify(hooks);
  }

  afterEach(() => {
    delete process.env.BOTMUX_HOOKS_JSON;
  });

  it('allows when no sync hook is configured (zero spawn)', async () => {
    gateHooks([{ event: 'prompt.submit', command: '/bin/false', mode: 'async' }]);
    const decision = await evaluatePromptGate('prompt.submit', { content: 'hi' });
    expect(decision.allowed).toBe(true);
  });

  it('denies on a JSON verdict and surfaces the reason to the caller', async () => {
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('deny.js', `
        console.log(JSON.stringify({ decision: 'deny', reason: 'not on the allowlist' }));
      `),
    }]);
    const decision = await evaluatePromptGate('prompt.submit', { content: 'hi' });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('not on the allowlist');
  });

  it('allows on a JSON allow verdict', async () => {
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('allow.js', `console.log(JSON.stringify({ decision: 'allow' }));`),
    }]);
    expect((await evaluatePromptGate('prompt.submit', {})).allowed).toBe(true);
  });

  it('receives the prompt payload on stdin', async () => {
    const output = join(tmpDir, 'seen-payload.json');
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('capture.js', `
        import { writeFileSync } from 'node:fs';
        let input = '';
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', c => { input += c; });
        process.stdin.on('end', () => {
          writeFileSync(${JSON.stringify(output)}, input);
          console.log(JSON.stringify({ decision: 'allow' }));
        });
      `),
    }]);
    await evaluatePromptGate('prompt.submit', { content: 'review this', senderOpenId: 'ou_x' });
    expect(JSON.parse(readFileSync(output, 'utf-8'))).toMatchObject({
      event: 'prompt.submit',
      content: 'review this',
      senderOpenId: 'ou_x',
    });
  });

  it('falls back to the exit code when stdout carries no verdict', async () => {
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('exit1.js', `process.exit(1);`),
    }]);
    expect((await evaluatePromptGate('prompt.submit', {})).allowed).toBe(false);

    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('exit0.js', `process.exit(0);`),
    }]);
    expect((await evaluatePromptGate('prompt.submit', {})).allowed).toBe(true);
  });

  it('lets a stdout verdict win over a conflicting exit code (documented precedence)', async () => {
    // A checker that prints "allow" and then dies in its own cleanup still meant
    // allow. Documented in hooks.md as "stdout JSON takes precedence".
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('allow-then-crash.js', `
        console.log(JSON.stringify({ decision: 'allow' }));
        process.exit(3);
      `),
    }]);
    expect((await evaluatePromptGate('prompt.submit', {})).allowed).toBe(true);

    // ...and the reverse: exit 0 but an explicit deny on stdout still denies.
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('deny-then-ok.js', `
        console.log(JSON.stringify({ decision: 'deny', reason: 'policy' }));
        process.exit(0);
      `),
    }]);
    const denied = await evaluatePromptGate('prompt.submit', {});
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('policy');
  });

  it('ignores non-JSON chatter on stdout and uses the exit code', async () => {
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('chatty.js', `
        console.log('checking permissions...');
        process.exit(0);
      `),
    }]);
    expect((await evaluatePromptGate('prompt.submit', {})).allowed).toBe(true);
  });

  it('fails open on timeout by default, and closed when onError is deny', async () => {
    const hang = writeHook('hang.js', `setTimeout(() => {}, 60000);`);

    gateHooks([{ event: 'prompt.submit', mode: 'sync', command: hang, timeoutMs: 300 }]);
    const openDecision = await evaluatePromptGate('prompt.submit', {});
    expect(openDecision.allowed).toBe(true);
    expect(openDecision.fromError).toBe(true);

    gateHooks([{ event: 'prompt.submit', mode: 'sync', command: hang, timeoutMs: 300, onError: 'deny' }]);
    const closedDecision = await evaluatePromptGate('prompt.submit', {});
    expect(closedDecision.allowed).toBe(false);
    expect(closedDecision.fromError).toBe(true);
  });

  it('fails open when the hook binary does not exist', async () => {
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: join(tmpDir, 'definitely-not-here'),
    }]);
    const decision = await evaluatePromptGate('prompt.submit', {});
    expect(decision.allowed).toBe(true);
    expect(decision.fromError).toBe(true);
  });

  it('ANDs multiple sync hooks and short-circuits after the first deny', async () => {
    const secondRan = join(tmpDir, 'second-ran');
    gateHooks([
      {
        event: 'prompt.submit',
        mode: 'sync',
        command: writeHook('first-deny.js', `console.log(JSON.stringify({ decision: 'deny', reason: 'first' }));`),
      },
      {
        event: 'prompt.submit',
        mode: 'sync',
        command: writeHook('second.js', `
          import { writeFileSync } from 'node:fs';
          writeFileSync(${JSON.stringify(secondRan)}, 'ran');
          console.log(JSON.stringify({ decision: 'allow' }));
        `),
      },
    ]);
    const decision = await evaluatePromptGate('prompt.submit', {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('first');
    expect(existsSync(secondRan)).toBe(false);
  });

  it('requires every sync hook to allow', async () => {
    gateHooks([
      {
        event: 'prompt.submit',
        mode: 'sync',
        command: writeHook('ok.js', `console.log(JSON.stringify({ decision: 'allow' }));`),
      },
      {
        event: 'prompt.submit',
        mode: 'sync',
        command: writeHook('nope.js', `console.log(JSON.stringify({ decision: 'deny', reason: 'second' }));`),
      },
    ]);
    const decision = await evaluatePromptGate('prompt.submit', {});
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('second');
  });

  it('honours filters, so an unmatched sender is not adjudicated', async () => {
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('deny-all.js', `console.log(JSON.stringify({ decision: 'deny' }));`),
      filter: { senderOpenId: 'ou_someone_else' },
    }]);
    expect((await evaluatePromptGate('prompt.submit', { senderOpenId: 'ou_me' })).allowed).toBe(true);
    expect((await evaluatePromptGate('prompt.submit', { senderOpenId: 'ou_someone_else' })).allowed).toBe(false);
  });

  it('degrades mode:sync to async on non-gate events instead of pretending to block', () => {
    const hooks = loadHookConfigs({
      env: {
        BOTMUX_HOOKS_JSON: JSON.stringify([
          { event: 'session.start', command: '/bin/true', mode: 'sync' },
          { event: 'prompt.submit', command: '/bin/true', mode: 'sync' },
        ]),
      },
    });
    expect(hooks.find(h => h.event === 'session.start')?.mode).toBe('async');
    expect(hooks.find(h => h.event === 'prompt.submit')?.mode).toBe('sync');
  });

  it('never runs a sync gate hook a second time as a fire-and-forget notification', async () => {
    // emitHookEventLocal, NOT emitHookEvent: this test process inherits
    // BOTMUX_SESSION_ID/BOTMUX_LARK_APP_ID from the botmux session running it,
    // so emitHookEvent takes the forward-to-daemon branch and spawns nothing
    // locally — the assertion would pass no matter what the dedup filter did.
    // (Verified: mutating away `hook.mode !== 'sync'` left the old version green.)
    const marker = join(tmpDir, 'notify-ran');
    const dup = `${marker}.dup`;
    gateHooks([{
      event: 'prompt.submit',
      mode: 'sync',
      command: writeHook('gate-once.js', `
        import { writeFileSync, existsSync } from 'node:fs';
        writeFileSync(existsSync(${JSON.stringify(marker)}) ? ${JSON.stringify(dup)} : ${JSON.stringify(marker)}, 'x');
        console.log(JSON.stringify({ decision: 'allow' }));
      `),
    }]);
    await evaluatePromptGate('prompt.submit', {});
    expect(existsSync(marker)).toBe(true);

    emitHookEventLocal('prompt.submit', {});
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(existsSync(dup)).toBe(false);
  });

  it('still runs async hooks on a gate event (the dedup filter is sync-only)', async () => {
    const ran = join(tmpDir, 'async-on-gate-event');
    gateHooks([{
      event: 'prompt.submit',
      mode: 'async',
      command: writeHook('async-notify.js', `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(ran)}, 'x');
      `),
    }]);
    emitHookEventLocal('prompt.submit', {});
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(existsSync(ran)).toBe(true);
  });

  it('captures stdout only for sync hooks', async () => {
    const talker: HookConfig = {
      event: 'prompt.submit',
      command: writeHook('talker.js', `console.log('some output'); process.exit(0);`),
    };
    const captured = await runHookCommandForTest(talker, { event: 'prompt.submit' }, { captureStdout: true });
    expect(captured.stdout).toContain('some output');

    const ignored = await runHookCommandForTest(talker, { event: 'prompt.submit' });
    expect(ignored.stdout ?? '').toBe('');
  });
});
