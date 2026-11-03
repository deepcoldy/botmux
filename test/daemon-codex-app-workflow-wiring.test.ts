import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve('src/daemon.ts'), 'utf8');

describe('daemon Codex notifier card authorization', () => {
  // 源码结构护栏(K2)：Codex 完成通知卡的按钮回调只能用 daemon 解析出的运行时 owner（getOwnerOpenId）鉴权；
  // resolvePrimaryOwnerOpenId 会回退到 bots.json 里原样的 allowedUsers ou_，而 ou_ 是 app-scoped，不能当跨应用
  // 的身份事实（见 CLAUDE.md「飞书 owner 身份边界」）。handler 由 createCodexNotifierCardActionHandler 注入依赖，
  // 但选哪个 owner 解析器是在 daemon.ts 入口模块里接的线，没有行为 seam。
  it('authorizes notifier card actions with the resolved runtime owner, not the raw DM fallback', () => {
    const start = source.indexOf('createCodexNotifierCardActionHandler({');
    expect(start).toBeGreaterThan(-1);
    const deps = source.slice(start, source.indexOf('\n});', start));
    expect(deps).toMatch(/getExpectedOwnerOpenId:\s*getOwnerOpenId\b/);
    expect(deps).not.toContain('resolvePrimaryOwnerOpenId');
  });
});
