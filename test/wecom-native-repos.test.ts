/**
 * `/repo` on a WeCom connection lists the git repositories under the
 * connection's working root (the Feishu `/repo` scan) and selects one by
 * number, name or relative path; `botToBotSameDir` takes a peer's directory only
 * when that scan finds it. Fixtures are real git repositories in the system
 * temp directory, driven through the real bridge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy } from '../src/im/wecom/gateway/bridge.js';
import { scanWecomRepositories, wecomRepositoryListing } from '../src/im/wecom/gateway/native-repos.js';
import type { requestNativePeer } from '../src/im/wecom/gateway/native-peers.js';
import { wecomConfigId } from '../src/im/wecom/config/discovery.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return realpathSync(dir);
}

/** A real git repository (one empty commit on `branch`) at `dir`; returns its real path. */
function gitRepo(dir: string, branch = 'main'): string {
  mkdirSync(dir, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, env, stdio: 'ignore' });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir, env, stdio: 'ignore' });
  return realpathSync(dir);
}

/**
 * root/app (main), root/group/svc (dev), root/a/dup and root/b/dup (same name),
 * root/plain (not a repository), and root/escape → a repository outside root.
 */
function workspace() {
  const root = tempDir('wecom-repos-root-');
  const outside = gitRepo(join(tempDir('wecom-repos-outside-'), 'evil'));
  const repos = {
    app: gitRepo(join(root, 'app')),
    svc: gitRepo(join(root, 'group', 'svc'), 'dev'),
    dupA: gitRepo(join(root, 'a', 'dup')),
    dupB: gitRepo(join(root, 'b', 'dup')),
  };
  mkdirSync(join(root, 'plain'));
  symlinkSync(outside, join(root, 'escape'));
  return { root, outside, repos };
}

type PeerRequest = typeof requestNativePeer;

function bridgeFor(
  root: string,
  extra: Partial<WecomBridgePolicy> = {},
  peerRequest?: PeerRequest,
  peers: { connectionId?: string; peerRoot?: string } = {},
) {
  const file = join(tempDir('wecom-repos-state-'), 'state.json');
  const replies: string[] = [];
  const policy: WecomBridgePolicy = { allowedUsers: ['alice'], workingDirectory: root, disableStreamingCard: true, ...extra };
  const trigger = vi.fn(async (_request: TriggerRequest) => ({ ok: true, triggerId: 't', target: { kind: 'turn' as const, sessionId: 's' } }));
  const bridge = new WecomBridge({
    botId: 'bot',
    allowedUsers: policy.allowedUsers,
    stateFile: file,
    policy: () => policy,
    transport: { reply: async (_message, text) => { replies.push(text); }, send: async () => {} },
    core: {
      trigger,
      result: async () => ({ ok: true, state: 'running' as const }),
      interrupt: async () => {},
    },
    peerRequest,
    ...peers,
  });
  let n = 0;
  /** One message; returns what the bridge replied to it. */
  const say = async (
    text: string,
    chat: { chatType: 'group' | 'single'; conversationId: string } = { chatType: 'group', conversationId: 'g' },
    userId = 'alice',
  ) => {
    const before = replies.length;
    n++;
    await bridge.receive({ messageId: `m${n}`, userId, ...chat, text, attachments: [], replyContext: { requestId: `m${n}` } });
    return replies.slice(before).join('\n');
  };
  const state = () => JSON.parse(readFileSync(file, 'utf8'));
  const selected = (): Array<{ name: string; directory: string }> => Object.values(state().native.selectedRepos);
  /** The working directory the next new session of this route is created in. */
  const sessionDirectory = async () => {
    await say('work');
    const tasks = Object.values(state().tasks) as Array<{ request: { options: { connectorWorkingDirectory?: string } } }>;
    return tasks.at(-1)?.request.options.connectorWorkingDirectory;
  };
  return { say, selected, sessionDirectory, state, policy, trigger, bridge };
}

/** The number a listing shows in front of the line ending with `path`. */
function numberOf(listing: string, path: string): string {
  const line = listing.split('\n').find(text => text.endsWith(` ${path}`));
  expect(line, `${path} is listed`).toBeDefined();
  return /^(\d+)\./.exec(line!)![1];
}

