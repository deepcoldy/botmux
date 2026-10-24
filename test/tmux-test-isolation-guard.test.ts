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
  // 其它隔离形态沿用文件级信号；privateTmuxEnv 必须是语法上的真实调用。
  const ISOLATED = [
    /delete\s+[\w.]+\.TMUX\b/,
    /delete\s+[\w.]+\[['"]TMUX['"]\]/,
    /\bTMUX:\s*(?:''|""|undefined)/,
    /['"]-L['"]\s*,/,
    /['"]-S['"]\s*,/,
  ];
  const callsPrivateTmuxEnv = (src: string): boolean => {
    // Preserve comment/template boundaries but avoid parsing thousands of unrelated lines.
    const relevant = src.split('\n').filter(line => /privateTmuxEnv|\/\*|\*\/|`/.test(line)).join('\n');
    const sf = ts.createSourceFile('tmux-test.ts', relevant, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let found = false;
    const visit = (node: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        found = ts.isIdentifier(callee) && callee.text === 'privateTmuxEnv'
          || ts.isPropertyAccessExpression(callee) && callee.name.text === 'privateTmuxEnv';
      }
      if (!found) ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
  };
  const isIsolated = (src: string): boolean => ISOLATED.some(re => re.test(src)) || callsPrivateTmuxEnv(src);

  it('does not accept privateTmuxEnv mentioned only in a comment', () => {
    const unsafe = `
      // privateTmuxEnv() keeps tests away from the host server (but is not actually called).
      const env = { ...process.env, TMUX_TMPDIR: root };
      spawnSync('tmux', ['kill-server'], { env });
    `;
    expect(isIsolated(unsafe)).toBe(false);
    expect(callsPrivateTmuxEnv('const env = privateTmuxEnv(root);')).toBe(true);
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
