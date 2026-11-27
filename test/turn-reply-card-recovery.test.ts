import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { stat } from 'node:fs/promises';
import { config } from '../src/config.js';
import { getBot } from '../src/bot-registry.js';
import { cardTerminalForHistoricalReply, cardTerminalForRequiredReply, readHistoricalSink, sweepInterruptedReplyCards, settleTurnReplyCardTerminal } from '../src/core/turn-reply-card.js';
import { updateMessage } from '../src/im/lark/client.js';
import { TurnReplyCardStore, type TurnReplyCardTransport } from '../src/services/turn-reply-card.js';
import { TurnSendLedger } from '../src/services/turn-send-ledger.js';
import { buildTurnReplyCard } from '../src/im/lark/turn-reply-card.js';
vi.mock('../src/config.js', () => ({ config: { session: { dataDir: '' } } }));
vi.mock('../src/core/cost-calculator.js', () => ({ getSessionUsageSnapshot: vi.fn(() => ({ context: null, tokens: null })) }));
vi.mock('../src/im/lark/card-handler.js', () => ({ resolveCardOperatorUnionId: vi.fn() }));
vi.mock('../src/bot-registry.js', () => ({ getBot: vi.fn(), normalizeUsageDisplay: () => 'off' }));
vi.mock('../src/im/lark/client.js', () => ({ updateMessage: vi.fn(async () => {}), uploadFile: vi.fn(), MessageWithdrawnError: class extends Error {} }));
vi.mock('../src/i18n/index.js', () => ({ localeForBot: () => 'zh', t: (key: string) => key }));
vi.mock('../src/services/group-context-runtime.js', () => ({ observePublishedGroupMessage: vi.fn() }));
const key = { larkAppId: 'app_probe', sessionId: 'session_probe', turnId: 'om_probe' };
const input = { mode: 'unified' as const, chatId: 'oc_probe', rootId: 'om_root' };

