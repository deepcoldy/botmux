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
const INTENTIONAL_NEW_COMMANDS = new Set(['/context-sharing', '/queue', '/dash']);
const withoutIntentional = (s: ReadonlySet<string>) => new Set([...s].filter(c => !INTENTIONAL_NEW_COMMANDS.has(c)));

describe('command schema ↔ 冻结的 legacy 集合', () => {
  it('DAEMON_COMMANDS 逐字相等', () => {
    expect(sorted(withoutIntentional(DAEMON_COMMANDS))).toEqual(sorted(ORACLE_DAEMON_COMMANDS));
    expect(sorted(INTENTIONAL_NEW_COMMANDS)).toEqual(['/context-sharing', '/dash', '/queue']);
    expect(commandSpec('/context-sharing')).toMatchObject({ sessionPolicy: 'sessionless' });
    expect(commandSpec('/queue')).toMatchObject({ sessionPolicy: 'existingOnly', multiline: true });
    expect(commandSpec('/dash')).toMatchObject({ sessionPolicy: 'sessionless', mentionless: true });
  });
  it('SESSIONLESS / EXISTING_SESSION_ONLY / MULTILINE 逐字相等', () => {
    expect(sorted(withoutIntentional(SESSIONLESS_DAEMON_COMMANDS))).toEqual(sorted(ORACLE_SESSIONLESS_DAEMON_COMMANDS));
    expect(sorted(withoutIntentional(EXISTING_SESSION_ONLY_DAEMON_COMMANDS))).toEqual(sorted(ORACLE_EXISTING_SESSION_ONLY_DAEMON_COMMANDS));
    expect(sorted(withoutIntentional(MULTILINE_COMMANDS))).toEqual(sorted(ORACLE_MULTILINE_COMMANDS));
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
  it('/effort 为 Codex CLI 与 App 注册，不遮蔽其它 CLI 的透传', () => {
    expect(commandSpec('/effort')).toMatchObject({ cliId: ['codex-app', 'codex'], sessionPolicy: 'existingOnly' });
    expect(DAEMON_COMMANDS.has('/effort')).toBe(false);
    expect(EXISTING_SESSION_ONLY_DAEMON_COMMANDS.has('/effort')).toBe(false);
    expect(PASSTHROUGH_COMMANDS.has('/effort')).toBe(true);
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
  it('/adopt 帮助同时覆盖通用目标与实验性 Orca 直连', () => {
    expect(commandSpec('/adopt')?.help).toEqual(['help.adopt', 'help.adopt_pane', 'help.adopt_orca']);
    expect(zh['help.adopt_orca']).toContain('实验性');
    expect(en['help.adopt_orca']).toContain('experimental');
  });
  // 源码结构护栏(K4)：/help 的键是在 handleCommand 的 `case '/help'` 块里内联拼的，没有可 import 的键表；只能读源码确认
  // 每个用到的 help.* 键都归属 schema 里的某个命令或登记过的非命令键，防止 schema（唯一事实源，#1434）与 /help 漂移。
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
  // 源码结构护栏(K4)：handleCommand 的 switch case 集合无法 import，只能读源码与 COMMANDS 双向比对；
  // CLAUDE.md「命令路由」约定「加命令 = 加一行 + 加 case」，由这条红到两边对齐（#1434）。
  it('switch 的每个 case 都在 schema 里，schema 的每个命令（除 /vc-auth）都有 case', () => {
    const src = readFileSync(join(repoRoot, 'src/core/command-handler.ts'), 'utf-8');
    const body = src.slice(src.indexOf('export async function handleCommand('));
    const cases = new Set([...body.matchAll(/^\s{6}case '(\/[a-z0-9-]+)':/gm)].map(m => m[1]!));
    for (const c of cases) expect(commandSpec(c), `switch 有 ${c} 但 schema 没有`).toBeDefined();
    for (const c of COMMANDS.flatMap(spec => [spec.name, ...(spec.aliases ?? [])])) {
      if (c === '/vc-auth') continue;
      expect(cases.has(c), `schema 有 ${c} 但 switch 没有 case`).toBe(true);
    }
  });
  it('前置特判表：五条命令，处理器名与命令名一致', () => {
    expect(sorted(new Set(ROUTE_SPECIAL_COMMANDS.keys()))).toEqual(['/card', '/cot', '/sessions', '/term', '/vc-auth']);
    for (const [cmd, handler] of ROUTE_SPECIAL_COMMANDS) expect(handler).toBe(cmd.slice(1));
  });
});
