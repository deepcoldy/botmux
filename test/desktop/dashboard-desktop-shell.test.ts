import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('desktop dashboard shell mode', () => {
  // 源码结构护栏(K4)：桌面壳隐藏了内嵌 Dashboard 的顶栏，「添加机器人」「创建会话」只能靠桌面渲染层
  // 往 webview hash 里写 `?open=<命令>`、由 Dashboard 入口读取后打开弹窗。两端都是不可 import 的
  // 入口脚本（renderer/app.ts、dashboard/web/app.tsx），命令名是两边手写的字面量，只能读文本对齐；
  // 一边改名另一边漏改，桌面端按钮会静默失效（eb6d235791 / fb1b8032e3）。
  it('only sends hash open-commands that the embedded dashboard consumes', () => {
    const rendererSource = readFileSync(
      fileURLToPath(new URL('../../src/desktop/renderer/app.ts', import.meta.url)),
      'utf-8',
    );
    const dashboardSource = readFileSync(
      fileURLToPath(new URL('../../src/dashboard/web/app.tsx', import.meta.url)),
      'utf-8',
    );

    const commands = [...rendererSource.matchAll(/'#\/[^'?]*\?open=([a-z-]+)'/g)].map(match => match[1]);
    expect(commands).toEqual(expect.arrayContaining(['bot-onboarding', 'create-session']));
    expect(dashboardSource).toMatch(/\.get\('open'\)/);
    for (const command of commands) expect(dashboardSource, command).toContain(`'${command}'`);
  });
});