// Let actual filesystem callbacks settle without entering the fake timer queue.
async function yieldIO() { for (let i = 0; i < 10; i++) await stat(tmpdir()); }

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => resolve=r); return {promise,resolve}; }
async function drain<T>(p: Promise<T>): Promise<T> {
 let done=false; const watched=p.finally(()=>{done=true});
 for(let i=0;i<300 && !done;i++){ await yieldIO(); await vi.advanceTimersByTimeAsync(50); }
 if(!done) throw new Error('probe clock drain timed out');
 return watched;
}
describe('reply-card recovery under partial writes and overlapping writers', () => {
 let dir: string; let store: TurnReplyCardStore; let io: TurnReplyCardTransport;
 let remote: string; let patches: number; let bot: any;
 beforeEach(async () => {
  vi.useFakeTimers({toFake:['Date','setTimeout','clearTimeout']}); vi.setSystemTime(1_000_000);
  dir=mkdtempSync('/tmp/botmux-card-probe-state-'); config.session.dataDir=dir;
  store=new TurnReplyCardStore(dir); patches=0; remote='';
  bot={config:{apiOnly:false,larkAppId:key.larkAppId,replyCardMode:'unified',cliId:'claude-code'}};
  vi.mocked(getBot).mockReturnValue(bot); vi.mocked(updateMessage).mockReset();
  vi.mocked(updateMessage).mockImplementation(async (_app,_id,card)=>{patches++;remote=card;});
  io={render:r=>buildTurnReplyCard(r,{canStop:true,showProcess:true}), beforeEffect:()=>{if(bot.config.apiOnly)throw Error('disabled')},
    isWithdrawn:e=>e instanceof Error && e.message==='withdrawn', send:async card=>{remote=card;return 'om_existing'},
    patch:async (_id,card)=>{patches++;remote=card}};
  await store.prepare(key,input); await store.update(key,{kind:'start'},io);
 });
 afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();rmSync(dir,{recursive:true,force:true})});
 async function pending() {
  const real=io.patch; io.patch=async()=>{throw Error('PATCH unavailable')};
  await expect(store.update(key,{kind:'terminal',phase:'completed',durationMs:1234},io)).rejects.toThrow('PATCH unavailable');
  io.patch=real; vi.setSystemTime(2_000_000);
 }
 it('settles an old disconnected reply while preserving the successor display owner',async()=>{
  await store.update(key,{kind:'terminal',phase:'ambiguous',disconnected:true},io);
  await store.update(key,{kind:'final',text:'RECOVERY_OK',source:'explicit',card:JSON.stringify({schema:'2.0',body:{elements:[{tag:'markdown',content:'RECOVERY_OK'}]}})},io);
  const ds:any={larkAppId:key.larkAppId,chatId:input.chatId,chatType:'group',rootMessageId:input.rootId,
    replyCardRunningTurnId:'successor',session:{sessionId:key.sessionId,status:'active',rootMessageId:input.rootId}};
  await drain(settleTurnReplyCardTerminal(ds,{turnId:key.turnId,status:'completed',durationMs:123},async()=>{throw Error('must patch existing card')},()=>true));
  expect(store.read(key)).toMatchObject({phase:'completed',finalDelivered:true,durationMs:123});
  expect(store.read(key)?.disconnected).toBeUndefined();
  expect(remote).toContain('RECOVERY_OK');expect(remote).not.toContain('执行状态待确认');
  expect(ds.replyCardRunningTurnId).toBe('successor');
 });
 it('forwards a nothing-to-send terminal into the persisted silent-turn card',async()=>{
  const ds:any={larkAppId:key.larkAppId,chatId:input.chatId,chatType:'group',rootMessageId:input.rootId,
    session:{sessionId:key.sessionId,status:'active',rootMessageId:input.rootId}};
  await drain(settleTurnReplyCardTerminal(ds,{turnId:key.turnId,status:'completed',durationMs:123,
    outputDisposition:'nothing_to_send'},async()=>{throw Error('must patch existing card')},()=>true));
  expect(store.read(key)).toMatchObject({phase:'completed',silentTurn:true,durationMs:123});
  expect(remote).toContain('worker.turn_terminal_receipt.silent_superseded');
  expect(remote).not.toContain('本轮没有提供最终答复');
 });
 it('does not mark a failed required-reply turn as deliberately silent',async()=>{
  const ds:any={larkAppId:key.larkAppId,chatId:input.chatId,chatType:'group',rootMessageId:input.rootId,
    session:{sessionId:key.sessionId,status:'active',rootMessageId:input.rootId}};
  await drain(settleTurnReplyCardTerminal(ds,{turnId:key.turnId,status:'failed',durationMs:88,
    outputDisposition:'nothing_to_send'},async()=>{throw Error('must patch existing card')},()=>true));
  expect(store.read(key)?.silentTurn).toBeUndefined();
  expect(remote).not.toContain('silent_superseded');
 });
 it('masks a content-audit-rejected recovery PATCH instead of leaving the card unsettled',async()=>{
  // The final (with an email) is already in the card; the terminal PATCH is left
  // pending, and recovery re-renders the whole card including that final.
  const email='alice.liu@example.com';
  await store.update(key,{kind:'final',text:`作者 <${email}>`,source:'explicit',card:JSON.stringify({schema:'2.0',body:{elements:[{tag:'markdown',content:`作者 <${email}>`}]}})},io);
  await pending();
  const audit={isAxiosError:true,name:'AxiosError',message:'Request failed with status code 400',
    response:{status:400,data:{code:230028,msg:'contain sensitive data: EMAIL_ADDRESS'}}};
  const bodies:string[]=[];
  vi.mocked(updateMessage).mockImplementation(async (_app,_id,card)=>{bodies.push(card);if(card.includes(email))throw audit;patches++;remote=card;});
  await sweepInterruptedReplyCards(key.larkAppId);
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toContain(email);
  expect(remote).not.toContain(email);
  expect(remote).toContain('example.com');
  expect(remote).toContain('worker.final_output_content_audit_redacted_note');
  expect(store.read(key)?.pendingPatch).toBeUndefined();
  expect(store.read(key)?.phase).toBe('completed');
 });
 it('rebuilds a terminal update after its pending payload journal write fails',async()=>{
  const oldRemote=remote; const write=(store as any).write.bind(store);
  const fail=vi.spyOn(store as any,'write').mockImplementation((k:any,r:any)=>{
   if(r.pendingPatch)throw Object.assign(Error('injected ENOSPC pending journal'),{code:'ENOSPC'}); return write(k,r);
  });
  await expect(store.update(key,{kind:'terminal',phase:'cancelled',durationMs:100},io)).rejects.toThrow('ENOSPC');
  fail.mockRestore(); vi.setSystemTime(2_000_000);
  const disk=new TurnReplyCardStore(dir).read(key)!;
  await sweepInterruptedReplyCards(key.larkAppId); await sweepInterruptedReplyCards(key.larkAppId);
  expect(disk.phase).toBe('cancelled');expect(disk.publishPending).toBe(true);expect(patches).toBe(1);expect(remote).not.toBe(oldRemote);expect(remote).toContain('已停止');expect(store.read(key)?.publishPending).toBeUndefined();
 });
 it('retains recoverability after a refresh renderer fails',async()=>{
  await pending(); const previous=store.read(key)!.pendingPatch!.content; const oldRemote=remote;
  io.render=()=>{throw Error('injected render failure')};
  await expect(store.update(key,{kind:'refresh'},io)).rejects.toThrow('render failure');
  const disk=store.read(key)!;
  await sweepInterruptedReplyCards(key.larkAppId);await sweepInterruptedReplyCards(key.larkAppId);
  expect(disk.phase).toBe('completed');expect(disk.pendingPatch).toBeUndefined();expect(disk.publishPending).toBe(true);expect(remote).not.toBe(oldRemote);expect(patches).toBe(1);expect(store.read(key)?.publishPending).toBeUndefined();
 });
 it('rechecks terminal state under lock when a sweep queued behind its writer',async()=>{
  const actualPatch=io.patch;io.patch=async()=>{throw Error('PATCH unavailable')};
  await expect(store.update(key,{kind:'final',text:'FINAL-ANSWER-PROBE',source:'explicit',card:JSON.stringify({schema:'2.0',body:{elements:[{tag:'markdown',content:'FINAL-ANSWER-PROBE'}]}})},io)).rejects.toThrow('PATCH unavailable');
  const gate=deferred();const entered=deferred();let gates=0;
  const writer={...io,beforeEffect:async()=>{if(gates++===0){entered.resolve();await gate.promise}}};
  const terminal=store.update(key,{kind:'terminal',phase:'completed'},writer).catch(e=>e.message);await entered.promise;
  const sweep=sweepInterruptedReplyCards(key.larkAppId);await yieldIO();await vi.advanceTimersByTimeAsync(1000);
  gate.resolve();expect(await drain(terminal)).toBe('PATCH unavailable');await drain(sweep);
  const disk=store.read(key)!;
  expect(disk.phase).toBe('completed');expect(disk.finalDelivered).toBe(true);expect(disk.pendingPatch).toBeUndefined();expect(disk.publishPending).toBeUndefined();expect(remote).toContain('FINAL-ANSWER-PROBE');
  const count=patches;await sweepInterruptedReplyCards(key.larkAppId);expect(patches).toBe(count);
 });
 it('concurrent recovery callers serialize and publish only once',async()=>{
  await pending(); const gate=deferred();const entered=deferred();let active=0;let maxActive=0;
  io.patch=async(_id,card)=>{active++;maxActive=Math.max(active,maxActive);patches++;entered.resolve();await gate.promise;remote=card;active--};
  const first=store.update(key, { kind: 'recover' },io);await entered.promise;
  const others=Array.from({length:4},()=>new TurnReplyCardStore(dir).update(key, { kind: 'recover' },io));
  await yieldIO();await vi.advanceTimersByTimeAsync(1000);expect(patches).toBe(1);
  gate.resolve();await drain(Promise.all([first,...others]));expect(patches).toBe(1);expect(maxActive).toBe(1);expect(store.read(key)?.pendingPatch).toBeUndefined();
 });
 it('configuration disabled while a recovery waits for lock blocks its effect and remains retryable',async()=>{
  await pending();const gate=deferred();const entered=deferred();
  const blocker={...io,patch:async()=>{entered.resolve();await gate.promise;throw Error('first writer failed')}};
  const first=store.update(key, { kind: 'recover' },blocker).catch(e=>e.message);await entered.promise;
  const second=store.update(key, { kind: 'recover' },io).catch(e=>e.message);await yieldIO();await vi.advanceTimersByTimeAsync(500);
  bot.config.apiOnly=true;gate.resolve();expect(await drain(first)).toBe('first writer failed');expect(await drain(second)).toBe('disabled');expect(patches).toBe(0);expect(store.read(key)?.pendingPatch).toBeDefined();
  bot.config.apiOnly=false;await drain(store.update(key, { kind: 'recover' },io));expect(patches).toBe(1);
 });
 it('provider withdrawal during recovery suppresses all waiting reentries',async()=>{
  await pending();const gate=deferred();const entered=deferred();let attempts=0;
  io.patch=async()=>{attempts++;entered.resolve();await gate.promise;throw Error('withdrawn')};
  const first=store.update(key, { kind: 'recover' },io).catch(e=>e.name);await entered.promise;
  const second=store.update(key, { kind: 'recover' },io);await yieldIO();await vi.advanceTimersByTimeAsync(500);gate.resolve();
  expect(await drain(first)).toBe('ReplyCardWithdrawnError');await drain(second);await store.update(key, { kind: 'recover' },io);
  expect(attempts).toBe(1);expect(store.read(key)?.withdrawn).toBe(true);
 });
 it('human cancellation queued during recovery wins after the in-flight PATCH',async()=>{
  const actualPatch=io.patch;io.patch=async()=>{throw Error('PATCH unavailable')};
  await expect(store.update(key,{kind:'terminal',phase:'ambiguous',disconnected:true},io)).rejects.toThrow('PATCH unavailable');
  const gate=deferred();const entered=deferred();let first=true;
  io.patch=async(id,card)=>{if(first){first=false;entered.resolve();await gate.promise}await actualPatch(id,card)};
  const recovery=store.update(key, { kind: 'recover' },io);await entered.promise;
  const cancel=store.update(key,{kind:'terminal',phase:'cancelled',durationMs:444},io);
  const reentry=new TurnReplyCardStore(dir).update(key, { kind: 'recover' },io);
  await yieldIO();await vi.advanceTimersByTimeAsync(1000);gate.resolve();await drain(Promise.all([recovery,cancel,reentry]));
  expect(store.read(key)).toMatchObject({phase:'cancelled',durationMs:444});expect(store.read(key)?.pendingPatch).toBeUndefined();expect(remote).toBe(io.render(store.read(key)!));expect(patches).toBe(2);
 });
 it('recovery wait timeout does not steal the live publisher lock or duplicate its PATCH',async()=>{
  await pending();const gate=deferred();const entered=deferred();
  io.patch=async(_id,card)=>{patches++;entered.resolve();await gate.promise;remote=card};
  const first=store.update(key, { kind: 'recover' },io);await entered.promise;
  const second=store.update(key, { kind: 'recover' },io).catch(e=>e.name);await yieldIO();await vi.advanceTimersByTimeAsync(100);
  vi.setSystemTime(Date.now()+61_000);expect(await drain(second)).toBe('FileLockTimeoutError');expect(patches).toBe(1);expect(store.read(key)?.pendingPatch).toBeDefined();
  gate.resolve();await drain(first);await store.update(key, { kind: 'recover' },io);expect(patches).toBe(1);expect(store.read(key)?.pendingPatch).toBeUndefined();
 });
 it('remote accepted but acknowledgement persistence fails: new store replays exact body',async()=>{
  await pending();const expected=store.read(key)!.pendingPatch!.content;
  const write=(store as any).write.bind(store);const fail=vi.spyOn(store as any,'write').mockImplementation((k:any,r:any)=>{
   if(!r.pendingPatch)throw Error('injected acknowledgement fsync failure');return write(k,r);
  });
  await expect(store.update(key, { kind: 'recover' },io)).rejects.toThrow('fsync');expect(remote).toBe(expected);expect(store.read(key)?.pendingPatch).toBeDefined();
  fail.mockRestore();await new TurnReplyCardStore(dir).update(key, { kind: 'recover' },io);expect(patches).toBe(2);expect(remote).toBe(expected);expect(store.read(key)?.pendingPatch).toBeUndefined();
 });
});

