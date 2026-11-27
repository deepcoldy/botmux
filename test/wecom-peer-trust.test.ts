/**
 * Trust between the WeCom connections of one host (config/peer-trust.ts): the
 * rule itself, and the two places it is used — starting a new session in a
 * peer's directory and the quota-limit hand-over — with real bridges, real
 * configuration files and an in-process transport between them. The emphasis
 * is on what must be refused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { wecomPeerAccepts, type WecomPeerSide } from '../src/im/wecom/config/peer-trust.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import { wecomBotRoot } from '../src/im/wecom/config/runtime.js';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';
import { WecomBridge, type WecomBridgePolicy } from '../src/im/wecom/gateway/bridge.js';
import type { NativePeerRequest } from '../src/im/wecom/gateway/native-peers.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

const side = (allowedUsers: string[], extra: Partial<WecomPeerSide> = {}): WecomPeerSide => ({ allowedUsers, ...extra });
const accepts = (target: WecomPeerSide | undefined, source: WecomPeerSide | undefined, operation: 'directory' | 'fallback' | 'result' | 'interrupt' = 'fallback', sameConnection = false) =>
  wecomPeerAccepts({ target, source, sameConnection, operation });

describe('the same-host trust rule', () => {
  it('accepts a source whose allowed users all belong to the target, with both switches unset (default on)', () => {
    expect(accepts(side(['alice', 'bob']), side(['alice']))).toBe(true);
    expect(accepts(side(['alice', 'bob']), side(['alice']), 'directory')).toBe(true);
  });

  // Mutation: replacing `every` with `some` turns this red.
  it('refuses a source with one allowed user the target does not know', () => {
    expect(accepts(side(['alice', 'bob']), side(['alice', 'mallory']))).toBe(false);
  });

  it('refuses when either side has no allowed users', () => {
    expect(accepts(side(['alice']), side([]))).toBe(false);
    expect(accepts(side([]), side(['alice']))).toBe(false);
  });

  // Mutation: comparing the lists the other way round turns one direction red.
  it('is one-way: A⊆B lets B accept A, not A accept B', () => {
    const a = side(['alice']), b = side(['alice', 'bob']);
    expect(accepts(b, a)).toBe(true);
    expect(accepts(a, b)).toBe(false);
  });

  it('refuses a source or target that is not a connection of this host, and a connection asking itself', () => {
    expect(accepts(side(['alice']), undefined)).toBe(false);
    expect(accepts(undefined, side(['alice']))).toBe(false);
    expect(accepts(side(['alice']), side(['alice']), 'fallback', true)).toBe(false);
  });

  // Mutation: dropping the target's trustSameOwnerBots check turns this red.
  it('refuses when the target switched trustSameOwnerBots off', () => {
    expect(accepts(side(['alice'], { trustSameOwnerBots: false }), side(['alice']))).toBe(false);
  });

  // Mutation: dropping the botToBotSameDir check (or applying it to every operation) turns this red.
  it('refuses only directory when the target switched botToBotSameDir off', () => {
    const target = side(['alice'], { botToBotSameDir: false });
    expect(accepts(target, side(['alice']), 'directory')).toBe(false);
    expect(accepts(target, side(['alice']), 'fallback')).toBe(true);
  });

  it('does not count a user the target blocks as known', () => {
    expect(accepts(side(['alice', 'bob'], { blockedUsers: ['bob'] }), side(['alice', 'bob']))).toBe(false);
  });
});

// ── Two real bridges on one host ──────────────────────────────────────────

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Connection {
  id: string;
  file: string;
  write(native: Record<string, unknown>, allowedUsers?: string[]): void;
  policy(): WecomBridgePolicy;
  /** Record its gateway as running (the runtime record a running gateway keeps); returns the record's path. */
  online(): string;
}

