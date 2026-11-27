/**
 * How the WeCom bridge reads and writes its state document: no rewrite when
 * nothing changed, a symlinked state.json replaced rather than written through,
 * no write intermediates left behind, a damaged file refused without echoing
 * it, older records loaded, and a write failure reported once.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomCore } from '../src/im/wecom/gateway/bridge.js';
import {
  removeStaleWecomStateTemps,
  WECOM_STALE_TEMP_AGE_MS,
  WecomStateFileUnreadableError,
} from '../src/im/wecom/gateway/bridge/state-store.js';
import { WECOM_PRUNE_INTERVAL_MS } from '../src/im/wecom/gateway/bridge/prune.js';
import { describeWecomStateWriteFailure } from '../src/im/wecom/contract/state-write-failure.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage } from '../src/im/wecom/protocol/types.js';
import { blockWecomStateWrites } from './helpers/wecom-state-writes.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const message = (id: string, text = 'task'): WecomInboundMessage =>
  ({ messageId: id, userId: 'alice', conversationId: 'alice', chatType: 'single', text, attachments: [], replyContext: { requestId: id } });

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wecom-state-write-'));
  roots.push(root);
  return root;
}

function harness(stateFile: string) {
  const lines: string[] = [];
  const core: WecomCore = {
    trigger: vi.fn(async (request: TriggerRequest) => ({
      ok: true, triggerId: `turn-${request.source.requestId}`, target: { kind: 'turn' as const, sessionId: 's1' },
    })),
    result: vi.fn(async () => ({ ok: true, state: 'completed' as const, output: { content: 'answer' } })),
    interrupt: vi.fn(async () => {}),
  };
  const transport = { reply: vi.fn(async () => {}), send: vi.fn(async () => {}) };
  const create = () => new WecomBridge({
    botId: 'bot',
    allowedUsers: ['alice'],
    stateFile,
    transport,
    core,
    peerRoot: tempRoot(),
    log: line => lines.push(line),
  });
  return { core, transport, lines, create, state: () => JSON.parse(readFileSync(stateFile, 'utf8')) };
}

/** Entries of `dir` that look like a write intermediate. */
const intermediates = (dir: string) => readdirSync(dir).filter(name => name.endsWith('.tmp'));

describe('writing state.json', () => {
  // Case 14. Mutation W1: writing unchanged content turns this red.
  it('leaves the file alone on ticks that change nothing and rewrites it on one that does', async () => {
    vi.useFakeTimers();
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    const h = harness(stateFile);
    const bridge = h.create();
    await bridge.receive(message('a1'));
    await bridge.tick();
    const settled = statSync(stateFile).ino;
    await bridge.tick();
    vi.setSystemTime(Date.now() + WECOM_PRUNE_INTERVAL_MS);
    await bridge.tick();
    expect(statSync(stateFile).ino).toBe(settled);

    await bridge.receive(message('a2'));
    expect(statSync(stateFile).ino).not.toBe(settled);
    expect(Object.keys(h.state().tasks)).toHaveLength(2);
  });

  // Case 15. Mutation W2: following the link turns this red.
  it('replaces a symlinked state.json itself and leaves the file it pointed to as it was', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'elsewhere'));
    const target = join(root, 'elsewhere', 'state.json');
    const original = JSON.stringify({ version: 1, botId: 'bot', routes: {}, seen: {}, tasks: {} });
    writeFileSync(target, original);
    const stateFile = join(root, 'state.json');
    symlinkSync(target, stateFile);
    const h = harness(stateFile);
    await h.create().receive(message('a1'));
    expect(lstatSync(stateFile).isSymbolicLink()).toBe(false);
    expect(Object.keys(h.state().tasks)).toHaveLength(1);
    expect(readFileSync(target, 'utf8')).toBe(original);
  });

  // Case 16.
  it('leaves no write intermediate behind, after a write that succeeded or one that failed', async () => {
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    const h = harness(stateFile);
    const bridge = h.create();
    await bridge.receive(message('a1'));
    await bridge.tick();
    expect(intermediates(root)).toEqual([]);

    const unblock = blockWecomStateWrites(stateFile);
    await expect(bridge.receive(message('a2'))).rejects.toMatchObject({ code: 'EISDIR' });
    expect(intermediates(root)).toEqual([]);
    unblock();
  });

  // Case 20. Mutation W4: a line for every failure turns this red.
  it('reports the first write failure in one line, with its code and the state directory, never the error\'s own text, and stays quiet after', async () => {
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    const h = harness(stateFile);
    const bridge = h.create();
    await bridge.receive(message('a1', 'private-marker'));
    const unblock = blockWecomStateWrites(stateFile);
    // A refused /grant saves again in its failure path: two failed writes.
    const failed = await bridge.receive(message('g1', '/grant bob talk')).then(() => undefined, (error: unknown) => error);
    expect(failed).toMatchObject({ code: 'EISDIR' });
    await expect(bridge.tick()).rejects.toThrow(/状态写入失败/);
    unblock();
    expect(h.lines).toHaveLength(1);
    expect(h.lines[0]).toContain('EISDIR');
    // The state directory is no credential: it says where to look.
    expect(h.lines[0]).toContain(root);
    // The error's own text names the temp file it tried; the line keeps to the code.
    expect(h.lines[0]).not.toContain((failed as Error).message);
    expect(h.lines[0]).not.toContain('private-marker');
    // What went wrong and what to do, in the words the Dashboard uses for the same code.
    const described = describeWecomStateWriteFailure('EISDIR');
    expect(h.lines[0]).toContain(described.reason);
    expect(h.lines[0]).toContain(described.action);
  });
});

