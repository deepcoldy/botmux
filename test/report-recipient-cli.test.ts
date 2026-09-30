import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';
import { RELAY_ORIGIN_CAPABILITY_BASENAME } from '../src/core/managed-origin-capability.js';

const APP_ID = 'cli_report_worker';
const REVIEWER = 'ou_report_reviewer';
const USER = 'ou_report_user';
const CHAT = 'oc_report_task';
const SEED = 'om_task_dispatch';
const THREAD = 'om_user_thread';
const CAPABILITY = 'ab'.repeat(32);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function runReport(options: {
  args?: string[];
  recipientRoot?: string;
  source?: Record<string, unknown>;
  current?: Record<string, unknown>;
  inlineContent?: boolean;
  peer?: 'missing' | 'other-app' | 'malformed' | 'global-only';
  ambiguous?: boolean;
  chatScope?: boolean;
  legacyThread?: boolean;
  turnPlacement?: 'thread' | 'quote' | 'top-level';
  relayStatus?: number;
  relayBody?: Record<string, unknown>;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'report-cli-'));
  roots.push(root);
  const home = join(root, 'home');
  const data = join(root, 'data');
  const context = join(root, 'context');
  const relay = join(root, 'relay');
  for (const dir of [home, data, context, relay]) mkdirSync(dir);
  const contentFile = join(context, 'review.txt');
  writeFileSync(contentFile, 'Ready for review');
  const source = {
    sessionId: 'source-chat', larkAppId: APP_ID, chatId: CHAT, rootMessageId: SEED,
    scope: 'chat', status: 'active', creatorOpenId: REVIEWER,
    createdAt: '2026-08-07T07:30:00.000Z', workingDir: root,
  };
  const current = {
    ...source, sessionId: 'current-thread', rootMessageId: THREAD, scope: options.legacyThread ? undefined : 'thread',
    creatorOpenId: USER, ownerOpenId: USER, quoteTargetSenderOpenId: USER,
    createdAt: '2026-08-07T07:45:00.000Z',
    currentReplyTarget: { rootMessageId: 'om_stale_topic', turnId: 'stale-turn' },
    ...(options.turnPlacement ? { replyTargets: { 'turn-report': {
      ...(options.turnPlacement === 'top-level' ? {} : { rootMessageId: 'om_live_target' }),
      ...(options.turnPlacement === 'quote' ? { quoteOnly: true } : {}),
      updatedAt: '2026-08-07T08:00:00.000Z',
    } } } : {}),
  };
  seedPersistedSessionRows(data, APP_ID, {
    [source.sessionId]: { ...source, replyTargets: current.replyTargets, currentReplyTarget: current.currentReplyTarget, ...options.source },
    [current.sessionId]: { ...current, ...options.current },
    ...(options.ambiguous ? { duplicate: { ...source, sessionId: 'duplicate', creatorOpenId: 'ou_other_human' } } : {}),
  });
  if (options.peer !== 'missing' && options.peer !== 'global-only') {
    writeFileSync(join(data, `bot-openids-${options.peer === 'other-app' ? 'cli_other' : APP_ID}.json`),
      options.peer === 'malformed' ? 'null' : JSON.stringify({ Reviewer: REVIEWER, CurrentPeer: 'ou_current_peer' }));
  }
  if (options.peer === 'global-only') {
    writeFileSync(join(data, 'bots-info.json'), JSON.stringify([
      { larkAppId: 'cli_reviewer', botName: 'Reviewer', botOpenId: REVIEWER },
    ]));
  }
  const config = join(root, 'bots.json');
  writeFileSync(config, '[]');
  writeFileSync(join(relay, RELAY_ORIGIN_CAPABILITY_BASENAME), JSON.stringify({
    token: CAPABILITY, turnId: 'turn-report', dispatchAttempt: 2,
  }), { mode: 0o600 });
  const requests: Array<{ url?: string; body: Record<string, unknown> }> = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, body: JSON.parse(body) });
    res.writeHead(options.relayStatus ?? 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(options.relayBody ?? { error: 'dispatch_target_unavailable' }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  if (options.turnPlacement) {
    const markers = join(data, '.botmux-cli-pids');
    mkdirSync(markers);
    writeFileSync(join(markers, String(process.pid)), JSON.stringify({ sessionId: options.chatScope ? source.sessionId : current.sessionId, turnId: 'turn-report' }));
  }
  const captureFile = join(root, 'outbound.json');
  const script = `
    import { writeFileSync } from 'node:fs';
    import { registerBot } from ${JSON.stringify(pathToFileURL(resolve('src/bot-registry.ts')).href)};
    const state = registerBot({ larkAppId: ${JSON.stringify(APP_ID)}, larkAppSecret: 'test-secret', cliId: 'claude-code', allowedUsers: [] });
    for (const method of ['create', 'reply']) {
      state.client.im.v1.message[method] = async request => {
        writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ method, request }));
        return { code: 0, data: { message_id: 'om_report_sent' } };
      };
    }
    process.argv = ['node', 'botmux', 'report', ...${JSON.stringify([
      '--session-id', options.chatScope ? source.sessionId : current.sessionId,
      ...(options.inlineContent ? ['Ready for review'] : ['--content-file', contentFile]),
      ...(options.recipientRoot === undefined ? [] : ['--recipient-root', options.recipientRoot]),
      ...(options.args ?? []),
    ])}];
    await import(${JSON.stringify(pathToFileURL(resolve('src/cli.ts')).href)});
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('BOTMUX_') && !['BOTS_CONFIG', 'SESSION_DATA_DIR'].includes(key)));
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawnTsEvalWithRepoImports(script, {
        env: {
          ...env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data, BOTS_CONFIG: config,
          BOTMUX_SEND_RELAY: relay,
          BOTMUX_DAEMON_IPC_PORT: String((server.address() as AddressInfo).port),
        },
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
      });
      let stdout = '';
      let stderr = '';
      child.stdout!.on('data', chunk => { stdout += chunk; });
      child.stderr!.on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', status => done({ status, stdout, stderr }));
    });
    const outputLine = result.stdout.split('\n').find(line => line.startsWith('{"success":'));
    return {
      ...result, output: outputLine ? JSON.parse(outputLine) : undefined, requests,
      outbound: existsSync(captureFile) ? JSON.parse(readFileSync(captureFile, 'utf8')) : undefined,
    };
  } finally {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
  }
}

function expectRecipient(result: Awaited<ReturnType<typeof runReport>>, openId: string) {
  if (result.status !== 0) console.error(result.stderr);
  expect(result.status).toBe(0);
  expect(result.output.recipient.openId).toBe(openId);
  const content = JSON.parse(result.outbound.request.data.content);
  expect(content.zh_cn.content.flat().filter((node: { tag: string }) => node.tag === 'at'))
    .toEqual([{ tag: 'at', user_id: openId }]);
}

describe('report CLI recipient root and authenticated relay', () => {
  it('mentions the task reviewer while staying in the user-created thread after implicit relay miss', async () => {
    const result = await runReport({ recipientRoot: SEED });
    expectRecipient(result, REVIEWER);
    expect(result.outbound).toMatchObject({ method: 'reply', request: { path: { message_id: THREAD }, data: { reply_in_thread: true } } });
    expect(result.output.messageTarget).toEqual({ mode: 'thread', rootMessageId: THREAD });
    expect(result.output.recipient).toMatchObject({ source: 'recipient-root-chat-creator', sourceSessionId: 'source-chat' });
    expect(result.requests).toEqual([{ url: '/api/report-relay', body: {
      sessionId: 'current-thread', dispatchRoot: THREAD, content: 'Ready for review',
      originCapability: CAPABILITY, originTurnId: 'turn-report', originDispatchAttempt: 2,
    } }]);
  });

  it('mentions the reviewer in a legacy thread whose persisted row omits scope', async () => {
    const result = await runReport({ legacyThread: true, recipientRoot: SEED });
    expectRecipient(result, REVIEWER);
    expect(result.output.recipient).toMatchObject({ source: 'recipient-root-chat-creator', sourceSessionId: 'source-chat' });
    expect(result.output.messageTarget).toEqual({ mode: 'thread', rootMessageId: THREAD });
    expect(result.outbound).toMatchObject({ method: 'reply', request: { path: { message_id: THREAD }, data: { reply_in_thread: true } } });
  });

  it('keeps the session creator without an explicit recipient root', async () => {
    expectRecipient(await runReport(), USER);
  });

  it('accepts an equals-form recipient root and inline content', async () => {
    const result = await runReport({ args: [`--recipient-root=${SEED}`], inlineContent: true });
    expectRecipient(result, REVIEWER);
    expect(result.requests[0].body.content).toBe('Ready for review');
  });

  it('preserves a current peer creator after validating the explicit source', async () => {
    const result = await runReport({ recipientRoot: SEED, current: { creatorOpenId: 'ou_current_peer' } });
    expectRecipient(result, 'ou_current_peer');
    expect(result.output.recipient.source).toBe('session-creator');
  });

  it.each([
    ['--recipient-root'], ['--recipient-root', '--top-level'], ['--recipient-root='],
    ['--recipient-root', ' '], ['--recipient-root', '-'], ['--recipient-root', 'invalid'],
    ['--recipient-root', 'om_'], [`--recipient-root=om_${'x'.repeat(129)}`],
    ['--recipient-root', SEED, '--recipient-root=invalid'],
    ['--recipient-root', SEED, '--recipient-root'],
    ['--recipient-root', SEED, `--recipient-root=${SEED}`],
  ])('rejects malformed recipient arguments before delivery: %j', async (...args) => {
    const result = await runReport({ args });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--recipient-root');
    expect(result.requests).toHaveLength(0);
    expect(result.outbound).toBeUndefined();
  });

  it.each(['missing', 'other-app', 'malformed', 'global-only'] as const)('requires sender-scoped peer identity: %s', async peer => {
    const result = await runReport({ peer, recipientRoot: SEED });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--recipient-root');
    expect(result.requests).toHaveLength(0);
    expect(result.outbound).toBeUndefined();
  });

  it.each([
    { rootMessageId: 'om_other' }, { larkAppId: 'cli_other' }, { chatId: 'oc_other' },
    { createdAt: '2026-08-07T07:45:00.000Z' }, { createdAt: '2026-08-08T00:00:00.000Z' },
    { createdAt: 'invalid' }, { status: 'closed' }, { scope: 'thread' }, { scope: undefined },
    { creatorOpenId: USER },
  ])('rejects an invalid source before delivery: %j', async source => {
    const result = await runReport({ source, recipientRoot: SEED });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--recipient-root');
    expect(result.requests).toHaveLength(0);
    expect(result.outbound).toBeUndefined();
  });

  it.each([{ status: 'closed' }, { scope: 'chat' }])('rejects an invalid current session: %j', async current => {
    const result = await runReport({ current, recipientRoot: SEED });
    expect(result.status).toBe(1);
    expect(result.requests).toHaveLength(0);
    expect(result.outbound).toBeUndefined();
  });

  it('does not hide an ambiguous human source behind a verified peer', async () => {
    const result = await runReport({ ambiguous: true, recipientRoot: SEED });
    expect(result.status).toBe(1);
    expect(result.requests).toHaveLength(0);
    expect(result.outbound).toBeUndefined();
  });

  it.each([
    { args: [] }, { args: ['--top-level'] }, { args: ['--into', 'om_explicit'] },
    { args: ['--legacy-dispatch'] }, { args: ['--dispatch-root', SEED] },
  ])(
    'does not downgrade an unmatched recipient root via placement or relay: %j', async ({ args }) => {
      const result = await runReport({ args, recipientRoot: 'om_missing', relayStatus: 200, relayBody: { ok: true } });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--recipient-root');
      expect(result.requests).toHaveLength(0);
      expect(result.outbound).toBeUndefined();
    },
  );

  it.each([
    ['explicit top level', ['--top-level'], 'plain'],
    ['explicit topic', ['--into', 'om_explicit'], 'thread'],
    ['legacy fallback', ['--legacy-dispatch'], 'plain'],
  ])('keeps recipient independent of %s placement', async (_label, args, mode) => {
    const result = await runReport({ args: args as string[], recipientRoot: SEED });
    expectRecipient(result, REVIEWER);
    if (mode === 'plain') {
      expect(result.outbound).toMatchObject({ method: 'create', request: { data: { receive_id: CHAT } } });
    } else {
      expect(result.outbound).toMatchObject({ method: 'reply', request: { path: { message_id: 'om_explicit' } } });
    }
    expect(result.requests).toHaveLength(args.includes('--legacy-dispatch') ? 1 : 0);
  });

  it.each(['thread', 'quote', 'top-level'] as const)('honors the chat session live turn %s placement without changing recipient', async turnPlacement => {
    const result = await runReport({ turnPlacement, chatScope: true });
    expectRecipient(result, REVIEWER);
    expect(result.output.placementSource).toBe('current-turn');
    expect(result.output.messageTarget).toEqual(turnPlacement === 'top-level'
      ? { mode: 'top-level', chatId: CHAT }
      : { mode: turnPlacement, rootMessageId: 'om_live_target' });
    if (turnPlacement !== 'top-level') {
      expect(result.outbound.request.data.reply_in_thread).toBe(turnPlacement === 'thread' ? true : undefined);
    }
  });

  it('keeps thread-session placement anchored even with another live turn target', async () => {
    const result = await runReport({ turnPlacement: 'thread', recipientRoot: SEED });
    expectRecipient(result, REVIEWER);
    expect(result.output.placementSource).toBe('current-turn');
    expect(result.output.messageTarget).toEqual({ mode: 'thread', rootMessageId: THREAD });
  });

  it('keeps original chat reports at the top level', async () => {
    const result = await runReport({ chatScope: true });
    expectRecipient(result, REVIEWER);
    expect(result.outbound.method).toBe('create');
    expect(result.requests).toHaveLength(0);
  });

  it('keeps recipient root independent of an explicit relay root', async () => {
    const result = await runReport({ recipientRoot: SEED, args: ['--dispatch-root', 'om_relay_seed'], relayStatus: 200, relayBody: {
      ok: true, triggerId: 'trigger-report', reportTarget: { sessionId: 'orchestrator', larkAppId: 'cli_reviewer' },
    } });
    expect(result.status).toBe(0);
    expect(result.requests[0].body.dispatchRoot).toBe('om_relay_seed');
    expect(result.output.recipient.openId).toBe(REVIEWER);
    expect(result.outbound).toBeUndefined();
  });

  it('retains authenticated orchestrator relay without a Lark fallback', async () => {
    const result = await runReport({ recipientRoot: SEED, relayStatus: 200, relayBody: {
      ok: true, triggerId: 'trigger-report', reportTarget: { sessionId: 'orchestrator', larkAppId: 'cli_reviewer' },
    } });
    if (result.status !== 0) console.error(result.stderr);
    expect(result.status).toBe(0);
    expect(result.output).toMatchObject({ delivery: 'orchestrator-session', viaRegistry: true, reportedTo: 'orchestrator' });
    expect(result.outbound).toBeUndefined();
  });

  it.each([
    { relayStatus: 403, relayBody: { error: 'invalid_origin_capability' } },
    { relayStatus: 404, args: ['--dispatch-root', SEED] },
  ])('does not downgrade rejected or explicit relay requests: %j', async options => {
    const result = await runReport({ ...options, recipientRoot: SEED });
    expect(result.status).toBe(1);
    expect(result.outbound).toBeUndefined();
    expect(result.requests).toHaveLength(1);
  });
});
