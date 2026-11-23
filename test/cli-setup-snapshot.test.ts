import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import {
  BotsJsonStaleSnapshotError,
  readBotsJsonOrEmpty,
  trackBotsJsonSnapshot,
  writeBotsJsonAtomic,
} from '../src/setup/bots-store.js';
import { parseBotConfigsJson } from '../src/setup/bot-config-editor.js';

// 非文本断言：AST 抽取并执行真实 CLI setup 函数，只模拟用户菜单与配置提示；
// 验证跨函数的快照来源和真实磁盘结果，不断言源码文本或函数排列。
const cliPath = new URL('../src/cli.ts', import.meta.url).pathname;
const cliSourceText = readFileSync(cliPath, 'utf8');
const cliSource = ts.createSourceFile(cliPath, cliSourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const functionNames = ['loadBotsJson', 'writeBotsJsonAtomic', 'writeSingleBotConfig', 'cmdSetup'];
const declarations = cliSource.statements.filter((statement): statement is ts.FunctionDeclaration => (
  ts.isFunctionDeclaration(statement) && !!statement.name && functionNames.includes(statement.name.text)
));
if (declarations.length !== functionNames.length) throw new Error('Cannot locate the CLI setup snapshot operations');
const operation = ts.transpileModule(declarations.map(declaration => (
  ts.createPrinter().printNode(ts.EmitHint.Unspecified, declaration, cliSource)
)).join('\n'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

describe('interactive setup snapshot provenance', () => {
  it('does not refresh away a concurrent creation while the first .env menu is open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-cli-setup-snapshot-'));
    const botsPath = join(root, 'bots.json');
    const envPath = join(root, '.env');
    writeFileSync(envPath, 'LARK_APP_ID=cli_legacy\nLARK_APP_SECRET=legacy\n');
    const externalSnapshot = readBotsJsonOrEmpty(botsPath);
    const externalBot = {
      larkAppId: 'cli_external', larkAppSecret: 'external-secret', name: 'External-Name', model: 'must-survive',
    };
    const replacementBot = { larkAppId: 'cli_replacement', larkAppSecret: 'replacement-secret' };
    const scope: Record<string, any> = {
      BOTS_JSON_FILE: botsPath,
      ENV_FILE: envPath,
      existsSync,
      readFileSync,
      renameSync,
      parseBotConfigsJson,
      trackBotsJsonSnapshot,
      writeBotsAtomic: writeBotsJsonAtomic,
      normalizeBotsForWrite: (bots: any[]) => bots,
      ensureConfigDir: () => undefined,
      createInterface: () => ({ close: () => undefined }),
      t: (key: string) => key,
      getDefaultLocale: () => 'en',
      finishInteractiveOpenPlatformSetup: async () => undefined,
      promptBotConfig: async () => replacementBot,
      pickChoice: async () => {
        // Another setup process commits while this user is still at the first menu.
        writeBotsJsonAtomic(botsPath, [externalBot], externalSnapshot);
        return 1; // overwrite .env -> writeSingleBotConfig
      },
      console: { log: () => undefined, error: console.error },
    };
    const proxy = new Proxy(scope, {
      has: (_target, key) => key !== Symbol.unscopables,
      get: (target, key) => key in target ? target[key as string] : (globalThis as any)[key],
      set: (target, key, value) => { target[key] = value; return true; },
    });
    try {
      const cmdSetup = new Function('scope', `with (scope) { ${operation}; return cmdSetup; }`)(proxy) as () => Promise<void>;
      await expect(cmdSetup()).rejects.toBeInstanceOf(BotsJsonStaleSnapshotError);
      const persisted = readBotsJsonOrEmpty(botsPath);
      expect(persisted).toEqual([externalBot]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