describe('/repo lists the repositories under the working root', () => {
  it('lists each repository by name, branch and path relative to the root, and no host path', async () => {
    const { root, outside, repos } = workspace();
    const f = bridgeFor(root);
    const listing = await f.say('/repo');
    for (const path of ['app', 'group/svc', 'a/dup', 'b/dup']) numberOf(listing, path);
    expect(listing).toContain('dev');
    for (const hostPath of [root, outside, ...Object.values(repos), tmpdir()]) expect(listing).not.toContain(hostPath);
    // Not a repository, and a symlink that leads outside the root.
    expect(listing).not.toMatch(/\bplain\b|\bescape\b|\bevil\b/);
    expect(f.selected()).toEqual([]);
  });

  it('says so, without a list, when the root is missing or holds no repository', async () => {
    const empty = tempDir('wecom-repos-empty-');
    mkdirSync(join(empty, 'docs'));
    const missing = await bridgeFor(join(empty, 'missing')).say('/repo');
    const none = await bridgeFor(empty).say('/repo');
    expect(missing).not.toBe('');
    expect(none).not.toBe('');
    expect(missing).not.toBe(none);
    for (const reply of [missing, none]) {
      expect(reply).not.toMatch(/^\d+\./m);
      expect(reply).not.toContain(empty);
    }
  });
});

describe('/repo <number|name|relative path> selects a repository for the next new session', () => {
  it('selects by the number of the latest listing, by name and by relative path', async () => {
    const { root, repos } = workspace();
    const f = bridgeFor(root);
    const listing = await f.say('/repo');

    await f.say(`/repo ${numberOf(listing, 'group/svc')}`);
    expect(f.selected()).toEqual([expect.objectContaining({ name: 'svc', directory: repos.svc })]);

    await f.say('/repo app');
    expect(f.selected()).toEqual([expect.objectContaining({ name: 'app', directory: repos.app })]);

    for (const path of ['group/svc', './group/svc/']) {
      await f.say('/repo app');
      await f.say(`/repo ${path}`);
      expect(f.selected()).toEqual([expect.objectContaining({ directory: repos.svc })]);
    }
    expect(await f.sessionDirectory()).toBe(repos.svc);
  });

  it('asks for a number or a relative path when a name belongs to more than one repository, and guesses nothing', async () => {
    const { root, repos } = workspace();
    const f = bridgeFor(root);
    const reply = await f.say('/repo dup');
    expect(reply).not.toBe('');
    expect(f.selected()).toEqual([]);
    await f.say('/repo b/dup');
    expect(f.selected()).toEqual([expect.objectContaining({ directory: repos.dupB })]);
  });

  it('takes a number only after a listing in this conversation, and only within it', async () => {
    const { root, repos } = workspace();
    const f = bridgeFor(root);
    expect(await f.say('/repo 1')).not.toBe('');
    expect(f.selected()).toEqual([]);
    const listing = await f.say('/repo');
    await f.say(`/repo ${listing.split('\n').filter(line => /^\d+\./.test(line)).length + 1}`);
    expect(f.selected()).toEqual([]);
    await f.say(`/repo ${numberOf(listing, 'app')}`);
    expect(f.selected()).toEqual([expect.objectContaining({ directory: repos.app })]);
  });

  it('refuses a symlink that leads outside the root, by its path or the target name', async () => {
    const { root } = workspace();
    const f = bridgeFor(root);
    for (const arg of ['escape', './escape', 'evil', '../', '.']) {
      await f.say(`/repo ${arg}`);
      expect(f.selected(), arg).toEqual([]);
    }
  });

  it('refuses a listed repository that was swapped for a symlink out of the root before it was picked', async () => {
    const { root, outside } = workspace();
    const f = bridgeFor(root);
    const listing = await f.say('/repo');
    rmSync(join(root, 'app'), { recursive: true, force: true });
    symlinkSync(outside, join(root, 'app'));
    await f.say(`/repo ${numberOf(listing, 'app')}`);
    expect(f.selected()).toEqual([]);
  });
});

describe('a selected repository when the next new session is created in it', () => {
  /**
   * bob holds a granted operate right (a quota-counted grant, unlike alice's
   * standing access) and selects root/app; `change` then runs before bob's next
   * message. Returns what that message led to.
   */
  async function afterSelection(change: (w: ReturnType<typeof workspace>, f: ReturnType<typeof bridgeFor>) => void) {
    const w = workspace();
    const f = bridgeFor(w.root);
    await f.say('/grant bob operate');
    await f.say('/repo app', undefined, 'bob');
    expect(f.selected()).toEqual([expect.objectContaining({ directory: w.repos.app })]);
    change(w, f);
    const reply = await f.say('work', undefined, 'bob');
    await f.bridge.tick();
    const grant = Object.values(f.state().native.grants as Record<string, { userId: string; used: number }>).find(g => g.userId === 'bob')!;
    const tasks = Object.values(f.state().tasks) as Array<{ request: { options: { connectorWorkingDirectory?: string } } }>;
    return { w, f, reply, used: grant.used, tasks };
  }

  it('creates the session in it when nothing changed', async () => {
    const { w, f, used, tasks } = await afterSelection(() => {});
    expect(tasks.map(task => task.request.options.connectorWorkingDirectory)).toEqual([w.repos.app]);
    expect(f.trigger).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ connectorWorkingDirectory: w.repos.app }) }));
    expect(used).toBe(1);
  });

  it.each([
    ['the working root was moved to a directory that does not contain it', (w: ReturnType<typeof workspace>, f: ReturnType<typeof bridgeFor>) => {
      const elsewhere = tempDir('wecom-repos-new-root-');
      gitRepo(join(elsewhere, 'other'));
      f.policy.workingDirectory = elsewhere;
    }],
    ['its directory was replaced by a symlink out of the root', (w: ReturnType<typeof workspace>) => {
      rmSync(join(w.root, 'app'), { recursive: true, force: true });
      symlinkSync(w.outside, join(w.root, 'app'));
    }],
    ['its directory is no longer a git repository', (w: ReturnType<typeof workspace>) => {
      rmSync(join(w.root, 'app', '.git'), { recursive: true, force: true });
    }],
  ] as const)('drops the selection and creates no session when %s', async (_name, change) => {
    const { f, reply, used, tasks } = await afterSelection(change);
    expect(reply).not.toBe('');
    expect(tasks).toEqual([]);
    expect(f.trigger).not.toHaveBeenCalled();
    expect(f.selected()).toEqual([]);
    expect(used).toBe(0);
  });
});

