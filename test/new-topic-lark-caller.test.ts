// 非文本断言：执行真实新话题初始化及调用链，不按源码字符串判断身份。
import { describe, it } from 'vitest';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
function stripTypeScriptTypes(source: string, _options?: unknown) {
  return ts.transpileModule(source, {compilerOptions: {target: ts.ScriptTarget.ES2022}}).outputText;
}
import { basename, join } from 'node:path';
import assert from 'node:assert/strict';

// Execute the real three-function chain. Only its infrastructure dependencies
// are stubbed. This harness does not load a daemon, spawn a worker, or read credentials.
const sourceRoot = process.cwd();
const card = readFileSync(join(sourceRoot, 'src/im/lark/card-handler.ts'), 'utf8');
const daemon = readFileSync(join(sourceRoot, 'src/daemon.ts'), 'utf8');
function extract(source: string, name: string) {
  const start = source.search(new RegExp('(?:export )?(?:async )?function ' + name + '\\('));
  assert(start >= 0, name + ' function exists');
  const end = source.indexOf('\n}\n', start);
  assert(end > start, name + ' closing boundary exists');
  return source.slice(start, end + 3).replace(/^export /, '');
}
function compile(source: string, name: string, deps: Record<string, any>) {
  return new Function('deps', 'with(deps){' + stripTypeScriptTypes(source, { mode: 'transform' }) + ';return ' + name + ';}')(deps);
}

const worker = readFileSync(join(sourceRoot, 'src/worker.ts'), 'utf8');
const pool = readFileSync(join(sourceRoot, 'src/core/worker-pool.ts'), 'utf8');
const ipc = readFileSync(join(sourceRoot, 'src/core/dashboard-ipc-server.ts'), 'utf8');
const gateway = readFileSync(join(sourceRoot, 'src/core/gateway-turn-caller.ts'), 'utf8');
const dsStart = daemon.indexOf('  const ds: DaemonSession = {', daemon.indexOf('const initialTurnTitle = (messageListener?.replyCardTitle'));
assert(dsStart > 0);
const dsSource = daemon.slice(dsStart, daemon.indexOf('\n  };', dsStart) + 5);
const newTopic = new Function('deps', 'with(deps){' + stripTypeScriptTypes(dsSource, { mode: 'transform' }) + '; return ds;}');
// handleThreadReplyAdmitted auto-create literal (a message landing without a
// live session builds THIS session; its auto-worktree deferred fork can only
// read the caller off the ds literal, exactly like the new-topic twin above).
const acStart = daemon.indexOf('  const newDs: DaemonSession = {');
assert(acStart > 0);
const acSource = daemon.slice(acStart, daemon.indexOf('\n    };', acStart) + 7);
assert(acSource.includes('pendingSender: autoCreateSender'));
const autoCreate = new Function('deps', 'with(deps){' + stripTypeScriptTypes(acSource, { mode: 'transform' }) + '; return newDs;}');
const initStart = pool.indexOf('  const initTrustedCaller = promptPayload.trustedCaller');
const initSource = pool.slice(initStart, pool.indexOf(';', initStart) + 1);
const initCaller = new Function('promptPayload', 'resumeOrTurnId', initSource + '; return initTrustedCaller;');
const authority = compile(extract(worker, 'turnAuthorityIdentity'), 'turnAuthorityIdentity', {});
const pubStart = worker.lastIndexOf('    send({', worker.indexOf("type: 'managed_turn_origin'"));
const publication = worker.slice(pubStart, worker.indexOf('\n    });', pubStart) + 8);
const publish = new Function('deps', 'with(deps){' + publication + ';}');
const originCallerStart = pool.indexOf('        const callerOpenId = msg.trustedCaller !== undefined');
const originCallerSource = pool.slice(originCallerStart, pool.indexOf(';', originCallerStart) + 1);
const originCaller = new Function('msg', 'ds', 'currentGatewayCallerOpenId', originCallerSource + '; return callerOpenId;');
const gatewayCaller = compile(extract(gateway, 'currentGatewayCallerOpenId'), 'currentGatewayCallerOpenId', {
  pickTurnReplyTarget: (session, turnId) => session.replyTargets?.[turnId],
});
const gateStart = ipc.indexOf('  const sender = delegated?.targetOpenId ?? originSender;');
const gateSource = ipc.slice(gateStart, ipc.indexOf('  const cached =', gateStart));
const larkSenderGate = new Function('delegated', 'originSender', 'jsonRes', 'res', gateSource + '; return {status:200,sender};');
const callerSource = extract(daemon, 'startAutoWorktreePending');

