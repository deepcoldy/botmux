import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const APP = 'cli_prime_source';
const ROOT = 'om_original_topic';
const TURN = 'om_current_command';
const SEED = 'om_dispatch_seed';

async function dispatch(options: {
  policy?: 'stop' | 'legacy'; unavailable?: string; state?: 'deleted' | 'unknown' | 'error';
  retry?: boolean; overrideSession?: boolean; chatScope?: boolean; unthreaded?: boolean; missingRoot?: boolean;
}) {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-prime-'));
  const data = join(root, 'data'); const home = join(root, 'home');
  for (const p of [data, home, join(data, '.botmux-cli-pids')]) mkdirSync(p, { recursive: true });
  const current = { sessionId: 'current', larkAppId: APP, chatId: 'oc_origin', rootMessageId: options.missingRoot ? '' : ROOT,
    scope: options.chatScope ? 'chat' : 'thread', status: 'active', ownerOpenId: 'ou_owner',
    createdAt: '2026-08-07T07:30:00.000Z', workingDir: root,
    currentReplyTarget: { rootMessageId: 'om_stale', turnId: 'stale' },
    replyTargets: { 'turn-prime': { ...(options.unthreaded ? {} : { rootMessageId: TURN, quoteOnly: true }),
      updatedAt: '2026-08-07T08:00:00.000Z' } },
  };
  seedPersistedSessionRows(data, APP, { current, selected: { ...current, sessionId: 'selected', rootMessageId: 'om_selected', replyTargets: {} } });
  writeFileSync(join(data, '.botmux-cli-pids', String(process.pid)), JSON.stringify({ sessionId: 'current', turnId: 'turn-prime' }));
  const configs = join(root, 'bots.json'); writeFileSync(configs, '[]');
  const calls: string[] = [];
  // This fixture only stands in for already-covered daemon admission. It does
  // not create a topic, start a bot, or claim to verify those daemon routes.
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404).end('{}'); return; }
    for await (const _chunk of req) { /* consume body */ }
    calls.push(req.url!);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, dispatchRoot: SEED, messageId: 'om_kickoff' }));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const capture = join(root, 'capture.json');
  const code = `
    import { writeFileSync } from 'node:fs';
    import { registerBot } from ${JSON.stringify(pathToFileURL(resolve('src/bot-registry.ts')).href)};
    const state = registerBot({ larkAppId: ${JSON.stringify(APP)}, larkAppSecret: 'fake', cliId: 'claude-code', allowedUsers: [], topicUnavailablePolicy: ${JSON.stringify(options.policy ?? 'stop')} });
    const reads = [], writes = [];
    const save = () => writeFileSync(${JSON.stringify(capture)}, JSON.stringify({ reads, writes }));
    state.client.request = async ({ method, url }) => {
      if (method !== 'GET' || !url.includes('/im/v1/messages/')) throw new Error('Unexpected request');
      const id = url.split('/').at(-1); reads.push(id); save();
      const unavailable = id === ${JSON.stringify(options.unavailable)} && (!${!!options.retry} || writes.length > 0);
      if (unavailable && ${JSON.stringify(options.state)} === 'error') throw new Error('read failed');
      return { code: 0, data: { items: [{ message_id: id,
        ...(unavailable && ${JSON.stringify(options.state)} === 'unknown' ? {} : { deleted: unavailable }),
        ...(id === ${JSON.stringify(TURN)} ? { root_id: ${JSON.stringify(ROOT)} } : {}),
      }] } };
    };
    state.client.im.v1.message.get = async () => ({ code: 0, data: { items: [{ message_id: ${JSON.stringify(SEED)}, thread_id: 'omt_child' }] } });
    state.client.im.v1.message.reply = async request => {
      writes.push(request); save();
      if (${!!options.retry} && writes.length === 1) throw { isAxiosError: true, response: { status: 429 } };
      return { code: 0, data: { message_id: 'om_prime_sent' } };
    };
    process.argv = ['node', 'botmux', 'dispatch', ...${JSON.stringify([
      '--title', 'Fixture', '--bot', 'ou_sub_bot', '--repo', root, '--standby', '--chat-id', 'oc_destination',
      ...(options.overrideSession ? ['--session-id', 'selected'] : []),
    ])}];
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
    return { ...result, calls, ...existsSync(capture) ? JSON.parse(readFileSync(capture, 'utf8')) : { reads: [], writes: [] } };
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); rmSync(root, { recursive: true, force: true }); }
}

describe('dispatch repo prime source topic', () => {
  it.each([false, true])('keeps the executing turn when session override is %s', async overrideSession => {
    const result = await dispatch({ overrideSession, unavailable: ROOT, chatScope: true });
    expect(result.status, result.stderr).toBe(1); expect(result.stderr).toContain('TOPIC_SEND_BLOCKED');
    expect(result.writes).toEqual([]); expect(result.reads).toContain(TURN); expect(result.reads).toContain(ROOT);
    expect(result.calls).toContain('/api/report-relay/register');
  });
  it.each(['unknown', 'error'] as const)('refuses %s source evidence after the seed was admitted', async state => {
    const result = await dispatch({ unavailable: ROOT, state });
    expect(result.status, result.stderr).toBe(1); expect(result.stderr).toContain('TOPIC_SEND_CHECK_FAILED'); expect(result.writes).toEqual([]);
  });
  it('rechecks source on a provider rate-limit retry', async () => {
    const result = await dispatch({ unavailable: ROOT, retry: true });
    expect(result.status, result.stderr).toBe(1); expect(result.stderr).toContain('TOPIC_SEND_BLOCKED'); expect(result.writes).toHaveLength(1);
    expect(result.reads.filter((id: string) => id === ROOT)).toHaveLength(2);
  });
  it('sends the original repo command into the admitted seed when source is live', async () => {
    const result = await dispatch({});
    expect(result.status, result.stderr).toBe(0); expect(result.writes).toHaveLength(1);
    expect(result.writes[0].path.message_id).toBe(SEED); expect(result.writes[0].data.content).toContain('/repo ');
    expect(result.reads).toContain(ROOT);
  });
  it('also checks the actual destination seed', async () => {
    const result = await dispatch({ unavailable: SEED });
    expect(result.status, result.stderr).toBe(1); expect(result.stderr).toContain('TOPIC_SEND_BLOCKED'); expect(result.writes).toEqual([]);
  });
  it('keeps an explicitly unthreaded chat origin independent of its stale root', async () => {
    const result = await dispatch({ chatScope: true, unthreaded: true, unavailable: ROOT });
    expect(result.status, result.stderr).toBe(0); expect(result.writes).toHaveLength(1); expect(result.reads).not.toContain(ROOT);
  });
  it('refuses a thread source whose original message identity is missing', async () => {
    const result = await dispatch({ missingRoot: true });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('TOPIC_SEND_CHECK_FAILED');
    expect(result.writes).toEqual([]);
  });
  it('keeps only the existing receipt metadata query in legacy mode', async () => {
    const result = await dispatch({ policy: 'legacy', unavailable: ROOT });
    expect(result.status, result.stderr).toBe(0); expect(result.writes).toHaveLength(1); expect(result.reads).toEqual([SEED]);
  });
});