function host() {
  const root = mkdtempSync(join(tmpdir(), 'wecom-peer-trust-'));
  dirs.push(root);
  const files: string[] = [];
  const connection = (name: string, port: number, allowedUsers: string[], workingDirectory = root): Connection => {
    const file = join(root, `${name}.json`);
    files.push(file);
    writeFileSync(join(root, 'config-registry.json'), JSON.stringify({ version: 1, paths: files }));
    let users = allowedUsers;
    const write = (native: Record<string, unknown>, next = users) => {
      users = next;
      writeFileSync(file, JSON.stringify({ botId: `${name}-bot`, displayName: `${name} bot`, secretEnv: 'FAKE_WECOM_SECRET', coreUrl: `http://127.0.0.1:${port}`, allowedUsers: users, native }));
    };
    write({});
    const id = wecomConfigId(file);
    return {
      id,
      file,
      write,
      online: () => {
        const dir = wecomBotRoot(`${name}-bot`, root);
        mkdirSync(dir, { recursive: true });
        const record = join(dir, 'runtime.json');
        writeFileSync(record, JSON.stringify({
          version: 1, configId: id, pid: process.pid, processStart: 'fixture', instanceId: 'fixture',
          control: { port: port + 100, instanceId: 'fixture' }, connection: 'connected', phase: 'running', updatedAt: Date.now(),
        }));
        return record;
      },
      policy: () => {
        const config = parseWecomConfig(JSON.parse(readFileSync(file, 'utf8')));
        return { ...config.native, allowedUsers: config.allowedUsers, blockedUsers: config.blockedUsers, workingDirectory, disableStreamingCard: true };
      },
    };
  };
  return { root, connection };
}

const groupMessage = (id: string, userId = 'alice', text = 'question'): WecomInboundMessage =>
  ({ messageId: id, userId, conversationId: 'room', chatType: 'group', text, attachments: [], replyContext: { requestId: id } });