const helperSource = extract(card, 'runAutoWorktreeCommit');
const commitSource = extract(card, 'commitRepoSelection');
const noop = () => {};

async function runCase(name: string, options: Record<string, any> = {}) {
  const events: string[] = [], errors: string[] = [];
  let completion: Promise<void> | undefined, prepared = false;
  let releasePreparation!: () => void, enteredPreparation!: () => void;
  const gate = new Promise<void>(resolve => { releasePreparation = resolve; });
  const entered = new Promise<void>(resolve => { enteredPreparation = resolve; });
  let turnId = 'first-turn';
  let senderId = options.senderId ?? 'ou_real_sender';
  const verifiedCaller = options.anonymous && !options.replaceOpening ? undefined : {requestLarkAppId:'test-app', requestUserOpenId:senderId, senderType:'user'};
  const ds = options.autoCreate ? autoCreate({
    session: {sessionId:'test-session', status:'active', cliId:'codex', createdAt:new Date().toISOString(),
      replyTargets: {[turnId]: {senderOpenId:'ou_real_sender'}}},
    larkAppId:'test-app', autoCreateChatId:'test-chat', autoCreateChatType:'p2p', scope:'thread', now:Date.now(),
    cliVersionCache:new Map(),cliRuntimeVersionKey:()=>'',botCfg:{},pinnedWorkingDir:'/test/base',autoWt:true,
    promptContent:options.replaceOpening ? '' : 'new ticket',
    parsed:{messageId:turnId, senderType:'user', mentions:[], content:options.replaceOpening ? '' : 'new ticket'},
    codexAppApplicationContext:undefined,codexAppMessageContext:undefined,attachments:[],
    substituteTrigger:undefined,shouldSendSubstituteControlCard:false,
    autoCreateSender:{openId:'ou_real_sender',type:'user'},codexAppSteerable:false,
    ownerOpenId:'ou_real_sender',
    threadTrustedCaller:verifiedCaller,
  }) : newTopic({
    session: {sessionId:'test-session', status:'active', cliId:'codex', createdAt:new Date().toISOString(),
      replyTargets: {[turnId]: {senderOpenId:'ou_real_sender'}}},
    larkAppId:'test-app',chatId:'test-chat',chatType:'p2p',scope:'thread',now:Date.now(),
    cliVersionCache:new Map(),cliRuntimeVersionKey:()=>'',botCfg:{},pinnedWorkingDir:'/test/base',autoWt:true,
    promptContent:options.replaceOpening ? '' : 'new ticket',replyAnchorId:turnId,codexAppVisibleText:undefined,
    codexAppApplicationContext:undefined,codexAppMessageContext:undefined,attachments:[],
    parsed:{senderType:'user',mentions:[]},substituteTrigger:undefined,shouldSendSubstituteControlCard:false,
    newTopicSender:{openId:'ou_real_sender'},computeCodexAppSteerable:()=>false,isKnownPeerBot:()=>false,
    config:{session:{dataDir:'/not-used'}},senderOpenId:'ou_real_sender',isBotSenderType:false,
    botSteerDirective:{requested:false},newTopicGrill:undefined,messageListener:undefined,ctx:{},
    ownerOpenIdForSession:'ou_real_sender',initialTurnTitle:'test',topicSpec:undefined,
    trustedCaller:verifiedCaller,
  });
  assert.equal(gatewayCaller(ds,turnId),'ou_real_sender','exact reply target knows sender before worker publication');
  // Caller must come from the real initializer, never from the fixture.

  const activeSessions = new Map([['test-key', ds]]);
  const prepareTurnCliIdentity = async (session: any, actualTurnId: string) => {
    assert.equal(session, ds);
    assert.equal(actualTurnId, turnId);
    events.push('prepare:start');
    enteredPreparation();
    if (options.delayed) await gate;
    if (options.prepareError) throw Error('identity preparation rejected');
    prepared = true;
    events.push('prepare:done');
  };
  const target = options.fallback ? '/test/base' : '/test/worktree';
  const deps: Record<string, any> = {
    activeSessions, logger: { info: noop, warn: noop, error: (message: string) => errors.push(message) }, tag: () => 'test',
    sessionReply: async () => '', prepareTurnCliIdentity,
    freezeSessionSandboxDecision: noop, getBot: () => ({ config: {}, botName: 'test', botOpenId: 'bot' }),
    announcePendingRepoSession: noop,
    mockedWorktree: async (_app: string, _base: string, worktreeOptions: any) => {
      events.push('worktree');
      if (options.replaceOpening) {
        const start = daemon.indexOf('    if (ds.pendingRepo) {\n      const hasOpening');
        const end = daemon.indexOf('    // Initial-start compatibility path', start);
        assert(start > 0 && end > start);
        senderId = 'ou_replacement_sender';
        const replacementCaller = options.anonymous ? undefined : {
          requestLarkAppId: 'test-app', requestUserOpenId: senderId, senderType: 'user',
        };
        await compile('async function bufferOpening(){' + daemon.slice(start, end) + '}', 'bufferOpening', {
          ds, promptContent:'replacement task', parsed:{messageId:'replacement-turn',content:'replacement task',mentions:[]},
          codexAppApplicationContext:undefined, codexAppMessageContext:undefined, attachments:[],
          followUpSender:{openId:senderId,type:'user'}, codexAppSteerable:true, threadTrustedCaller:replacementCaller,
          stagePendingRepoSetup:(session: any, args: any)=>{session.session.pendingRepoSetup=args;},
          markIngressAdmitted:noop,ctx:{},sessionReply:async()=>'',tr:(key: string)=>key,
          localeForBot:()=> 'en',larkAppId:'test-app',anchor:'root-message',
        })();
        turnId = 'replacement-turn';
        ds.session.replyTargets[turnId] = {senderOpenId:senderId};
      }
      if (options.worktreeError) throw Error('worktree creation rejected');
      if (options.takeover) ds.pendingRepo = false;
      if (options.reuse) {
        assert.equal(typeof worktreeOptions.commitCreated, 'function');
        await worktreeOptions.commitCreated({ path: target });
      }
      return { dir: target };
    },
    localeForBot: () => 'en', runDetachedBotTurnAdmission: async (_app: string, fn: () => any) => fn(),
    join, existsSync: () => !options.missingSubdir, pathBasename: basename,
    sessionStore: { updateSession: noop }, AutoWorktreeFailClosedError: class extends Error {},
    activeSessionKey: () => 'test-key', withBotTurnMutation: async (_app: string, fn: () => any) => fn(),
    sessionCliId: () => ds.session.cliId, getAvailableBots: async () => [], ensureSessionWhiteboard: noop,
    buildNewTopicCliInput: () => ({ content: 'test prompt' }), sessionPromptInjection: () => undefined,
    rememberLastCliInput: noop, publishAttentionPatch: noop, markInitialUserTurnPending: noop,
    markRepoCardConsumed: noop, deferRepoCardWithdraw: noop,
    // commitRepoSelection 的被 @ 回执记录（#3039）：本 harness 只验证 worktree 调用者身份，
    // 不校验静默回执；mentions 夹具恒为空，门判 false 即中性语义——把恒 false 换成真实
    // messageMentionsBot 实现后 12 例仍全绿，证明该桩不掩盖任何分支差异。
    recordTurnExplicitMention: noop, messageMentionsBot: () => false,
    forkWorker: (_session: any, _prompt: any, turn: any) => {
      events.push('fork');
      if (options.forkError) throw Error('worker fork rejected');
      const trustedCaller = initCaller(typeof _prompt === 'string' ? {content:_prompt} : _prompt, turn);
      const activeIdentity = authority({turnId:turn.turnId,trustedCaller});
      let msg: any;
      publish({activeIdentity,sessionId:'test-session',capability:{token:'fake-capability',turnId},
        policyCapability:'fake-policy',readIsolationOriginChannelId:undefined,authorityLinkRefMode:undefined,
        send: (value: any) => {msg=value;}});
      const callerOpenId=originCaller(msg,ds,gatewayCaller);
      ds.managedTurnOrigin = {turnId, trustedCaller:msg.trustedCaller,callerOpenId};
      const decision=larkSenderGate(undefined,callerOpenId,(_res: any,status: number,body: any)=>({status,...body}),{});
      const probe={prepared, trustedCallerAtFork:trustedCaller??null,
        publishedTrustedCaller:msg.trustedCaller, callerAfterPublication:callerOpenId??null,
        replyTargetSender:ds.session.replyTargets[turnId].senderOpenId,
        gatewayCallerAfterPublication:gatewayCaller(ds,turnId)??null,larkUserDecision:decision};
      assert.equal(probe.prepared,true,'existing hotfix already prepares CLI material');
      assert.equal(decision.status,options.anonymous?403:200);
      if(options.anonymous) assert.equal(decision.error,'No current requesting user; --as user requires their authorization');
      else assert.equal(decision.sender,senderId);
    },
  };
  deps.commitRepoSelection = compile(commitSource, 'commitRepoSelection', deps);
  let helper = helperSource.replace("await import('../../services/default-worktree.js')", '{ maybeCreateDefaultWorktree: mockedWorktree }');
  let caller = callerSource;
  if (options.dropCaller) caller = caller.replace('    prepareTurn: prepareTurnCliIdentity,\n', '');
  if (options.dropHelper) helper = helper.replace("        sessionReply: async () => '',\n        prepareTurn,", "        sessionReply: async () => '',");
  const helperFn = compile(helper, 'runAutoWorktreeCommit', deps);
  deps.runAutoWorktreeCommit = (args: any) => { completion = helperFn(args); return completion; };
  compile(caller, 'startAutoWorktreePending', deps)(ds, {
    anchor: 'root-message', baseDir: '/test/base', prompt: ds.pendingPrompt,
    ...(options.reuse ? { reuseExisting: true, worktreePath: target } : {}),
    ...(options.missingSubdir ? { targetSubdir: 'missing' } : {}),
  });
  assert(completion instanceof Promise);
  if (options.delayed) {
    await entered;
    assert.equal(events.includes('fork'), false, 'fork waits for the asynchronous preparation');
    assert.equal(ds.pendingRepo, true, 'opening remains reserved while preparation is pending');
    releasePreparation();
  }
  await completion;
  const shouldPrepare = !options.empty && !options.worktreeError && !options.takeover && !options.missingSubdir && !options.negative;
  const shouldFork = !options.prepareError && !options.worktreeError && !options.takeover && !options.missingSubdir;
  assert.equal(events.filter(event => event === 'prepare:start').length, shouldPrepare ? 1 : 0, name + ': preparation count');
  assert.equal(events.filter(event => event === 'fork').length, shouldFork ? 1 : 0, name + ': fork count');
  if (shouldPrepare && shouldFork) assert(events.indexOf('prepare:done') < events.indexOf('fork'));
  if (options.prepareError || options.worktreeError || options.missingSubdir || options.forkError) {
    assert.equal(ds.pendingRepo, true, 'failure keeps the session recoverable');
    assert.equal(ds.pendingPrompt, 'new ticket', 'failure retains the opening message');
    assert.equal(errors.length, 1, name + ': failure is logged');
  } else {
    assert.equal(errors.length, 0, name + ': no unexpected error');
    assert.equal(ds.pendingRepo, false);
  }
  if (options.fallback) assert.equal(ds.session.autoWorktreeFallbackDir, '/test/base');
  assert.equal(ds.worktreeCreating, false);
  assert.notEqual(ds.pendingRepoCommitInFlight, true);
}

