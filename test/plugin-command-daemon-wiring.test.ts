import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { runPluginSlashCommand } from '../src/core/plugins/commands/execute.js';

// Execute the real daemon function without starting the daemon's module-level services.
const source = ts.createSourceFile('daemon.ts', readFileSync('src/daemon.ts', 'utf8'), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'executePluginSlashCommand');
if (!declaration) throw new Error('Missing executePluginSlashCommand');
const code = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

it('ignores primary commands and marks admitted before plugin execution otherwise', async () => {
  let primary = true;
  const mark = vi.fn();
  const execute = vi.fn(async () => ({ reply: { text: 'ok' } }));
  const reply = vi.fn();
  const scope = {
    coordinationModeIsPrimary: () => primary, runPluginSlashCommand,
    localeForBot: () => 'en', grantRestrictedSlashCommandText: () => undefined,
    canTalkForGroupSessions: () => true, canOperate: () => true,
    markIngressAdmitted: mark, pluginCommandGateway: { execute }, tr: () => 'text',
  };
  const proxy = new Proxy(scope, { has: (_, key) => key !== Symbol.unscopables, get: (target, key) => key in target ? (target as any)[key] : (globalThis as any)[key] });
  const run = new Function('scope', `with (scope) { ${code}; return executePluginSlashCommand; }`)(proxy);
  const ctx = {};
  const input = { ctx, decision: { cmd: '/plugin', content: '/plugin', pluginId: 'plugin' }, larkAppId: 'app', chatId: 'chat', anchor: 'anchor', messageId: 'msg', deps: { sessionReply: reply } };
  await run(input);
  expect(mark).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(reply).not.toHaveBeenCalled();
  primary = false;
  await run(input);
  expect(mark).toHaveBeenCalledWith(ctx);
  expect(execute).toHaveBeenCalledOnce();
  expect(mark.mock.invocationCallOrder[0]).toBeLessThan(execute.mock.invocationCallOrder[0]);
});
