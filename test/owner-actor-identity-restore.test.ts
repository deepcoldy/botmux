/**
 * Owner-actor identity restoration across daemon restart, exercised through the
 * real restore/refresh/publication functions. The contract-store reattach test
 * covers origin recovery; this file attacks authority changes and overlapping
 * asynchronous publication after that origin has arrived.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';

vi.mock('../src/utils/user-token.js', () => ({
  resolveUserToken: vi.fn(async () => null),
  lookupAuthorizedUserName: vi.fn(() => undefined),
  isUsableOpenId: (openId: unknown) => typeof openId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(openId),
  userTokenAuthState: vi.fn(() => ({ state: 'unknown' })),
}));
vi.mock('../src/services/bytedcli-auth.js', () => ({
  renewBytedcliJwts: vi.fn(async () => null),
  mintBytedcliJwts: vi.fn(async () => null),
  beginBytedcliLogin: vi.fn(async () => null),
  describeBytedcliAuth: vi.fn(async () => ({ state: 'unknown' })),
  parseEnvelope: vi.fn(() => null),
  runBytedcliInHome: vi.fn(async () => ({ ok: false, stdout: '', stderr: 'not mocked' })),
}));
const resolveLarkCliHomeForTurn = vi.fn(async (_openId: string): Promise<string | null> => null);
vi.mock('../src/services/lark-cli-auth.js', () => ({
  resolveLarkCliHomeForTurn: (openId: string) => resolveLarkCliHomeForTurn(openId),
  pendingLarkCliChallenge: vi.fn(() => null),
  beginLarkCliLogin: vi.fn(async () => null),
  describeLarkCliAuth: vi.fn(() => ({ state: 'unknown' })),
}));

const { publishTurnCliIdentity, trackTurnIdentityPublication } = await import('../src/core/turn-cli-identity.js');
const { recallProvenIdentityContent } = await import('../src/core/cli-identity.js');
const { activeIdentityTurns, releaseActiveIdentityTurn } = await import('../src/core/active-identity-turns.js');
const { parseTriggerUserAuthConfig } = await import('../src/services/trigger-user-auth.js');
const { isHumanInboundTurnId, pickTurnReplyTarget } = await import('../src/core/reply-target.js');
const { allowsPersonalIdentityForTurn, isPersonActorTurnId, isRunAsTurnId, isUnattendedIdentityTurnId } = await import('../src/core/workflow-event-turn.js');
const { parseScheduledTurnId } = await import('../src/core/scheduled-turn-provenance.js');

const OWNER = 'ou_old_owner';
const OWNER_TURN = 'trg_owner_adversarial';
const RUN_AS_TURN = 'trg_runas_adversarial';
const TURN = OWNER_TURN;
const SESSION = 'session-owner-adversarial';
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
  resolveLarkCliHomeForTurn.mockReset();
});

function extracted(file: string, names: string[]): string {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    if (!node) throw new Error(`missing ${name} in ${file}`);
    return ts.transpileModule(node.getText(source), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText.replace(/^export\s+/, '');
  }).join('\n');
}

const daemonFunctions = extracted('src/daemon.ts', [
  'triggerUserAuthEnabledFor',
  'prepareTurnCliIdentity',
  'identityModelForPublication',
  'refreshTurnCliIdentity',
  'restoreTurnCliIdentity',
]);
const livenessFunction = extracted('src/core/worker-pool.ts', ['identityDecisionTurnIsLive']);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

function world(opts: {
  allowOwnerActor?: boolean;
  currentOwner?: string;
  allowedOwners?: string[];
  dispatchUserForTurn?: () => Promise<undefined>;
  /** A runAs turn: the person its reply target records and the live admission. */
  runAs?: { person: string; unionId: string | null; operable: () => boolean };
  /** An earlier turn already published in this session; `turn` overrides the turn id. */
  previouslyPublished?: boolean;
  turn?: string;
} = {}) {
  const TURN = opts.turn ?? (opts.runAs ? RUN_AS_TURN : OWNER_TURN);
  const SENDER = opts.runAs?.person ?? OWNER;
  const dataDir = mkdtempSync(join(tmpdir(), 'owner-actor-restore-test-'));
  directories.push(dataDir);
  let allowedOwners = opts.allowedOwners ?? [opts.currentOwner ?? OWNER];
  const botConfig: any = {
    larkAppId: 'cli_owner_probe',
    larkAppSecret: 'probe-secret',
    brand: 'feishu',
    ownerOpenId: opts.currentOwner ?? OWNER,
    triggerUserAuth: parseTriggerUserAuthConfig({
      enabled: true,
      tools: ['lark-cli'],
      credentialSource: 'local',
      allowOwnerActor: opts.allowOwnerActor ?? true,
    }),
  };
  const ds: any = {
    larkAppId: 'cli_owner_probe',
    chatId: 'oc_probe',
    chatType: 'p2p',
    workerGeneration: 2,
    managedTurnOrigin: { turnId: TURN },
    worker: { killed: false },
    session: {
      sessionId: SESSION,
      status: 'active',
      replyTargets: {
        [TURN]: { senderOpenId: SENDER, participants: [{ openId: SENDER, isBot: false }] },
      },
    },
    reportedIdentityModel: { model: 'proven' },
    ...(opts.previouslyPublished ? { lastPublishedIdentityModel: 'proven' } : {}),
    terminalIdentityTurnIds: new Set<string>(),
  };
  const deps: Record<string, any> = {
    ds,
    getBot: () => ({ config: botConfig, resolvedAllowedUsers: allowedOwners }),
    getStrictOwnerOpenId: () => allowedOwners.includes(botConfig.ownerOpenId) ? botConfig.ownerOpenId : undefined,
    allowsPersonalIdentityForTurn,
    parseScheduledTurnId,
    isHumanInboundTurnId,
    isPersonActorTurnId, isRunAsTurnId,
    isUnattendedIdentityTurnId,
    resolveUnionIdFromOpenId: async () => opts.runAs?.unionId ?? null,
    canOperate: () => opts.runAs?.operable() ?? false,
    trackTurnIdentityPublication,
    ownerActorIdentityRestores: new WeakMap(),
    prepareScheduledRecoveryRun: () => { throw new Error('unexpected schedule recovery'); },
    scheduleAuthorityStore: undefined,
    scheduler: { admitManualRunTurn: () => false },
    sessionStore: { updateSession: () => {} },
    prepareScheduledTurnCliIdentity: async () => { throw new Error('unexpected scheduled identity'); },
    identityPublicationConflicted: () => false,
    identityStorageModelForDaemonSession: () => 'proven',
    pickTurnReplyTarget,
    dispatchUserForTurn: opts.dispatchUserForTurn ?? (async () => undefined),
    targetUserForDelegation: async () => undefined,
    workflowDelegationRefusalFor: () => undefined,
    publishTurnCliIdentity,
    config: { session: { dataDir } },
    localeForBot: () => 'en',
    clearRestoredLapses: () => {},
    unattendedTask: () => ({ taskId: 'probe-task' }),
    logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
  };
  const { restoreTurnCliIdentity, prepareTurnCliIdentity } = new Function('deps',
    `with (deps) { ${livenessFunction}; ${daemonFunctions}; return { restoreTurnCliIdentity, prepareTurnCliIdentity }; }`)(deps);
  return {
    ds,
    botConfig,
    restore: () => restoreTurnCliIdentity(ds, TURN),
    prepare: () => prepareTurnCliIdentity(ds, TURN),
    material: () => recallProvenIdentityContent(dataDir, SESSION, TURN, 'lark-cli'),
    activeTurns: () => activeIdentityTurns(dataDir, SESSION),
    releaseTerminal: () => {
      ds.terminalIdentityTurnIds.add(TURN);
      releaseActiveIdentityTurn(dataDir, SESSION, TURN);
    },
  };
}

