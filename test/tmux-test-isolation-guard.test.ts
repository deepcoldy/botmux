/**
 * 守卫：测试里驱动私有 tmux server 时，绝不能经继承的 TMUX 打到调用者的 server。
 *
 * 套件若在 tmux pane 里启动（TMUX 已设置），只靠 TMUX_TMPDIR 隔离的 tmux 客户端会忽略
 * TMUX_TMPDIR、连到调用者自己的 server——清理用的 `tmux kill-server` 就会杀掉宿主上的
 * 线上会话（2026-10-20 实际发生：默认 server 上全部 bot 会话的 pane 丢失）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { privateTmuxEnv } from './helpers/private-tmux-env.js';

describe('privateTmuxEnv', () => {
  it('strips an inherited TMUX / TMUX_PANE and pins TMUX_TMPDIR', () => {
    const saved = { TMUX: process.env.TMUX, TMUX_PANE: process.env.TMUX_PANE };
    process.env.TMUX = '/tmp/tmux-0/default,1,0';
    process.env.TMUX_PANE = '%1';
    try {
      const env = privateTmuxEnv('/tmp/private-root', { EXTRA: '1', TMUX: '/tmp/tmux-0/default,1,0' });
      expect(env.TMUX).toBeUndefined();
      expect(env.TMUX_PANE).toBeUndefined();
      expect(env.TMUX_TMPDIR).toBe('/tmp/private-root');
      expect(env.EXTRA).toBe('1');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('tmux test isolation guard', () => {
  // 隔离信号只看语法树：注释、字符串、模板文本里的同名字样一律不算数。
  const mentions = (node: ts.Node, text: string): boolean =>
    (ts.isIdentifier(node) && node.text === text)
    || (ts.isPropertyAccessExpression(node) && node.name.text === text);

  const isIsolated = (src: string): boolean => {
    const sf = ts.createSourceFile('tmux-test.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node) && mentions(node.expression, 'privateTmuxEnv')) found = true;
      if (ts.isDeleteExpression(node)) {
        const target = node.expression;
        if (ts.isPropertyAccessExpression(target) && target.name.text === 'TMUX') found = true;
        if (ts.isElementAccessExpression(target)
          && ts.isStringLiteralLike(target.argumentExpression)
          && target.argumentExpression.text === 'TMUX') found = true;
      }
      if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteralLike(node.name) ? node.name.text : undefined;
        const init = node.initializer;
        if (name === 'TMUX'
          && ((ts.isStringLiteralLike(init) && init.text === '')
            || (ts.isIdentifier(init) && init.text === 'undefined'))) found = true;
      }
      if (ts.isStringLiteralLike(node) && (node.text === '-L' || node.text === '-S')) found = true;
      if (!found) ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };

  it('ignores isolation signals that only appear in comments or strings', () => {
    const spoofs = [
      '// privateTmuxEnv(root)\nconst env = {};',
      '// delete env.TMUX\nconst env = {};',
      "// delete env['TMUX']\nconst env = {};",
      "// TMUX: ''\nconst env = {};",
      "// spawnSync('tmux', ['-L', sock, 'kill-server'])\nconst env = {};",
      "// spawnSync('tmux', ['-S', sock, 'kill-server'])\nconst env = {};",
      "/*\n  privateTmuxEnv(root)\n  delete env.TMUX\n  TMUX: ''\n*/\nconst env = {};",
      'const s = "doc \\\n  privateTmuxEnv( nope";\nconst env = {};',
      'const s = `\n  privateTmuxEnv( nope\n`;\nconst env = {};',
    ];
    for (const spoof of spoofs) expect(isIsolated(spoof), spoof).toBe(false);
  });

  it('still recognises real isolation code, including a call split across lines', () => {
    const real = [
      'const env = privateTmuxEnv(root);',
      'const env = helpers.privateTmuxEnv(root);',
      'const env = privateTmuxEnv\n  (root);',
      'delete env.TMUX;',
      "delete env['TMUX'];",
      "const env = { TMUX: '' };",
      'const env = { TMUX: undefined };',
      "spawnSync('tmux', ['-L', sock, 'kill-server']);",
      "spawnSync('tmux', ['-S', sock, 'kill-server']);",
    ];
    for (const code of real) expect(isIsolated(code), code).toBe(true);
  });

  it('every test that kills a TMUX_TMPDIR-isolated tmux server strips the inherited TMUX', () => {
    const dir = join(process.cwd(), 'test');
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name);
        if (ent.isDirectory()) { walk(p); continue; }
        if (!/\.(?:test\.)?[cm]?[jt]s$/.test(ent.name) || p.endsWith('tmux-test-isolation-guard.test.ts')) continue;
        const src = readFileSync(p, 'utf8');
        if (!src.includes('TMUX_TMPDIR') || !/['"]kill-server['"]/.test(src)) continue;
        if (!isIsolated(src)) offenders.push(p.slice(dir.length + 1));
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