describe('the quota-limit hand-over between two connections', () => {
  let h: ReturnType<typeof host>;
  let a: Connection, b: Connection;
  let limit: boolean;
  let peerResult: () => Promise<unknown>;
  let source: WecomBridge, target: WecomBridge;
  let sent: Array<{ to: string; text: string }>, replies: string[];
  let peerCalls: NativePeerRequest[];
  let sourceCore: { trigger: any; result: any; interrupt: any; progress: any };
  let targetCore: { trigger: any; result: any; interrupt: any };
  let targetRuntime: string;
  beforeEach(() => {
    h = host();
    a = h.connection('source', 19601, ['alice']);
    b = h.connection('target', 19602, ['alice', 'bob']);
    a.write({ quotaFallbackBot: { enabled: true, peerId: b.id, kinds: ['usage'] } });
    targetRuntime = b.online();
    limit = false;
    sent = [];
    replies = [];
    peerCalls = [];
    targetCore = {
      trigger: vi.fn(async () => ({ ok: true, triggerId: 'peer-turn', target: { kind: 'turn', sessionId: 'peer-sid' } })),
      result: vi.fn(async () => peerResult()),
      interrupt: vi.fn(async () => {}),
    };
    peerResult = async () => ({ ok: true, state: 'completed', output: { content: 'answer from the backup bot' } });
    target = new WecomBridge({
      botId: 'target-bot', connectionId: b.id, allowedUsers: ['alice', 'bob'], policy: b.policy, peerRoot: h.root,
      stateFile: join(h.root, 'target-state.json'),
      transport: { send: async () => {}, reply: async () => {} },
      core: targetCore,
    });
    sourceCore = {
      trigger: vi.fn(async () => ({ ok: true, triggerId: 'turn', target: { kind: 'turn', sessionId: 'sid' } })),
      result: vi.fn(async () => ({ ok: true, state: limit ? 'completed' : 'running', output: { content: 'limit reached on the source' } })),
      interrupt: vi.fn(async () => {}),
      progress: vi.fn(async () => ({ turnId: 'turn', workerGeneration: 1, entries: [], ...(limit ? { limit: { kind: 'usage', retryAtMs: Date.now() + 60000, key: 'k' } } : {}) })),
    };
    source = new WecomBridge({
      botId: 'source-bot', connectionId: a.id, allowedUsers: ['alice'], policy: a.policy, peerRoot: h.root,
      stateFile: join(h.root, 'source-state.json'),
      transport: { send: async (to, text) => { sent.push({ to, text }); }, reply: async (_m, text) => { replies.push(text); } },
      core: sourceCore,
      peerRequest: async (_id, body) => { peerCalls.push(body); return target.receivePeer(body); },
    });
  });
  const sourceTask = () => Object.values(JSON.parse(readFileSync(join(h.root, 'source-state.json'), 'utf8')).tasks)[0] as any;
  // A new session also asks trusted peers for a directory (botToBotSameDir is on by default); only the hand-over counts here.
  const handovers = () => peerCalls.filter(call => call.operation !== 'directory');

  // Mutation: skipping the self-check before the hand-over (peerAccepted) turns the refusal cases red.
  it('hands over when the target accepts, and the source bot delivers the result', async () => {
    await source.receive(groupMessage('m1'));
    await source.tick();
    limit = true;
    // While the turn is still running under the limit (result 'running' until the hand-over interrupts it).
    sourceCore.result.mockResolvedValueOnce({ ok: true, state: 'running' });
    await source.tick();
    expect(sourceCore.interrupt).toHaveBeenCalledTimes(1);
    expect(handovers().map(c => c.operation)).toEqual(['fallback']);
    expect(handovers()[0]).toMatchObject({ sourceId: a.id, sourceUser: 'alice', sourceChat: 'room', trace: [a.id, b.id] });
    expect(sent.at(-1)?.to).toBe('room');
    await source.tick();
    expect(replies).toContain('answer from the backup bot');
    expect(sourceTask()).toMatchObject({ delivered: true, peer: { id: b.id } });
  });

  it.each([
    ['the source has an allowed user the target does not know', () => { a.write({ quotaFallbackBot: { enabled: true, peerId: b.id, kinds: ['usage'] } }, ['alice', 'mallory']); }],
    ['the target switched trustSameOwnerBots off', () => { b.write({ trustSameOwnerBots: false }); }],
    ['the source switched trustSameOwnerBots off', () => { a.write({ trustSameOwnerBots: false, quotaFallbackBot: { enabled: true, peerId: b.id, kinds: ['usage'] } }); }],
    ['the target configuration is gone', () => { rmSync(b.file); }],
    // Mutation: dropping the running-gateway check before the hand-over (peerOnline) turns this case red.
    ['the target gateway is not running', () => { rmSync(targetRuntime); }],
  ] as const)('does not hand over, and does not interrupt the turn, when %s; the limit result reaches the user', async (_label, change) => {
    change();
    await source.receive(groupMessage('m1'));
    await source.tick();
    limit = true;
    sourceCore.result.mockResolvedValueOnce({ ok: true, state: 'running' });
    await source.tick();
    expect(handovers()).toEqual([]);
    expect(sourceCore.interrupt).not.toHaveBeenCalled();
    await source.tick();
    expect(replies).toContain('limit reached on the source');
    expect(sourceTask().peer).toBeUndefined();
  });

  // Mutation: dropping the re-judgement on the result step (in receivePeer or peerCall) turns this red.
  it('refuses the result once the allowed users changed after the hand-over was accepted; the task is closed, not posted', async () => {
    await source.receive(groupMessage('m1'));
    await source.tick();
    limit = true;
    sourceCore.result.mockResolvedValueOnce({ ok: true, state: 'running' });
    await source.tick();
    expect(sourceTask().peer).toBeDefined();
    a.write({ quotaFallbackBot: { enabled: true, peerId: b.id, kinds: ['usage'] } }, ['alice', 'mallory']);
    await source.tick();
    expect(replies).not.toContain('answer from the backup bot');
    expect(sourceTask()).toMatchObject({ revoked: true, delivered: true });
    // The target refuses it as well, whoever asks.
    await expect(target.receivePeer({ ...handovers()[0], operation: 'result', sessionId: 'peer-sid', triggerId: 'peer-turn' })).rejects.toThrow('wecom_peer_untrusted');
  });

  it.each([
    ['the target switched trust off', () => b.write({ trustSameOwnerBots: false })],
    ['the target blocked the requesting user', () => writeFileSync(b.file, JSON.stringify({ ...JSON.parse(readFileSync(b.file, 'utf8')), blockedUsers: ['alice'] }))],
  ] as const)('refuses a result when, while the target is still fetching it, %s', async (_label, change) => {
    await source.receive(groupMessage('m1'));
    await source.tick();
    limit = true;
    sourceCore.result.mockResolvedValueOnce({ ok: true, state: 'running' });
    await source.tick();
    let release!: (value: unknown) => void;
    peerResult = () => new Promise(resolve => { release = resolve; });
    const pending = target.receivePeer({ ...handovers()[0], operation: 'result', sessionId: 'peer-sid', triggerId: 'peer-turn' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    change();
    release({ ok: true, state: 'completed', output: { content: 'SENSITIVE' } });
    await expect(pending).rejects.toThrow('wecom_peer_authority_changed');
  });

  // Mutation: dropping the source's own re-check after the peer answered (peerCall) turns this red.
  it('does not post a result when the source\'s trust ends while the peer call is in flight', async () => {
    await source.receive(groupMessage('m1'));
    await source.tick();
    limit = true;
    sourceCore.result.mockResolvedValueOnce({ ok: true, state: 'running' });
    await source.tick();
    let release!: (value: unknown) => void;
    peerResult = () => new Promise(resolve => { release = resolve; });
    // The target answers whatever it fetched; the source alone decides it is no longer trusted.
    const ticking = source.tick();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    a.write({ trustSameOwnerBots: false, quotaFallbackBot: { enabled: true, peerId: b.id, kinds: ['usage'] } });
    // The target still accepts (its own rule does not look at the source's switch).
    release({ ok: true, state: 'completed', output: { content: 'SENSITIVE_PEER_RESULT' } });
    await ticking;
    await source.tick();
    expect(JSON.stringify([...sent, ...replies])).not.toContain('SENSITIVE_PEER_RESULT');
    expect(sourceTask()).toMatchObject({ revoked: true });
  });

  it('closes a hand-over an earlier version recorded with trust epochs, without asking the peer', async () => {
    await source.receive(groupMessage('m1'));
    await source.tick();
    const state = JSON.parse(readFileSync(join(h.root, 'source-state.json'), 'utf8'));
    const task = Object.values(state.tasks)[0] as any;
    task.peer = { id: b.id, requestId: 'old', epoch: 1, targetEpoch: 1, sessionId: 'peer-sid', triggerId: 'peer-turn' };
    writeFileSync(join(h.root, 'source-state.json'), JSON.stringify(state));
    const restarted = new WecomBridge({
      botId: 'source-bot', connectionId: a.id, allowedUsers: ['alice'], policy: a.policy, peerRoot: h.root,
      stateFile: join(h.root, 'source-state.json'),
      transport: { send: async (to, text) => { sent.push({ to, text }); }, reply: async (_m, text) => { replies.push(text); } },
      core: sourceCore,
      peerRequest: async (_id, body) => { peerCalls.push(body); return target.receivePeer(body); },
    });
    await restarted.tick();
    await restarted.tick();
    expect(handovers()).toEqual([]);
    expect(sourceTask()).toMatchObject({ revoked: true, delivered: true });
  });

  it('refuses a request from a connection that is not configured on this host, or that names itself', async () => {
    const body: NativePeerRequest = { operation: 'fallback', sourceId: 'c'.repeat(64), sourceBotId: 'ghost', sourceUser: 'alice', sourceChat: 'room', chatType: 'group', requestId: 'r', trace: ['c'.repeat(64), b.id], request: { envelope: { rawText: 'q' } } };
    await expect(target.receivePeer(body)).rejects.toThrow('wecom_peer_untrusted');
    await expect(target.receivePeer({ ...body, sourceId: b.id, sourceBotId: 'target-bot', trace: [b.id, b.id] })).rejects.toThrow('wecom_peer_scope_invalid');
    expect(targetCore.trigger).not.toHaveBeenCalled();
  });

  // Mutation: dropping the bot id comparison turns this red.
  it('refuses a request that names a trusted connection but not the bot that connection is configured for', async () => {
    const body: NativePeerRequest = { operation: 'fallback', sourceId: a.id, sourceBotId: 'another-bot', sourceUser: 'alice', sourceChat: 'room', chatType: 'group', requestId: 'r', trace: [a.id, b.id], request: { envelope: { rawText: 'q' } } };
    await expect(target.receivePeer(body)).rejects.toThrow('wecom_peer_untrusted');
    expect(targetCore.trigger).not.toHaveBeenCalled();
    expect(await target.receivePeer({ ...body, sourceBotId: 'source-bot' })).toMatchObject({ ok: true, triggerId: 'peer-turn' });
  });

  it('keeps the target\'s own checks on the requesting user: a user the target blocks is refused', async () => {
    b.write({ }, ['alice', 'bob']);
    const body: NativePeerRequest = { operation: 'fallback', sourceId: a.id, sourceBotId: 'source-bot', sourceUser: 'alice', sourceChat: 'room', chatType: 'group', requestId: 'r', trace: [a.id, b.id], request: { envelope: { rawText: 'q' } } };
    writeFileSync(b.file, JSON.stringify({ ...JSON.parse(readFileSync(b.file, 'utf8')), allowedUsers: ['alice', 'bob', 'carol'], blockedUsers: ['carol'] }));
    await expect(target.receivePeer({ ...body, sourceUser: 'carol' })).rejects.toThrow('wecom_peer_target_acl');
    expect(await target.receivePeer(body)).toMatchObject({ ok: true, triggerId: 'peer-turn' });
  });
});

/** A real git repository (one empty commit) at `dir`; returns its real path. */
function gitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env, stdio: 'ignore' });
  return realpathSync(dir);
}

