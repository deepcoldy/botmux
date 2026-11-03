/**
 * /resume 只在无会话时由 botmux 认领；有会话时与改造前一样交给 CLI 自带的 /resume。
 *
 * Run: bun run vitest run test/resume-command-route.test.ts
 */
import { describe, it, expect } from 'vitest';
import { classifySlash, type SlashRouteInput } from '../src/core/command-router.js';
import { DAEMON_COMMANDS, commandSpec } from '../src/core/command-schema.js';

const base = (overrides: Partial<SlashRouteInput>): SlashRouteInput => ({
  text: '/resume',
  context: 'thread',
  phase: 'none',
  passthrough: new Set(['/compact']),
  coldStartPassthrough: new Set(),
  senderIsBot: false,
  acceptSlashFromBots: true,
  ...overrides,
});

describe('/resume 路由', () => {
  it('无会话时认领为 sessionless daemon 命令（两条入口、带不带 id）', () => {
    for (const context of ['new-topic', 'thread'] as const) {
      for (const text of ['/resume', '/resume 3f2a', ' /RESUME abc ']) {
        expect(classifySlash(base({ context, text }))).toMatchObject({ kind: 'daemon', cmd: '/resume', sessionPolicy: 'sessionless' });
      }
    }
  });

  it('有会话时按未知命令转发给 CLI；自定义透传了 /resume 则照常透传', () => {
    for (const phase of ['dormant', 'spawning', 'ready', 'running', 'queued', 'pendingRepo'] as const) {
      expect(classifySlash(base({ phase }))).toEqual({ kind: 'forward', reason: 'unknown_slash', cmd: '/resume' });
      expect(classifySlash(base({ phase, passthrough: new Set(['/resume']) })))
        .toMatchObject({ kind: 'passthrough', cmd: '/resume', delivery: 'to_session' });
    }
  });

  it('现有会话只是命令空壳（如关闭后发过 /help）时照样认领；真 dormant 会话仍转发', () => {
    expect(classifySlash(base({ phase: 'dormant', sessionIsCommandScratch: true })))
      .toMatchObject({ kind: 'daemon', cmd: '/resume', sessionPolicy: 'sessionless' });
    expect(classifySlash(base({ phase: 'dormant', sessionIsCommandScratch: false })))
      .toEqual({ kind: 'forward', reason: 'unknown_slash', cmd: '/resume' });
    // 空壳旗标只影响 /resume，其它命令的判定不变。
    expect(classifySlash(base({ phase: 'dormant', sessionIsCommandScratch: true, text: '/foo' })))
      .toEqual({ kind: 'forward', reason: 'unknown_slash', cmd: '/foo' });
  });

  it('不进全局 daemon 集合（不遮蔽自定义透传，也进不了 canTalk 名单）', () => {
    expect(DAEMON_COMMANDS.has('/resume')).toBe(false);
    expect(commandSpec('/resume')).toMatchObject({ claimWithoutSessionOnly: true, sessionPolicy: 'sessionless' });
  });

  it('bot 发送方被门掉时不认领', () => {
    expect(classifySlash(base({ senderIsBot: true, acceptSlashFromBots: false }))).toEqual({ kind: 'forward', reason: 'bot_gated' });
  });
});
