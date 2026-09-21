import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const ipc = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../src/skills/definitions.ts', import.meta.url), 'utf8');

describe('Frozen Command natural-language P0a wiring', () => {
  it('requires capability or host HMAC plus an exact daemon-owned human turn snapshot', () => {
    const route = daemon.slice(
      daemon.indexOf("ipcRoute('POST', '/api/frozen-command-actions'"),
      daemon.indexOf('// ─── botmux ask v0.1.7 IPC route'),
    );
    expect(route).toContain('const trustedHost = isTrustedHostIpcRequest(req)');
    expect(route).toContain('trustedHost,');
    expect(route).toContain('liveOrigin.turnId !== body.originTurnId');
    expect(route).toContain("actor?.senderType !== 'user'");
    expect(route).toContain('origin.sourceContentHash');
    expect(route).toContain('liveOrigin.callerOpenId');
    expect(route).not.toContain('lastCallerOpenId');
    expect(route).toContain("status: 'awaiting_input'");
  });

  it('exposes one session-scoped CLI transport for every PTY/Tmux-backed CLI', () => {
    expect(cli).toContain("case 'freeze'");
    expect(cli).toContain("postFrozenCommandIntent");
    expect(cli).toContain("'/api/frozen-command-actions'");
    expect(cli).toContain('origin?.turnId ?? process.env.BOTMUX_TURN_ID');
    expect(ipc).toContain("pathname === '/api/frozen-command-actions'");
  });

  it('teaches the model to submit candidates and never claim execution before click', () => {
    expect(skill).toContain('botmux freeze list');
    expect(skill).toContain('botmux freeze run');
    expect(skill).toContain('只向宿主提交候选意图');
    expect(skill).toContain('绝不表示查询已执行或成功');
  });

  it('routes lifecycle candidates through the same exact-turn host boundary and one-click card', () => {
    const command = cli.slice(cli.indexOf('async function cmdFreeze'), cli.indexOf('async function cmdAsk'));
    expect(command).toContain("sub === 'apply'");
    expect(command).toContain("? 'approve'");
    expect(command).toContain("? 'retire'");
    expect(command).toContain("? 'restore'");
    expect(command).toContain("? 'revoke'");
    expect(command).toContain('definitionYaml');
    expect(skill).toContain('不要再让用户手工发送');
    expect(skill).toContain('botmux freeze apply');
    expect(skill).toContain('botmux freeze rm');
    expect(skill).toContain('点击取消或超时则不改动当前生效版本');
  });
});