describe('the scan budget', () => {
  it('reports an incomplete scan and still lists what it found', () => {
    const root = tempDir('wecom-repos-budget-');
    gitRepo(join(root, 'one'));
    gitRepo(join(root, 'two'));
    // The root and one child fit in two directories: one repository is found, then the budget runs out.
    const partial = scanWecomRepositories(root, { maxScanDirs: 2 });
    expect(partial).toMatchObject({ ok: true, incomplete: true });
    expect(partial.ok && partial.repositories).toHaveLength(1);
    const found = partial.ok ? partial.repositories[0]! : undefined;
    const listing = wecomRepositoryListing(partial);
    expect(listing).toContain(found!.path);
    // The same repositories from a complete scan: the incomplete listing says something more.
    const complete = wecomRepositoryListing({ ...partial, incomplete: false } as typeof partial);
    expect(listing.startsWith(complete)).toBe(true);
    expect(listing.length).toBeGreaterThan(complete.length);
    // A budget spent before any repository: not the same answer as a root without one.
    const none = scanWecomRepositories(root, { maxScanMs: 0 });
    expect(none).toEqual({ ok: true, repositories: [], incomplete: true });
    expect(wecomRepositoryListing(none)).not.toBe(wecomRepositoryListing({ ok: true, repositories: [], incomplete: false }));
  });
});

describe('botToBotSameDir', () => {
  /**
   * This connection and one same-host peer per directory, each with a real
   * configuration file in a private WeCom root. Every peer accepts this
   * connection (its allowed users include alice), and both switches are left
   * unset (on). A peer answers with its directory through `peerRequest`.
   */
  async function inherited(root: string, peerDirectories: string[]) {
    const wecom = tempDir('wecom-repos-peers-');
    const files: string[] = [];
    const connection = (name: string, allowedUsers: string[]) => {
      const file = join(wecom, `${name}.json`);
      files.push(file);
      writeFileSync(file, JSON.stringify({ botId: `${name}-bot`, secretEnv: 'FAKE_WECOM_SECRET', coreUrl: 'http://127.0.0.1:19700', allowedUsers }));
      return wecomConfigId(file);
    };
    const self = connection('self', ['alice']);
    const peers = peerDirectories.map((_, index) => connection(`peer${index}`, ['alice', 'bob']));
    writeFileSync(join(wecom, 'config-registry.json'), JSON.stringify({ version: 1, paths: files }));
    const peerRequest = (async (id: string) => ({ ok: true, directory: peerDirectories[peers.indexOf(id)] })) as unknown as PeerRequest;
    return bridgeFor(root, {}, peerRequest, { connectionId: self, peerRoot: wecom });
  }

  it('takes a peer directory that is a repository the scan finds, named as the scan names it', async () => {
    const { root, repos } = workspace();
    const f = await inherited(root, [repos.svc]);
    expect(await f.sessionDirectory()).toBe(repos.svc);
    expect(f.selected()).toEqual([expect.objectContaining({ name: 'svc', directory: repos.svc })]);
  });

  it('ignores a peer directory that is not a repository, lies outside the root, or leads out through a symlink', async () => {
    const { root, outside } = workspace();
    for (const directory of [join(root, 'plain'), outside, join(root, 'escape'), join(root, 'missing')]) {
      const f = await inherited(root, [directory]);
      expect(await f.sessionDirectory(), directory).toBeUndefined();
      expect(f.selected(), directory).toEqual([]);
    }
  });

  it('asks for /repo when two peers name different repositories', async () => {
    const { root, repos } = workspace();
    const f = await inherited(root, [repos.app, repos.svc]);
    await f.say('work');
    expect(f.state().tasks).toEqual({});
    expect(f.selected()).toEqual([]);
  });
});