describe('new topic caller through auto worktree and Lark user gateway', () => {
  it('keeps the first human caller in a new worktree', async () => {
    await runCase('fresh worktree');
  });
  it('keeps the caller when reusing a worktree', async () => {
    await runCase('reused worktree', {reuse:true});
  });
  it('keeps the caller when allowed to fall back to the base directory', async () => {
    await runCase('fallback', {fallback:true});
  });
  it('waits for identity preparation before publishing the same caller', async () => {
    await runCase('async preparation', {delayed:true});
  });
  it('uses the verified sender rather than the owner or reply target', async () => {
    await runCase('different sender', {senderId:'ou_second_sender'});
  });
  it('denies a callerless turn despite an owner and a recorded message sender', async () => {
    await runCase('callerless', {anonymous:true});
  });
  it('uses the new sender when a human fills an empty placeholder', async () => {
    await runCase('replacement human', {replaceOpening:true});
  });
  it('clears the placeholder caller when the actual opening has no trusted caller', async () => {
    await runCase('callerless replacement', {replaceOpening:true,anonymous:true});
  });
  it('does not fork when identity preparation fails', async () => {
    await runCase('preparation failure', {prepareError:true});
  });
  it('does not fork after the pending session is taken over', async () => {
    await runCase('takeover', {takeover:true});
  });
  it('keeps the first human caller when a thread reply auto-creates the session', async () => {
    await runCase('auto-create worktree', {autoCreate:true});
  });
  it('denies an auto-created turn that has no trusted caller', async () => {
    await runCase('auto-create callerless', {autoCreate:true, anonymous:true});
  });
});
