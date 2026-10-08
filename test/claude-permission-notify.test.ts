import { afterEach, expect, it, vi } from 'vitest';
import { claudePermissionCommandHash, claudePermissionScreen, ClaudePermissionNotifier } from '../src/services/claude-permission-notify.js';
import { runHook } from '../src/cli.js';
import { parseAskBody } from '../src/core/ask-api.js';
import { _resetForTest, registerAsk, listPendingAsks, setCardDispatcher, invalidateAll } from '../src/core/ask-broker.js';
import type { PendingAsk } from '../src/core/ask-types.js';

const scope = { larkAppId: 'app', sessionId: 'session', chatId: 'chat', rootMessageId: 'root' };
const payload = (command = 'rm -f $SCRATCH_DIR/*.png') => ({hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: {command}});
const screen = (command = 'rm -f $SCRATCH_DIR/*.png', fork = false) => [
  fork ? '✻ Waiting for 1 background agent to finish' : 'working',
  ` Bash command${fork ? ' · from the fork agent' : ''}`, ' task description',
  '╌╌╌╌╌╌╌╌╌╌╌╌', ` │ ${command}`, '╌╌╌╌╌╌╌╌╌╌╌╌',
  ' │ Dangerous rm operation', ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel · Tab to amend',
].join('\n');
const dialog = () => claudePermissionScreen(screen())!;
const ask = (over: Partial<PendingAsk> = {}): PendingAsk => ({
  ...scope, askId: 'ask', nonce: 'nonce', originKind: 'hook', questions: [], createdAt: 1,
  deadlineAt: Date.now() + 60000, settled: false, hookWaiting: true, cardMessageId: 'card',
  permissionCommandHash: claudePermissionCommandHash(payload()), ...over,
});
afterEach(() => _resetForTest());

it.each([false, true])('correlates exact command on main/fork screen (%s), without projecting args', fork => {
  const d = claudePermissionScreen(screen(undefined, fork))!;
  expect(d.commandHash).toBe(claudePermissionCommandHash(payload()));
  expect(d.message).not.toContain('SCRATCH_DIR');
  expect(JSON.stringify(d)).not.toContain('rm -f');
});
it('leaves wrapped/multiline/truncated/unknown tool dialogs uncovered', () => {
  expect(claudePermissionScreen(screen('echo one\n │ echo two'))!.commandHash).toBeUndefined();
  expect(claudePermissionScreen(screen('echo …'))!.commandHash).toBeUndefined();
  expect(claudePermissionScreen(screen().replace('Bash command', 'Read file'))!.commandHash).toBeUndefined();
  expect(claudePermissionCommandHash(payload('echo one\necho two'))).toBeUndefined();
  expect(claudePermissionCommandHash({...payload(), tool_name: 'AskUserQuestion'})).toBeUndefined();
});
it('does not fold whitespace inside shell strings', () => {
  expect(claudePermissionCommandHash(payload('echo "a  b"'))).not.toBe(claudePermissionCommandHash(payload('echo "a b"')));
});
it('suppressed static screen recovers when hook ends, then dedups actual delivery', async () => {
  const n = new ClaudePermissionNotifier(), send = vi.fn(async () => true);
  await n.observe(dialog(), scope, [ask()], send);
  expect(send).not.toHaveBeenCalled();
  await n.observe(dialog(), scope, [], send);
  await n.observe(dialog(), scope, [], send);
  expect(send).toHaveBeenCalledTimes(1);
});
it.each([
  {permissionCommandHash: undefined}, {permissionCommandHash: 'other'}, {originKind: 'explicit'},
  {sessionId: 'other'}, {larkAppId: 'other'}, {chatId: 'other'}, {rootMessageId: 'other'},
  {cardMessageId: undefined}, {hookWaiting: false}, {settled: true}, {deadlineAt: 1},
])('does not suppress for an unrelated/undelivered/finished ask %j', async over => {
  const send = vi.fn(async () => true);
  await new ClaudePermissionNotifier().observe(dialog(), scope, [ask(over)], send);
  expect(send).toHaveBeenCalledOnce();
});
it('unrelated concurrent ask cannot prevent fallback after matching card ends', async () => {
  const n = new ClaudePermissionNotifier(), send = vi.fn(async () => true);
  const unrelated = ask({permissionCommandHash: undefined});
  await n.observe(dialog(), scope, [unrelated, ask()], send);
  await n.observe(dialog(), scope, [unrelated], send);
  expect(send).toHaveBeenCalledOnce();
});
it('retries delivery failure and rearms after disappearance or a new command', async () => {
  const n = new ClaudePermissionNotifier(), send = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
  await n.observe(dialog(), scope, [], send);
  await n.observe(dialog(), scope, [], send);
  await n.observe({}, scope, [], send);
  await n.observe(dialog(), scope, [], send);
  await n.observe(claudePermissionScreen(screen('echo other'))!, scope, [], send);
  expect(send).toHaveBeenCalledTimes(4);
});
it('serializes delivery while observations overlap', async () => {
  let finish!: (ok: boolean) => void;
  const send = vi.fn(() => new Promise<boolean>(resolve => {finish = resolve;}));
  const n = new ClaudePermissionNotifier();
  const first = n.observe(dialog(), scope, [], send);
  await n.observe(dialog(), scope, [], send);
  finish(true); await first;
  expect(send).toHaveBeenCalledOnce();
});
it('carries correlation from real runHook through API and broker, then recovers on invalidation', async () => {
  _resetForTest();
  setCardDispatcher({send: async () => ({messageId: 'card'}), onSettle: async () => {}});
  let done!: () => void;
  const registered = new Promise<void>(resolve => {done = resolve;});
  const hook = runHook(payload(), {
    BOTMUX_SESSION_ID: scope.sessionId, BOTMUX_CHAT_ID: scope.chatId,
    BOTMUX_LARK_APP_ID: scope.larkAppId, BOTMUX_ROOT_MESSAGE_ID: scope.rootMessageId,
  }, async body => {
    const parsed = parseAskBody(body);
    if ('error' in parsed) throw new Error(parsed.error);
    const result = registerAsk(parsed);
    done(); return result;
  }, 'claude-code', async () => null, undefined, () => undefined);
  await registered;
  await vi.waitFor(() => expect(listPendingAsks()[0]?.cardMessageId).toBe('card'));
  const n = new ClaudePermissionNotifier(), send = vi.fn(async () => true);
  await n.observe(dialog(), scope, listPendingAsks(), send);
  expect(send).not.toHaveBeenCalled();
  invalidateAll('test'); await hook;
  await n.observe(dialog(), scope, listPendingAsks(), send);
  expect(send).toHaveBeenCalledOnce();
});

it('rejects malformed optional correlation metadata without altering legacy ask bodies', () => {
  const body = {...scope, questions: [{prompt: 'Q', multiSelect: false, options: [{key: 'a', label: 'A'}, {key: 'b', label: 'B'}]}], timeoutMs: 1000};
  expect(parseAskBody(body)).not.toHaveProperty('error');
  expect(parseAskBody({...body, permissionCommandHash: 'invalid'})).toEqual({error: 'bad_permissionCommandHash'});
});

it('does not re-notify when status text below the dialog changes', () => {
  const first = claudePermissionScreen(screen() + '\n tokens: 10')!;
  const next = claudePermissionScreen(screen() + '\n tokens: 11')!;
  expect(next.dialogId).toBe(first.dialogId);
});
