/**
 * `botmux dispatch --into ROOT --bot OU --repo WT --standby`: put a fresh
 * session in an existing topic, in directory WT, by sending the same
 * `@bot /repo WT` text a new --standby topic gets. Real CLI process; the Lark
 * client and the daemon IPC are fixtures (as in cli-dispatch-prime-topic.test.ts),
 * so what is pinned here is the command's own behaviour: what it sends, where,
 * and what it refuses — not the receiving daemon's /repo handling.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const APP = 'cli_into_source';
const ORIGIN_ROOT = 'om_origin_topic';
const TURN = 'om_current_command';
const TARGET_ROOT = 'om_existing_topic';
const NEW_SEED = 'om_new_seed';
const DEST_CHAT = 'oc_destination';
const BOT = 'ou_sub_bot';
const WORKTREE = '/work/feature-wt';

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
  calls: string[];
  reads: string[];
  writes: Array<{ path: { message_id: string }; data: { content: string; msg_type: string; reply_in_thread?: boolean } }>;
  json: any;
  /** orchestrate-dispatch.json after the run (seeded with an accepted dispatch on TARGET_ROOT). */
  registry: Record<string, any>;
}

async function dispatch(args: string[], options: { rootChat?: string } = {}): Promise<Run> {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-into-standby-'));
  const data = join(root, 'data'); const home = join(root, 'home');
  for (const p of [data, home, join(data, '.botmux-cli-pids')]) mkdirSync(p, { recursive: true });
  const current = {
    sessionId: 'current', larkAppId: APP, chatId: 'oc_origin', rootMessageId: ORIGIN_ROOT, scope: 'thread',
    status: 'active', ownerOpenId: 'ou_owner', createdAt: '2026-08-07T07:30:00.000Z', workingDir: root,
    currentReplyTarget: { rootMessageId: 'om_stale', turnId: 'stale' },
    replyTargets: { 'turn-prime': { rootMessageId: TURN, quoteOnly: true, updatedAt: '2026-08-07T08:00:00.000Z' } },
  };
  seedPersistedSessionRows(data, APP, { current });
  writeFileSync(join(data, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'current', turnId: 'turn-prime' }));
  const registryPath = join(data, 'orchestrate-dispatch.json');
  writeFileSync(registryPath, JSON.stringify({ [TARGET_ROOT]: {
    orchSessionId: 'current', status: 'accepted', transportState: 'dispatched', acceptanceState: 'accepted', errorCode: null,
  } }));
  const configs = join(root, 'bots.json'); writeFileSync(configs, '[]');
  const calls: string[] = [];
  // Stands in for already-covered daemon admission (project policy, report
  // binding, user-delivery): it records which routes the command touched.
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end('{}'); return; }
    for await (const _chunk of req) { /* consume body */ }
    calls.push(req.url!);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dispatchRoot: NEW_SEED, messageId: 'om_kickoff' }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const capture = join(root, 'capture.json');
  const code = `
    import { writeFileSync } from 'node:fs';
    import { registerBot } from ${JSON.stringify(pathToFileURL(resolve('src/bot-registry.ts')).href)};
    const state = registerBot({ larkAppId: ${JSON.stringify(APP)}, larkAppSecret: 'fake', cliId: 'claude-code', allowedUsers: [], topicUnavailablePolicy: 'stop' });
    const reads = [], writes = [];
    const save = () => writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ reads, writes }));
    const chatOf = id => id === ${JSON.stringify(TARGET_ROOT)} ? ${JSON.stringify(options.rootChat ?? DEST_CHAT)} : ${JSON.stringify(DEST_CHAT)};
    state.client.request = async ({ method, url }) => {
      if (method !== 'GET' || !url.includes('/im/v1/messages/')) throw new Error('Unexpected request');
      const id = url.split('/').at(-1); reads.push(id); save();
      return { code: 0, data: { items: [{ message_id: id, chat_id: chatOf(id), deleted: false,
        ...(id === ${JSON.stringify(TARGET_ROOT)} ? { thread_id: 'omt_existing' } : {}),
        ...(id === ${JSON.stringify(TURN)} ? { root_id: ${JSON.stringify(ORIGIN_ROOT)} } : {}),
      }] } };
    };
    state.client.im.v1.message.reply = async request => {
      writes.push(request); save();
      return { code: 0, data: { message_id: 'om_prime_sent' } };
    };
    process.argv = ['node', 'botmux', 'dispatch', ...${JSON.stringify(args)}];
    await import(${JSON.stringify(pathToFileURL(resolve('src/cli.ts')).href)});
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('BOTMUX_') && !['BOTS_CONFIG', 'SESSION_DATA_DIR'].includes(key)));
  try {
    const result = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done, reject) => {
      const child = spawnTsEvalWithRepoImports(code, { env: { ...env, HOME: home, USERPROFILE: home, SESSION_DATA_DIR: data,
        BOTS_CONFIG: configs, BOTMUX_LARK_GATE_RETRY_BASE_MS: '1',
        BOTMUX_DAEMON_IPC_PORT: String((server.address() as AddressInfo).port) }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 });
      let stdout = ''; let stderr = '';
      child.stdout!.on('data', chunk => { stdout += chunk; }); child.stderr!.on('data', chunk => { stderr += chunk; });
      child.once('error', reject); child.once('close', status => done({ status, stdout, stderr }));
    });
    const captured = existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : { reads: [], writes: [] };
    let json: any;
    try { json = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? ''); } catch { json = undefined; }
    return { ...result, calls, ...captured, json, registry: JSON.parse(readFileSync(registryPath, 'utf8')) };
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); }
}

const intoFresh = ['--into', TARGET_ROOT, '--bot', BOT, '--repo', WORKTREE, '--standby', '--chat-id', DEST_CHAT];
const textOf = (write: Run['writes'][number]) => JSON.parse(write.data.content).text as string;

describe('dispatch --into --repo --standby', () => {
  it('posts the repo prime into the existing topic and nothing else', async () => {
    const result = await dispatch(intoFresh);

    expect(result.status, result.stderr).toBe(0);
    expect(result.writes).toHaveLength(1);
    expect(result.writes[0]!.path.message_id).toBe(TARGET_ROOT);
    expect(result.writes[0]!.data.reply_in_thread).toBe(true);
    expect(result.writes[0]!.data.msg_type).toBe('text');
    expect(textOf(result.writes[0]!)).toBe(`<at user_id="${BOT}"></at> /repo ${WORKTREE}`);
    // No seed, no brief kickoff, no report binding: only the policy check ran.
    expect(result.calls).not.toContain('/api/report-relay/register');
    expect(result.calls).not.toContain('/api/dispatch-user/deliver');
    expect(result.calls.every(call => call.endsWith('/project-dispatch-policy'))).toBe(true);
  });

  it('sends exactly the text a brand-new --standby topic gets', async () => {
    const fresh = await dispatch(['--title', 'T', '--bot', BOT, '--repo', WORKTREE, '--standby', '--chat-id', DEST_CHAT]);
    const into = await dispatch(intoFresh);

    expect(fresh.status, fresh.stderr).toBe(0);
    expect(into.status, into.stderr).toBe(0);
    expect(textOf(into.writes[0]!)).toBe(textOf(fresh.writes[0]!));
    expect(fresh.writes[0]!.path.message_id).toBe(NEW_SEED);
  });

  it('tells the caller what was sent and how to confirm the new session', async () => {
    const result = await dispatch(intoFresh);

    expect(result.json).toMatchObject({
      success: true,
      mode: 'into-standby',
      taskSent: false,
      transportState: 'dispatched',
      acceptanceState: 'not_requested',
      errorCode: null,
      threadRootId: TARGET_ROOT,
      threadId: 'omt_existing',
      primeMessageId: 'om_prime_sent',
      repo: WORKTREE,
      chatId: DEST_CHAT,
      bots: [BOT],
      freshSession: { confirmVia: 'observe', match: { rootMessageId: TARGET_ROOT, closed: false }, requestedRepo: WORKTREE },
    });
    // The new session's id belongs to the target daemon; the receipt must not invent one.
    expect(result.json).not.toHaveProperty('sessionId');
    expect(result.json.freshSession).not.toHaveProperty('sessionId');
  });

  it('does not rewrite the lifecycle or project card of the workstream it swaps a session in', async () => {
    const result = await dispatch(intoFresh);

    expect(result.registry[TARGET_ROOT]).toMatchObject({ status: 'accepted', acceptanceState: 'accepted', errorCode: null });
    expect(result.calls.some(call => call.endsWith('/project'))).toBe(false);
  });

  it('refuses a root that is not in the destination chat, before sending anything', async () => {
    const result = await dispatch(intoFresh, { rootChat: 'oc_somewhere_else' });

    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('dispatch_chat_mismatch');
    expect(result.writes).toEqual([]);
    // A prime that never went out is not a failed workstream.
    expect(result.registry[TARGET_ROOT]).toMatchObject({ status: 'accepted', errorCode: null });
    expect(result.calls.some(call => call.endsWith('/project'))).toBe(false);
  });

  it('carries no task: a brief next to --standby is refused rather than dropped', async () => {
    const result = await dispatch([...intoFresh, '--brief', 'please also do X']);

    expect(result.status, result.stderr).toBe(1);
    expect(result.writes).toEqual([]);
    expect(result.calls).toEqual([]);
  });

  it.each([
    ['--repo is missing', ['--into', TARGET_ROOT, '--bot', BOT, '--standby', '--chat-id', DEST_CHAT]],
    ['--steer is added', [...intoFresh, '--steer']],
    ['no bot is named', ['--into', TARGET_ROOT, '--repo', WORKTREE, '--standby', '--chat-id', DEST_CHAT]],
  ])('still fails when %s', async (_name, args) => {
    const result = await dispatch(args);

    expect(result.status, result.stderr).toBe(1);
    expect(result.writes).toEqual([]);
  });

  it('keeps --bot-app from smuggling in /repo authority', async () => {
    const result = await dispatch(['--into', TARGET_ROOT, '--bot-app', 'cli_target', '--repo', WORKTREE, '--standby', '--chat-id', DEST_CHAT]);

    expect(result.status, result.stderr).toBe(1);
    expect(result.writes).toEqual([]);
  });
});

describe('other --into / --standby combinations are unchanged', () => {
  it('--into with a brief still delivers a kickoff through the daemon and sends no repo prime, even with --repo', async () => {
    const result = await dispatch(['--into', TARGET_ROOT, '--bot', BOT, '--repo', WORKTREE, '--brief', 'do the thing', '--chat-id', DEST_CHAT]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ mode: 'into', taskSent: true, threadRootId: TARGET_ROOT });
    expect(result.calls).toContain('/api/dispatch-user/deliver');
    expect(result.writes).toEqual([]);
  });

  it('--standby without --into still opens a new topic and primes it', async () => {
    const result = await dispatch(['--title', 'T', '--bot', BOT, '--repo', WORKTREE, '--standby', '--chat-id', DEST_CHAT]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.json).toMatchObject({ mode: 'standby', taskSent: false, seedMessageId: NEW_SEED });
    expect(result.calls).toContain('/api/report-relay/register');
    expect(result.writes[0]!.path.message_id).toBe(NEW_SEED);
  });
});