describe('owner actor identity restoration — authority and timing fences', () => {
  it('restores the current owner identity', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world();
    await w.restore();
    expect(w.material()).toContain(`/home/${OWNER}`);
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledTimes(1);
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledWith(OWNER);
  });

  it('keeps the ordinary denial when owner credentials start disabled', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ allowOwnerActor: false });
    await w.restore();
    expect(w.material()).toContain("BOTMUX_IDENTITY_MODE='denied'");
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });

  it('does not resolve or publish the previous owner after owner and allowlist change', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ currentOwner: 'ou_new_owner', allowedOwners: ['ou_new_owner'] });
    await w.restore();
    expect(w.material()).toBeUndefined();
    expect(w.activeTurns()).toEqual([]);
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });

  it('removes a publication whose turn terminals while credentials resolve', async () => {
    const entered = deferred<void>();
    const gate = deferred<string>();
    resolveLarkCliHomeForTurn.mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const w = world();
    const restoring = w.restore();
    await entered.promise;
    w.releaseTerminal();
    gate.resolve(`/home/${OWNER}`);
    await restoring;
    expect(w.material()).toBeUndefined();
    expect(w.activeTurns()).toEqual([]);
  });

  it('removes a publication whose owner opt-out closes while credentials resolve', async () => {
    const entered = deferred<void>();
    const gate = deferred<string>();
    resolveLarkCliHomeForTurn.mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const w = world();
    const restoring = w.restore();
    await entered.promise;
    w.botConfig.triggerUserAuth.allowOwnerActor = false;
    gate.resolve(`/home/${OWNER}`);
    await restoring;
    expect(w.material()).toBeUndefined();
    expect(w.activeTurns()).toEqual([]);
  });

  it('serializes an older generation cleanup before the newer generation publication', async () => {
    const entered = deferred<void>();
    const gate = deferred<string>();
    let calls = 0;
    resolveLarkCliHomeForTurn.mockImplementation(async openId => {
      calls += 1;
      if (calls === 1) { entered.resolve(); return gate.promise; }
      return `/home/${openId}`;
    });
    const w = world();
    const older = w.prepare();
    await entered.promise;
    w.ds.workerGeneration = 3;
    const newer = w.prepare();
    gate.resolve(`/home/${OWNER}`);
    await Promise.all([older, newer]);
    expect(w.material()).toContain(`/home/${OWNER}`);
    expect(w.activeTurns()).toEqual([TURN]);
  });

  it('shares the replacement generation after duplicate prepares waited on an older one', async () => {
    const entered = deferred<void>();
    const gate = deferred<string>();
    resolveLarkCliHomeForTurn.mockImplementation(async openId => {
      entered.resolve();
      return gate.promise;
    });
    const w = world();
    const older = w.prepare();
    await entered.promise;
    w.ds.workerGeneration = 3;
    const newerFirst = w.prepare();
    const newerSecond = w.prepare();
    gate.resolve(`/home/${OWNER}`);
    await Promise.all([older, newerFirst, newerSecond]);
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledTimes(2);
    expect(w.material()).toContain(`/home/${OWNER}`);
    expect(w.activeTurns()).toEqual([TURN]);
  });

  it('shares one in-flight restore across duplicate managed origins', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const dispatchGate = deferred<undefined>();
    let dispatchCalls = 0;
    const w = world({
      dispatchUserForTurn: () => { dispatchCalls += 1; return dispatchGate.promise; },
    });
    const first = w.restore();
    const second = w.restore();
    expect(dispatchCalls).toBe(1);
    dispatchGate.resolve(undefined);
    await Promise.all([first, second]);
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledTimes(1);
    expect(w.material()).toContain(`/home/${OWNER}`);
  });
});

