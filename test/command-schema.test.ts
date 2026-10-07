/**
 * 命令 schema 是唯一事实源（设计 R4）：这里钉三件事——
 *   1. 从 schema 推导出的五个集合与 legacy oracle 里**冻结**的字面量集合逐字相等
 *      （oracle 不 import src，所以这是"表 ↔ 今天代码"的真差分，不是恒等式）；
 *   2. 每个命令的 help 键在 zh/en 两套文案里都存在（/help 由此组装）；
 *   3. 除 /vc-auth（只存在于路由前置特判）外，每个命令在 handleCommand 的 switch 里
 *      都有 `case '/xxx'`，反过来 switch 里每个 case 都在 schema 里——表与 switch 不漂移。
 *
 * Run: bun run vitest run test/command-schema.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  COMMANDS,
  DAEMON_COMMANDS,
  EXISTING_SESSION_ONLY_DAEMON_COMMANDS,
  FORCE_TOPIC_COMMANDS,
  MULTILINE_COMMANDS,
  ROUTE_SPECIAL_COMMANDS,
  SESSIONLESS_DAEMON_COMMANDS,
  commandSpec,
} from '../src/core/command-schema.js';
import { PASSTHROUGH_COMMANDS } from '../src/core/passthrough-commands.js';
import { messages as zh } from '../src/i18n/zh.js';
import { messages as en } from '../src/i18n/en.js';
import {
  ORACLE_DAEMON_COMMANDS,
  ORACLE_EXISTING_SESSION_ONLY_DAEMON_COMMANDS,
  ORACLE_MULTILINE_COMMANDS,
  ORACLE_SESSIONLESS_DAEMON_COMMANDS,
} from './legacy-oracle/slash-route-oracle.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sorted = (s: ReadonlySet<string>) => [...s].sort();

describe('command schema ↔ 冻结的 legacy 集合', () => {
  it('DAEMON_COMMANDS 逐字相等', () => {
    expect(sorted(DAEMON_COMMANDS)).toEqual(sorted(ORACLE_DAEMON_COMMANDS));
  });
  it('SESSIONLESS / EXISTING_SESSION_ONLY / MULTILINE 逐字相等', () => {
    expect(sorted(SESSIONLESS_DAEMON_COMMANDS)).toEqual(sorted(ORACLE_SESSIONLESS_DAEMON_COMMANDS));
    expect(sorted(EXISTING_SESSION_ONLY_DAEMON_COMMANDS)).toEqual(sorted(ORACLE_EXISTING_SESSION_ONLY_DAEMON_COMMANDS));
    expect(sorted(MULTILINE_COMMANDS)).toEqual(sorted(ORACLE_MULTILINE_COMMANDS));
  });
  it('子集关系与不相交关系（command-trigger 的 reservedCommandKind 依赖它）', () => {
    for (const c of SESSIONLESS_DAEMON_COMMANDS) expect(DAEMON_COMMANDS.has(c), c).toBe(true);
    for (const c of EXISTING_SESSION_ONLY_DAEMON_COMMANDS) expect(DAEMON_COMMANDS.has(c), c).toBe(true);
    for (const c of MULTILINE_COMMANDS) expect(DAEMON_COMMANDS.has(c), c).toBe(true);
    for (const c of PASSTHROUGH_COMMANDS) expect(DAEMON_COMMANDS.has(c), `${c} 同时在透传集与 daemon 集`).toBe(false);
    for (const c of FORCE_TOPIC_COMMANDS) expect(DAEMON_COMMANDS.has(c), c).toBe(false);
  });
  it('主名与别名互不重复、全小写、以 / 开头', () => {
    const all = COMMANDS.flatMap(s => [s.name, ...(s.aliases ?? [])]);
    expect(new Set(all).size).toBe(all.length);
    for (const n of all) expect(n).toMatch(/^\/[a-z][a-z0-9-]*$/);
    expect(commandSpec('/G')?.name).toBe('/group');
  });
});

describe('command schema ↔ /help 文案', () => {
  it('每个 help 键在 zh 与 en 里都存在', () => {
    for (const spec of COMMANDS) {
      for (const key of spec.help) {
        expect(key in zh, `zh 缺 ${key}（${spec.name}）`).toBe(true);
        expect(key in en, `en 缺 ${key}（${spec.name}）`).toBe(true);
      }
    }
  });
  it('/help 组装用到的 help.* 键都能在 schema 里找到归属（或属于非命令的节标题/透传/元命令）', () => {
    const src = readFileSync(join(repoRoot, 'src/core/command-handler.ts'), 'utf-8');
    const helpStart = src.indexOf("case '/help': {");
    const helpEnd = src.indexOf("\n      case '/", helpStart + 1); // 下一个 case 之前的整个 /help 块
    const helpCase = src.slice(helpStart, helpEnd > 0 ? helpEnd : undefined);
    const used = new Set([...helpCase.matchAll(/t\('(help\.[a-z_]+)'/g)].map(m => m[1]!));
    const owned = new Set(COMMANDS.flatMap(s => s.help));
    // 不属于任何 daemon 命令的 help 键：节标题、透传/元命令说明等，手工登记，新增时补进来。
    const NON_COMMAND_HELP = new Set([
      // pre-routing / dispatcher 层命令（与 test/slash-commands-doc-sync.test.ts 的 PREROUTING_COMMANDS 同源）
      'help.topic', 'help.summary', 'help.reply_mode', 'help.introduce', 'help.invite', 'help.grant', 'help.revoke',
      'help.workflow_run', 'help.workflow_cancel', 'help.tabs',
    ]);
    for (const key of used) {
      if (/^help\.heading_/.test(key)) continue; // 节标题
      expect(owned.has(key) || NON_COMMAND_HELP.has(key), `help 键 ${key} 既不属于任何命令也不在非命令名单里`).toBe(true);
    }
  });
});

describe('command schema ↔ handleCommand switch', () => {
  it('switch 的每个 case 都在 schema 里，schema 的每个命令（除 /vc-auth）都有 case', () => {
    const src = readFileSync(join(repoRoot, 'src/core/command-handler.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export async function handleCommand('));
    const cases = new Set([...body.matchAll(/^\s{6}case '(\/[a-z0-9-]+)':/gm)].map(m => m[1]!));
    for (const c of cases) expect(DAEMON_COMMANDS.has(c), `switch 有 ${c} 但 schema 没有`).toBe(true);
    for (const c of DAEMON_COMMANDS) {
      if (c === '/vc-auth') continue;
      expect(cases.has(c), `schema 有 ${c} 但 switch 没有 case`).toBe(true);
    }
  });
  it('前置特判表：五条命令，处理器名与命令名一致', () => {
    expect(sorted(new Set(ROUTE_SPECIAL_COMMANDS.keys()))).toEqual(['/card', '/cot', '/sessions', '/term', '/vc-auth']);
    for (const [cmd, handler] of ROUTE_SPECIAL_COMMANDS) expect(handler).toBe(cmd.slice(1));
  });
});
