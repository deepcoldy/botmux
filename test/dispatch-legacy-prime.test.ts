import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, it, expect, vi } from 'vitest';
import { restoreDispatchTaskOwner, readTaskBinding } from '../src/im/lark/dispatch-task-consent.js';
import { createDispatchReportBinding } from '../src/core/dispatch-report-binding.js';
import { deliverDispatchWithUser, resolveDispatchUser } from '../src/core/dispatch-user-delegation.js';

// Execute the actual platform wrapper; only provider reads and app mapping are
// substituted. Signature and legacy owner checks below use the real stores.
const source = ts.createSourceFile('client.ts', readFileSync('src/im/lark/client.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'firstDispatchReply');
if (!declaration) throw new Error('missing firstDispatchReply');
const code = ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const cardDeclaration = source.statements.find(node =>
  ts.isFunctionDeclaration(node) && node.name?.text === 'dispatchConsentCardAvailable');
if (!cardDeclaration) throw new Error('missing dispatchConsentCardAvailable');
const cardCode = ts.transpileModule(cardDeclaration.getText(source).replace(/^export /, ''), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const seed = { message_id: 'om_root', chat_id: 'oc_hub', thread_id: 'omt_task',
  sender: { id: 'cli_source', sender_type: 'app' } };
const reply = (id: string, type = 'post') => ({ ...seed, message_id: id, root_id: 'om_root', msg_type: type });
const prime = { ...reply('om_prime', 'text'), body: { content: JSON.stringify({ text: '@_user_1 /repo /work/repo' }) },
  mentions: [{ key: '@_user_1', id: 'ou_target', id_type: 'open_id' }] };
function harness(items: unknown[], mapping = 'ou_target') {
  const larkGet = vi.fn(async (_client, _path, params) => {
    expect(params).toMatchObject({ container_id: 'omt_task', sort_type: 'ByCreateTimeAsc', page_size: 3 });
    return { code: 0, data: { items } };
  });
  const scope = { getMessageDetail: async () => ({ items: [seed] }), getBotClient: () => ({}),
    larkGet, larkApiError: () => new Error('provider failed'),
    resolveCurrentChatBotOpenIdsByLarkAppIds: async () => ({ ok: true,
      mappings: [{ larkAppId: 'cli_target', subjectOpenId: mapping }] }) };
  return new Function('scope', `with(scope) { ${code}; return firstDispatchReply; }`)(scope) as
    (app: string, chat: string, root: string, target: string) => Promise<string | undefined>;
}
const lookup = (items: unknown[], mapping?: string) => harness(items, mapping)('cli_source', 'oc_hub', 'om_root', 'cli_target');

describe('legacy dispatch kickoff after repo initialization', () => {
  it('uses the first ordinary kickoff without looking at later replies', async () => {
    expect(await lookup([seed, reply('om_first'), reply('om_later')])).toBe('om_first');
  });
  it('skips exactly one verified repo prime and uses its immediate kickoff', async () => {
    expect(await lookup([seed, prime, reply('om_kickoff')])).toBe('om_kickoff');
  });
  it.each([
    { ...prime, body: { content: JSON.stringify({ text: '@_user_1 please /repo /work/repo' }) } },
    { ...prime, body: { content: JSON.stringify({ text: '@_user_1 /repo /work\nlater command' }) } },
    { ...prime, mentions: [prime.mentions[0], { ...prime.mentions[0], key: '@_user_2' }] },
  ])('does not skip an unproven initialization message', async unproven => {
    expect(await lookup([seed, unproven, reply('om_later')])).toBe('om_prime');
  });
  it.each([
    { ...reply('om_kickoff'), chat_id: 'oc_other' },
    { ...reply('om_kickoff'), root_id: 'om_other' },
    { ...reply('om_kickoff'), thread_id: 'omt_other' },
    { ...reply('om_kickoff'), sender: { id: 'cli_other', sender_type: 'app' } },
    { ...reply('om_kickoff'), deleted: true },
    reply('om_more_prime', 'text'),
  ])('rejects a nonmatching immediate reply and does not scan a later kickoff', async next => {
    expect(await lookup([seed, prime, next, reply('om_later')])).toBeUndefined();
  });
  it('refuses a repo prime addressed to a different app', async () => {
    expect(await lookup([seed, prime, reply('om_kickoff')], 'ou_other')).toBeUndefined();
  });
  it('restores ownership using the immediate signed kickoff, never the unsigned prime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'legacy-prime-'));
    try {
      const owner = { openId: 'ou_human', receivingAppId: 'cli_target', receivingChatId: 'oc_hub' };
      const binding = createDispatchReportBinding('test-key', { dispatchRoot: 'om_root',
        targetSessionId: 'source-session', targetLarkAppId: 'cli_source', targetChatId: 'oc_source',
        targetScope: 'thread', sourceName: 'test', issuedAt: new Date().toISOString() }).payload;
      writeFileSync(join(dir, 'orchestrate-dispatch.json'), JSON.stringify({
        om_root: { reportBinding: createDispatchReportBinding('test-key', binding) },
      }));
      await deliverDispatchWithUser({ dataDir: dir, secret: 'test-key', payload: {
        sourceAppId: 'cli_source', sourceSessionId: 'source-session', sourceTurnId: 'om_human_input',
        rootId: 'om_root', chatId: 'oc_hub', targetAppIds: ['cli_target'],
        authority: { appId: 'cli_source', openId: 'ou_human', unionId: 'on_human', tools: ['bytedcli'] },
      }, send: async () => 'om_kickoff' });
      await restoreDispatchTaskOwner({ dataDir: dir, secret: 'test-key', binding, owner,
        sourceRootId: 'om_source', firstReply: () => lookup([seed, prime, reply('om_kickoff')]),
        original: turnId => resolveDispatchUser({ dataDir: dir, secret: 'test-key', appId: 'cli_target',
          chatId: 'oc_hub', rootId: 'om_root', turnId, waitMs: 0 }),
        sourceMessage: async () => ({ items: [{ message_id: 'om_human_input', chat_id: 'oc_source',
          root_id: 'om_source', sender: { sender_type: 'user', id_type: 'open_id', id: 'ou_human' } }] }),
      });
      expect((await readTaskBinding(dir, 'test-key', 'om_root'))?.taskOwner).toEqual(owner);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('consent card provider availability', () => {
  function check(value: unknown, error?: Error & { code?: number }) {
    const read = async () => { if (error) throw error; return { items: value ? [value] : [] }; };
    const scope = { getMessageDetail: read, getLarkErrorCode: (e: { code?: number }) => e.code,
      LARK_CODE_MESSAGE_WITHDRAWN: 230011 };
    const run = new Function('scope', `with(scope) { ${cardCode}; return dispatchConsentCardAvailable; }`)(scope);
    return run('cli_source', 'oc_source', 'om_card') as Promise<boolean>;
  }
  const card = { message_id: 'om_card', chat_id: 'oc_source', msg_type: 'interactive',
    sender: { id: 'cli_source', sender_type: 'app' } };
  it('accepts only the exact original card and source app', async () => {
    expect(await check(card)).toBe(true);
    for (const other of [undefined, { ...card, deleted: true }, { ...card, message_id: 'om_copy' },
      { ...card, chat_id: 'oc_other' }, { ...card, msg_type: 'text' },
      { ...card, sender: { id: 'cli_other', sender_type: 'app' } }]) {
      expect(await check(other)).toBe(false);
    }
  });
  it('treats explicit withdrawal as unavailable but propagates inconclusive errors', async () => {
    expect(await check(undefined, Object.assign(new Error('withdrawn'), { code: 230011 }))).toBe(false);
    await expect(check(undefined, Object.assign(new Error('permission unavailable'), { code: 99991672 })))
      .rejects.toThrow('permission unavailable');
  });
});