describe('cardTerminalForRequiredReply fail-closed rule', () => {
  const base = { turnId: 'om_probe', status: 'completed' as const, outputDisposition: 'nothing_to_send' as const };
  it('rewrites an unanswered required empty turn to failed while preserving its fields', () => {
    const result = cardTerminalForRequiredReply(base, true, () => false);
    expect(result).toMatchObject({ turnId: 'om_probe', status: 'failed', outputDisposition: 'nothing_to_send' });
    expect(result).not.toBe(base);
  });
  it.each([
    ['the answer is already on the send ledger', true, true],
    ['the sink did not require an answer', false, false],
  ])('keeps a completed terminal when %s', (_name, answerRequired, answered) => {
    expect(cardTerminalForRequiredReply(base, answerRequired, () => answered).status).toBe('completed');
  });
  it('leaves non-completed terminals untouched even when an answer is still required', () => {
    for (const status of ['failed', 'cancelled', 'ambiguous'] as const) {
      expect(cardTerminalForRequiredReply({ ...base, status }, true, () => false).status).toBe(status);
    }
  });
  it('treats only nothing_to_send and empty_answer as silence-shaped empty output', () => {
    expect(cardTerminalForRequiredReply({ ...base, outputDisposition: 'empty_answer' }, true, () => false).status).toBe('failed');
    for (const outputDisposition of ['boundary_unobserved', 'explicit_final_delivered', undefined] as const) {
      expect(cardTerminalForRequiredReply({ ...base, outputDisposition }, true, () => false).status).toBe('completed');
    }
  });
  it('never evaluates the answer probe unless the rewrite is actually possible', () => {
    const probe = vi.fn(() => false);
    cardTerminalForRequiredReply(base, false, probe);
    cardTerminalForRequiredReply({ ...base, status: 'failed' }, true, probe);
    cardTerminalForRequiredReply({ ...base, outputDisposition: 'boundary_unobserved' }, true, probe);
    expect(probe).not.toHaveBeenCalled();
    cardTerminalForRequiredReply(base, true, probe);
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('cardTerminalForHistoricalReply replayed-terminal rule', () => {
  const base = { turnId: 'om_probe', status: 'completed' as const, outputDisposition: 'nothing_to_send' as const };
  const imRequired = { kind: 'im', context: {} as any, chatId: 'oc_probe', chatType: 'p2p' as const, answerRequired: true };
  const imOptional = { kind: 'im', context: {} as any, chatId: 'oc_probe', chatType: 'group' as const };
  it('rewrites a required, unanswered replayed silent turn to failed', () => {
    expect(cardTerminalForHistoricalReply(base, imRequired, () => undefined).status).toBe('failed');
  });
  it('keeps completed when the send ledger proves the final was delivered', () => {
    expect(cardTerminalForHistoricalReply(base, imRequired, () => 'om_final').status).toBe('completed');
  });
  it('keeps completed for an IM sink without an answer requirement', () => {
    expect(cardTerminalForHistoricalReply(base, imOptional, () => undefined).status).toBe('completed');
  });
  it.each([
    ['an http sink', { kind: 'http', mode: 'wait' as const }],
    ['a missing sink', undefined],
  ])('keeps completed when no required reply is provable (%s)', (_name, sink) => {
    expect(cardTerminalForHistoricalReply(base, sink as any, () => undefined).status).toBe('completed');
  });
  it('also fails closed for empty_answer on a required unanswered turn', () => {
    expect(cardTerminalForHistoricalReply({ ...base, outputDisposition: 'empty_answer' }, imRequired, () => undefined).status).toBe('failed');
  });
  it('does not read the ledger when the terminal cannot be a silence-shaped rewrite', () => {
    const probe = vi.fn(() => undefined);
    cardTerminalForHistoricalReply(base, imOptional, probe);
    cardTerminalForHistoricalReply({ ...base, status: 'failed' }, imRequired, probe);
    cardTerminalForHistoricalReply({ ...base, outputDisposition: 'boundary_unobserved' }, imRequired, probe);
    cardTerminalForHistoricalReply(base, undefined, probe);
    expect(probe).not.toHaveBeenCalled();
  });
  it('contains a throwing ledger probe and fails closed instead of breaking event acknowledgement', () => {
    const throwingProbe = vi.fn(() => { throw new SyntaxError("Expected property name or '}' in JSON"); });
    const result = cardTerminalForHistoricalReply(base, imRequired, throwingProbe);
    expect(throwingProbe).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('failed');
  });
  it('a throwing probe on a non-rewritable terminal never runs and leaves the terminal untouched', () => {
    const throwingProbe = vi.fn(() => { throw new SyntaxError('corrupted ledger'); });
    const result = cardTerminalForHistoricalReply({ ...base, status: 'cancelled' }, imRequired, throwingProbe);
    expect(throwingProbe).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
  });
  it('survives a real corrupted send-ledger file and still fails closed', () => {
    const ledgerDir = mkdtempSync('/tmp/botmux-corrupt-ledger-');
    try {
      const ledgerKey = { larkAppId: 'app_probe', sessionId: 'session_probe', turnId: 'om_ledger', dispatchAttempt: 0 };
      const ledger = new TurnSendLedger(ledgerDir);
      const ledgerPath = ledger.recordPath(ledgerKey);
      mkdirSync(dirname(ledgerPath), { recursive: true });
      writeFileSync(ledgerPath, '{ broken json');
      const result = cardTerminalForHistoricalReply(base, imRequired, () =>
        new TurnSendLedger(ledgerDir).readFinalForAttempt(ledgerKey)?.messageId);
      expect(result.status).toBe('failed');
    } finally {
      rmSync(ledgerDir, { recursive: true, force: true });
    }
  });
});

describe('readHistoricalSink durable-read containment', () => {
  const imSink = { kind: 'im', context: {}, chatId: 'oc_probe', chatType: 'p2p', answerRequired: true } as const;
  it('returns undefined when no journal is available', () => {
    expect(readHistoricalSink(undefined, 'session', 'om_turn')).toBeUndefined();
  });
  it('passes the sink through on a healthy read', () => {
    const journal = { sink: vi.fn(() => imSink as any) };
    expect(readHistoricalSink(journal, 'session', 'om_turn')).toEqual(imSink);
    expect(journal.sink).toHaveBeenCalledWith('session', 'om_turn');
  });
  it('contains a throwing sink read instead of blocking event acknowledgement', () => {
    const journal = { sink: vi.fn(() => { throw new Error('database disk image is malformed'); }) };
    expect(readHistoricalSink(journal, 'session', 'om_turn')).toBeUndefined();
    expect(journal.sink).toHaveBeenCalledTimes(1);
  });
});