describe('starting a new session in a trusted peer\'s directory', () => {
  async function scenario(change?: (a: Connection, b: Connection) => void) {
    const h = host();
    const work = realpathSync(h.root);
    const directory = gitRepo(join(h.root, 'repo'));
    const a = h.connection('source', 19611, ['alice'], work);
    const b = h.connection('target', 19612, ['alice', 'bob'], work);
    change?.(a, b);
    const transport = { send: async () => {}, reply: async () => {} };
    const core = { trigger: vi.fn(async (_request: TriggerRequest) => ({ ok: true, target: { kind: 'turn' as const, sessionId: 's' }, triggerId: 't' })), result: async () => ({ ok: true, state: 'running' as const }), interrupt: async () => {} };
    const target = new WecomBridge({ botId: 'target-bot', connectionId: b.id, allowedUsers: ['alice', 'bob'], policy: b.policy, peerRoot: h.root, stateFile: join(h.root, 'target.state'), transport, core });
    await target.receive(groupMessage('select', 'alice', '/repo repo'));
    const peerRequest = vi.fn(async (_id: string, body: NativePeerRequest) => target.receivePeer(body));
    const trigger = vi.fn(core.trigger);
    const source = new WecomBridge({ botId: 'source-bot', connectionId: a.id, allowedUsers: ['alice'], policy: a.policy, peerRoot: h.root, stateFile: join(h.root, 'source.state'), transport, core: { ...core, trigger }, peerRequest });
    await source.receive(groupMessage('work'));
    await source.tick();
    return { directory, trigger, peerRequest };
  }

  it('takes the directory the trusted peer selected for the same conversation, with the switches unset', async () => {
    const { directory, trigger } = await scenario();
    expect(trigger).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ connectorWorkingDirectory: directory }) }));
  });

  it('does not take it when the peer switched botToBotSameDir off', async () => {
    const { trigger } = await scenario((_a, b) => b.write({ botToBotSameDir: false }));
    expect(trigger.mock.calls[0]![0].options?.connectorWorkingDirectory).toBeUndefined();
  });

  it('does not ask at all when this connection switched trustSameOwnerBots off, or the peer does not know one of its users', async () => {
    for (const change of [
      (a: Connection) => a.write({ trustSameOwnerBots: false }),
      (a: Connection) => a.write({}, ['alice', 'mallory']),
    ]) {
      const { trigger, peerRequest } = await scenario(change);
      expect(peerRequest).not.toHaveBeenCalled();
      expect(trigger.mock.calls[0]![0].options?.connectorWorkingDirectory).toBeUndefined();
    }
  });
});