describe('reading state.json', () => {
  // Case 17. Mutation W3: rethrowing the parser's error turns this red.
  it.each([
    ['cut short', '{"version":1,"botId":"bot","tasks":{"k":{"message":{"text":"secret-marker-7f3a'],
    ['empty', ''],
    ['not an object', '["secret-marker-7f3a"]'],
    ['null', 'null'],
  ])('refuses a state file that is %s without quoting it, and leaves it as it was', (_case, content) => {
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    writeFileSync(stateFile, content);
    let caught: unknown;
    try {
      harness(stateFile).create();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WecomStateFileUnreadableError);
    expect(String((caught as Error).message)).not.toContain('secret-marker');
    expect(readFileSync(stateFile, 'utf8')).toBe(content);
  });

  // Case 18.
  it('loads a record missing native tables, keeps the keys it does not know, and runs a turn', async () => {
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    writeFileSync(stateFile, JSON.stringify({
      version: 1, botId: 'bot', routes: {}, seen: {}, tasks: {},
      native: { grants: {}, epoch: 3, laterTable: { kept: true }, conversationTypes: { alice: 'single' }, knownUsers: { alice: true } },
    }));
    const h = harness(stateFile);
    const bridge = h.create();
    await bridge.receive(message('a1'));
    await bridge.tick();
    const saved = h.state();
    expect(Object.values(saved.tasks)).toEqual([expect.objectContaining({ delivered: true })]);
    expect(saved.native).toMatchObject({ epoch: 3, laterTable: { kept: true }, actions: {}, requests: {}, receipts: {} });
    // Written by earlier versions only; a prune drops them.
    expect(saved.native).not.toHaveProperty('conversationTypes');
    expect(saved.native).not.toHaveProperty('knownUsers');
  });
});

/** Set an entry's modification time `ms` from now (negative: in the past), without following a symlink. */
function modifiedAt(path: string, ms: number): void {
  const at = new Date(Date.now() + ms);
  lutimesSync(path, at, at);
}

describe('removing write intermediates at start', () => {
  // Case 19.
  it('removes only regular-file intermediates of the state file', () => {
    const root = tempRoot();
    const stateFile = join(root, 'state.json');
    const outside = join(tempRoot(), 'linked.txt');
    writeFileSync(outside, 'outside');
    writeFileSync(stateFile, '{}');
    const files = {
      'state.json.4242.0123abcd.tmp': true,
      'state.json.tmp': true,
      'state.json.business': false,
      'state.json.4242.0123abcd.tmp.keep': false,
      'other.json.4242.0123abcd.tmp': false,
    };
    for (const name of Object.keys(files)) writeFileSync(join(root, name), name);
    mkdirSync(join(root, 'state.json.77.89abcdef.tmp'));
    writeFileSync(join(root, 'state.json.77.89abcdef.tmp', 'inside'), 'inside');
    symlinkSync(outside, join(root, 'state.json.78.89abcdef.tmp'));
    // Old enough, every one of them: only name and type decide here.
    for (const name of readdirSync(root)) modifiedAt(join(root, name), -10 * WECOM_STALE_TEMP_AGE_MS);

    removeStaleWecomStateTemps(stateFile);
    for (const [name, removed] of Object.entries(files)) expect([name, existsSync(join(root, name))]).toEqual([name, !removed]);
    expect(readFileSync(stateFile, 'utf8')).toBe('{}');
    expect(readFileSync(join(root, 'state.json.77.89abcdef.tmp', 'inside'), 'utf8')).toBe('inside');
    expect(lstatSync(join(root, 'state.json.78.89abcdef.tmp')).isSymbolicLink()).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });

  // Mutation: removing the age condition turns this red.
  it('leaves an intermediate modified within the last minute, or in the future, to the writer that may own it', () => {
    const recent = tempRoot();
    const old = tempRoot();
    const ages = {
      'state.json.1.0123abcd.tmp': -WECOM_STALE_TEMP_AGE_MS / 2,
      'state.json.2.0123abcd.tmp': 60 * 60 * 1000,
      'state.json.3.0123abcd.tmp': -2 * WECOM_STALE_TEMP_AGE_MS,
      'state.json.tmp': -WECOM_STALE_TEMP_AGE_MS / 2,
    };
    for (const [name, ms] of Object.entries(ages)) {
      writeFileSync(join(recent, name), name);
      modifiedAt(join(recent, name), ms);
    }
    writeFileSync(join(old, 'state.json.tmp'), 'old');
    modifiedAt(join(old, 'state.json.tmp'), -2 * WECOM_STALE_TEMP_AGE_MS);

    removeStaleWecomStateTemps(join(recent, 'state.json'));
    removeStaleWecomStateTemps(join(old, 'state.json'));
    expect(readdirSync(recent).sort()).toEqual(['state.json.1.0123abcd.tmp', 'state.json.2.0123abcd.tmp', 'state.json.tmp']);
    expect(readdirSync(old)).toEqual([]);
  });

  it('leaves a directory in place of the old fixed intermediate, and ignores a missing directory', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'state.json.tmp'));
    modifiedAt(join(root, 'state.json.tmp'), -10 * WECOM_STALE_TEMP_AGE_MS);
    removeStaleWecomStateTemps(join(root, 'state.json'));
    expect(lstatSync(join(root, 'state.json.tmp')).isDirectory()).toBe(true);
    expect(() => removeStaleWecomStateTemps(join(root, 'missing', 'state.json'))).not.toThrow();
  });
});
