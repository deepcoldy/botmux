/**
 * Guard: 命令集合(代码真源) ↔ slash-commands.md(用户文档) ↔ i18n 对齐。
 *
 * 命令是散在多处手工维护的:DAEMON_COMMANDS / PASSTHROUGH_COMMANDS 在代码里,
 * 面向用户的说明在 docs-site 的 slash-commands.md,en/zh 两份还得对称。历史上
 * 这三者反复漂移(命令加了没进文档、/land 删了 help 还留着、zh 有 /reply-mode 节
 * 而 en 没有)。这个测试把「漂移」从人眼审查变成红灯。
 *
 * Run: pnpm vitest run test/slash-commands-doc-sync.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DAEMON_COMMANDS, PASSTHROUGH_COMMANDS } from '../src/core/passthrough-commands.js';
import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import type { CliId } from '../src/adapters/cli/types.js';
import { messages as en } from '../src/i18n/en.js';
import { messages as zh } from '../src/i18n/zh.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const docPath = (loc: 'en' | 'zh') => join(repoRoot, 'docs-site', 'docs', loc, 'slash-commands.md');
const readDoc = (loc: 'en' | 'zh') => readFileSync(docPath(loc), 'utf8');

/**
 * 别名:由主名覆盖,文档只需记主名。豁免这些不算漏。每一项都必须是真别名
 * (∈ DAEMON_COMMANDS,由下面的断言强制),防止有人往这里塞命令来掩盖真缺失。
 */
const ALIAS_EXEMPT = new Set(['/g', '/slash', '/disconnect']);

/**
 * adapter 默认透传命令的真源:遍历所有 CLI adapter 的 defaultPassthroughCommands。
 * 传 mock 路径避免 eager probe(见 cli-adapters.test.ts 同款用法)。这样新 adapter
 * 加默认命令、或改了 /goal,guard 自动跟着变红,不靠手抄。
 */
const ALL_CLI_IDS: CliId[] = ['claude-code', 'seed', 'relay', 'aiden', 'coco', 'codex', 'codex-app', 'cursor', 'gemini', 'genius', 'opencode', 'antigravity', 'mtr', 'hermes', 'mira', 'mir', 'traex', 'pi', 'copilot', 'oh-my-pi', 'kimi', 'grok', 'kiro-cli', 'riff'];
function adapterDefaultPassthrough(): Set<string> {
  const out = new Set<string>();
  for (const id of ALL_CLI_IDS) {
    for (const c of createCliAdapterSync(id, `/mock/bin/${id}`).defaultPassthroughCommands ?? []) {
      out.add(c.toLowerCase());
    }
  }
  return out;
}

/**
 * A 类 pre-routing / daemon-拦截 自有命令:不进 DAEMON_COMMANDS switch、也不透传,而是
 * 在会话分配前(event-dispatcher 的 tryHandle*、路由改写)或 daemon 路由入口
 * (isLegacyTemplateCommand 等)被拦截。代码里没有统一集合,故手工登记已知这批,
 * 让 guard 也守住它们的文档。新增此类命令时要补进来。
 * /template 是退役 tombstone——两条 daemon 路由都会拦截并回退役提示,故仍是用户可见命令。
 */
const PREROUTING_COMMANDS = new Set([
  '/reply-mode', '/substitute', '/grant', '/revoke', '/introduce',
  '/summary', '/t', '/topic', '/workflow', '/template',
]);

/** 命令在 markdown 里是否作为一个 token 出现(命令语法允许尾随 : _ - ,须全部排除以免 /mcp 误配 /mcp:server)。 */
function docMentions(doc: string, cmd: string): boolean {
  const escaped = cmd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}(?![a-z0-9:_-])`).test(doc);
}

describe('slash-commands doc ↔ code 对齐', () => {
  it('豁免集里的每一项都是真别名(∈ DAEMON_COMMANDS)', () => {
    for (const alias of ALIAS_EXEMPT) {
      expect(DAEMON_COMMANDS.has(alias), `${alias} 在豁免集里却不是 daemon 命令`).toBe(true);
    }
  });

  const required = [
    ...[...DAEMON_COMMANDS].filter(c => !ALIAS_EXEMPT.has(c)),
    ...PASSTHROUGH_COMMANDS,
    ...adapterDefaultPassthrough(),
    ...PREROUTING_COMMANDS,
  ];

  for (const loc of ['en', 'zh'] as const) {
    it(`${loc}/slash-commands.md 覆盖所有代码里的命令`, () => {
      const doc = readDoc(loc);
      const missing = required.filter(cmd => !docMentions(doc, cmd));
      expect(missing, `${loc} 文档缺这些命令`).toEqual([]);
    });
  }
});

describe('i18n help.* 对称', () => {
  it('en/zh 的 help.* 键集合完全相等', () => {
    const keys = (m: Record<string, string>) => new Set(Object.keys(m).filter(k => k.startsWith('help.')));
    const enKeys = keys(en);
    const zhKeys = keys(zh);
    const enOnly = [...enKeys].filter(k => !zhKeys.has(k));
    const zhOnly = [...zhKeys].filter(k => !enKeys.has(k));
    expect({ enOnly, zhOnly }).toEqual({ enOnly: [], zhOnly: [] });
  });
});