describe('runAs turn identity — the named person, re-admitted at publication', () => {
  const PERSON = 'ou_runas_person';
  const person = (operable: () => boolean = () => true, unionId: string | null = 'on_runas_person') =>
    ({ person: PERSON, unionId, operable });

  it('publishes the named person identity without needing the owner-actor opt-in', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ allowOwnerActor: false, runAs: person() });
    await w.restore();
    expect(w.material()).toContain(`/home/${PERSON}`);
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledTimes(1);
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledWith(PERSON);
  });

  it('withholds the identity when the person may no longer operate the bot', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ runAs: person(() => false) });
    await w.restore();
    expect(w.material()).toBeUndefined();
    expect(w.activeTurns()).toEqual([]);
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });

  it('withholds the identity when the person cannot be resolved to a union id', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ runAs: person(() => true, null) });
    await w.restore();
    expect(w.material()).toBeUndefined();
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });

  it('removes a publication whose person loses access while credentials resolve', async () => {
    const entered = deferred<void>();
    const gate = deferred<string>();
    resolveLarkCliHomeForTurn.mockImplementation(async () => { entered.resolve(); return gate.promise; });
    let operable = true;
    const w = world({ runAs: person(() => operable) });
    const restoring = w.restore();
    await entered.promise;
    operable = false;
    gate.resolve(`/home/${PERSON}`);
    await restoring;
    expect(w.material()).toBeUndefined();
    expect(w.activeTurns()).toEqual([]);
  });

  it('never substitutes the bot owner or another person when the recorded person is missing', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ runAs: person() });
    w.ds.session.replyTargets = { [RUN_AS_TURN]: {} };
    await w.restore();
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
    expect(w.material() ?? '').not.toContain('/home/');
  });

  it.each([
    ['worker generation', (ds: any) => { ds.workerGeneration = 3; }],
    ['dispatch attempt', (ds: any) => { ds.managedTurnOrigin = { turnId: RUN_AS_TURN, dispatchAttempt: 2 }; }],
  ] as const)('removes a publication whose %s changed while credentials resolve', async (_label, advance) => {
    const entered = deferred<void>();
    const gate = deferred<string>();
    resolveLarkCliHomeForTurn.mockImplementation(async () => { entered.resolve(); return gate.promise; });
    const w = world({ runAs: person() });
    w.ds.managedTurnOrigin = { turnId: RUN_AS_TURN, dispatchAttempt: 1 };
    const restoring = w.restore();
    await entered.promise;
    advance(w.ds);
    gate.resolve(`/home/${PERSON}`);
    await restoring;
    expect(w.material()).toBeUndefined();
    expect(w.activeTurns()).toEqual([]);
  });

  it('requires the bot to have opted into trigger-user auth, but not allowOwnerActor', () => {
    expect(allowsPersonalIdentityForTurn(RUN_AS_TURN, { enabled: true })).toBe(true);
    expect(allowsPersonalIdentityForTurn(RUN_AS_TURN, { enabled: false, allowOwnerActor: true })).toBe(false);
    expect(allowsPersonalIdentityForTurn(RUN_AS_TURN, undefined)).toBe(false);
    expect(allowsPersonalIdentityForTurn(OWNER_TURN, { enabled: true })).toBe(false);
  });
});

describe('person turns in a session that already published for an earlier turn', () => {
  const PERSON = 'ou_runas_person';
  const person = { person: PERSON, unionId: 'on_runas_person', operable: () => true };

  it('publishes a runAs turn on its live origin', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ runAs: person, previouslyPublished: true });
    await w.restore();
    expect(w.material()).toContain(`/home/${PERSON}`);
  });

  it('publishes an owner turn on its live origin', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ previouslyPublished: true });
    await w.restore();
    expect(w.material()).toContain(`/home/${OWNER}`);
  });

  it('shares one publication across repeated origin events of the same turn', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ runAs: person, previouslyPublished: true });
    await Promise.all([w.restore(), w.restore()]);
    expect(resolveLarkCliHomeForTurn).toHaveBeenCalledTimes(1);
  });

  it('still leaves an ordinary synthetic trigger turn unpublished', async () => {
    resolveLarkCliHomeForTurn.mockImplementation(async openId => `/home/${openId}`);
    const w = world({ turn: 'trg_plain_trigger', previouslyPublished: true });
    await w.restore();
    expect(w.material()).toBeUndefined();
    expect(resolveLarkCliHomeForTurn).not.toHaveBeenCalled();
  });
});
