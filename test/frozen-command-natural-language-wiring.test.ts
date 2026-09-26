import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const daemon = readFileSync(new URL('../src/daemon.ts', import.meta.url), 'utf8');
const cli = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
const ipc = readFileSync(new URL('../src/core/dashboard-ipc-server.ts', import.meta.url), 'utf8');
const skill = readFileSync(new URL('../src/skills/definitions.ts', import.meta.url), 'utf8');
const guidance = readFileSync(new URL('../src/core/frozen-command-guidance.ts', import.meta.url), 'utf8');

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

  it('keeps listing model-assisted while installed-command execution stays host-direct', () => {
    expect(skill).toContain('botmux freeze list');
    expect(skill).toContain('运行已安装的固化命令由宿主直达');
    expect(skill).toContain('不要**调用 \\`botmux freeze run\\`');
    expect(cli).toContain('botmux freeze run 已停用');
    expect(guidance).toContain('Never call `botmux freeze run`');
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

  it('prevents a generic ask card from replacing the host lifecycle confirmation', () => {
    expect(cli).toContain('rejectsFrozenCommandLifecycleAsk(prompt, options, knownFrozenCommands)');
    expect(cli).toContain('不要用通用 ask 代替生命周期确认');
    expect(guidance).toContain('Do not use `botmux ask` for this confirmation');
  });
});
