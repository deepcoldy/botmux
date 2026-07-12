/**
 * card-handler open_local_cli action: permission gate, active-session lookup,
 * CLI binding validation, and immediate opener ack.
 * Run: pnpm vitest run test/card-handler-open-local-cli.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { CliId } from '../src/adapters/cli/types.js';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('../src/services/local-cli-opener.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/local-cli-opener.js')>();
  return {
    ...actual,
    isLocalCliOpenConfigured: vi.fn(() => true),
    isLocalCliOpenCapable: vi.fn(() => true),
    localCliOpenMode: vi.fn(() => 'resume'),
    openLocalCliInIterm: vi.fn(),
  };
});

vi.mock('../src/core/local-terminal-opener.js', () => ({
  localTerminalCapable: vi.fn(() => true),
  openLocalTerminalForSession: vi.fn(() => ({ ok: true, launcher: 'iterm', backend: 'pty' })),
}));

const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'mid'), lastRepoScan: new Map() } as any;

function makeDs(cliId: CliId = 'codex'): DaemonSession {
  return {
    larkAppId: 'h1',
    chatId: 'oc_1',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '',
    lastMessageAt: Date.now(),
    hasHistory: true,
    worker: null,
    workerPort: null,
    workerToken: null,
    workingDir: '/repo/real',
    session: {
      sessionId: 'sess1',
      cliId,
      cliSessionId: 'native1',
      chatId: 'oc_1',
      rootMessageId: 'om_root',
      title: 'task',
      status: 'active',
      createdAt: new Date().toISOString(),
      workingDir: '/repo/real',
    },
  } as DaemonSession;
}

function action(
  operator: string,
  cliId?: string,
  extra: Record<string, unknown> = {},
  valueExtra: Record<string, unknown> = {},
): any {
  return {
    operator: { open_id: operator },
    action: {
      value: {
        action: 'open_local_cli',
        root_id: 'om_root',
        session_id: 'sess1',
        ...(cliId ? { cli_id: cliId } : {}),
        cwd: '/tmp/card-value-must-not-be-used',
        command: 'rm -rf /',
        ...valueExtra,
      },
    },
    ...extra,
  };
}

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const types = await import('../src/core/types.js');
  const opener = await import('../src/services/local-cli-opener.js');
  const terminal = await import('../src/core/local-terminal-opener.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  vi.mocked(opener.isLocalCliOpenConfigured).mockReset().mockReturnValue(true);
  vi.mocked(opener.isLocalCliOpenCapable).mockReset().mockReturnValue(true);
  vi.mocked(opener.localCliOpenMode).mockReset().mockReturnValue('resume');
  vi.mocked(opener.openLocalCliInIterm).mockReset().mockResolvedValue({ ok: true, command: 'resume' });
  vi.mocked(terminal.openLocalTerminalForSession).mockClear();
  return { types, opener, terminal, handler };
}

beforeEach(() => {
  deps.activeSessions = new Map();
  deps.sessionReply = vi.fn(async () => 'mid');
  const dir = mkdtempSync(join(tmpdir(), 'botmux-open-local-cli-'));
  const cfg = join(dir, 'bots.json');
  writeFileSync(cfg, JSON.stringify([{ larkAppId: 'h1', larkAppSecret: 's', cliId: 'codex', lang: 'en', allowedUsers: ['ou_owner'] }], null, 2));
  process.env.BOTS_CONFIG = cfg;
});

afterEach(() => {
  delete process.env.BOTS_CONFIG;
  vi.restoreAllMocks();
});

describe('card-handler open_local_cli', () => {
  it('authorized operator opens the active session through the local opener', async () => {
    const { types, opener, handler } = await fresh();
    const ds = makeDs('codex');
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);
    vi.mocked(opener.openLocalCliInIterm).mockReturnValueOnce(new Promise(() => {}) as any);

    const res = await handler.handleCardAction(action('ou_owner', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(res.toast.content).toContain('Opening local Codex');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledTimes(1);
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'codex', mode: 'resume' });
  });

  it('attach mode opens a Herdr-backed CLI outside the direct-resume whitelist when cli_id matches', async () => {
    const { types, opener, terminal, handler } = await fresh();
    vi.mocked(opener.localCliOpenMode).mockReturnValue('attach');
    const ds = makeDs('gemini');
    ds.session.backendType = 'herdr';
    ds.session.cliSessionId = undefined;
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);

    const res = await handler.handleCardAction(action('ou_owner', 'gemini'), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'gemini', mode: 'attach' });
    expect(terminal.openLocalTerminalForSession).not.toHaveBeenCalled();
  });

  it('legacy open_local_terminal also uses attach mode for Herdr instead of generic fallback', async () => {
    const { types, opener, terminal, handler } = await fresh();
    vi.mocked(opener.localCliOpenMode).mockReturnValue('attach');
    const ds = makeDs('gemini');
    ds.session.backendType = 'herdr';
    ds.session.cliSessionId = undefined;
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);

    const res = await handler.handleCardAction(
      action('ou_owner', 'gemini', {}, { action: 'open_local_terminal' }),
      deps,
      'h1',
    );

    expect(res?.toast?.type).toBe('success');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'gemini', mode: 'attach' });
    expect(terminal.openLocalTerminalForSession).not.toHaveBeenCalled();
  });

  it('non-operator is blocked by the sensitive canOperate gate before local command execution', async () => {
    const { types, opener, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));

    const res = await handler.handleCardAction(action('ou_intruder', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('warning');
    expect(res.toast.content).toContain('operate permission');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it('default-off policy rejects an old card before local command execution', async () => {
    const { types, opener, terminal, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));
    vi.mocked(opener.isLocalCliOpenConfigured).mockReturnValue(false);

    const res = await handler.handleCardAction(action('ou_owner', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('warning');
    expect(res.toast.content).toContain('off by default');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
    expect(terminal.openLocalTerminalForSession).not.toHaveBeenCalled();
  });

  it('unsupported daemon hosts are rejected even when the feature is enabled', async () => {
    const { types, opener, terminal, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('traex'));
    vi.mocked(opener.isLocalCliOpenCapable).mockReturnValue(false);

    const res = await handler.handleCardAction(action('ou_owner', 'traex'), deps, 'h1');

    expect(res?.toast?.type).toBe('warning');
    expect(res.toast.content).toContain('cannot be opened locally');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
    expect(terminal.openLocalTerminalForSession).not.toHaveBeenCalled();
  });

  it('legacy open_local_terminal non-operator keeps the old no-permission toast', async () => {
    const { types, opener, terminal, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));

    const res = await handler.handleCardAction(
      action('ou_intruder', 'codex', {}, { action: 'open_local_terminal' }),
      deps,
      'h1',
    );

    expect(res?.toast?.type).toBe('warning');
    expect(res.toast.content).toContain('open the local CLI');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
    expect(terminal.openLocalTerminalForSession).not.toHaveBeenCalled();
  });

  it.each(['traex', 'claude-code'] as const)(
    'legacy open_local_terminal for %s uses the iTerm-first resume opener',
    async (cliId) => {
      const { types, opener, terminal, handler } = await fresh();
      const ds = makeDs(cliId);
      deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);

      const res = await handler.handleCardAction(
        action('ou_owner', cliId, {}, { action: 'open_local_terminal' }),
        deps,
        'h1',
      );

      expect(res?.toast?.type).toBe('success');
      expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId, mode: 'resume' });
      expect(terminal.openLocalTerminalForSession).not.toHaveBeenCalled();
    },
  );

  it('legacy open_local_terminal fails closed for unsupported CLIs in resume mode', async () => {
    const { types, opener, terminal, handler } = await fresh();
    const ds = makeDs('gemini');
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);

    const res = await handler.handleCardAction(
      action('ou_owner', 'gemini', {}, { action: 'open_local_terminal' }),
      deps,
      'h1',
    );

    expect(res?.toast?.type).toBe('warning');
    expect(res.toast.content).toContain('Gemini');
    expect(terminal.openLocalTerminalForSession).not.toHaveBeenCalled();
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it('stale card CLI mismatch is rejected before opener execution', async () => {
    const { types, opener, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));

    const res = await handler.handleCardAction(action('ou_owner', 'traex'), deps, 'h1');

    expect(res?.toast?.type).toBe('error');
    expect(res.toast.content).toContain('CLI');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it('missing cli_id is rejected before opener execution', async () => {
    const { types, opener, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex'));

    const res = await handler.handleCardAction(action('ou_owner'), deps, 'h1');

    expect(res?.toast?.type).toBe('error');
    expect(res.toast.content).toContain('CLI');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it('active sessions without a precise local resume command are rejected before optimistic success', async () => {
    const { types, opener, handler } = await fresh();
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), makeDs('codex-app'));

    const res = await handler.handleCardAction(action('ou_owner', 'codex-app'), deps, 'h1');

    expect(res?.toast?.type).toBe('warning');
    expect(res.toast.content).toContain('cannot be opened locally');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });

  it.each(['open_local_cli', 'open_local_terminal'] as const)(
    '%s returns a not-ready toast before a fresh TRAE session has a native id',
    async (actionType) => {
      const { types, opener, handler } = await fresh();
      const ds = makeDs('traex');
      ds.session.cliSessionId = undefined;
      deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);

      const res = await handler.handleCardAction(
        action('ou_owner', 'traex', {}, { action: actionType }),
        deps,
        'h1',
      );

      expect(res?.toast?.type).toBe('warning');
      expect(res?.toast?.content).toContain('not ready yet');
      expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
      expect(deps.sessionReply).not.toHaveBeenCalled();
    },
  );

  it('opener failure is handled asynchronously after an immediate ack', async () => {
    const { types, opener, handler } = await fresh();
    const ds = makeDs('traex');
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);
    vi.mocked(opener.openLocalCliInIterm).mockResolvedValueOnce({
      ok: false,
      error: 'terminal_unavailable',
      message: 'Terminal is not available',
    });

    const res = await handler.handleCardAction(action('ou_owner', 'traex'), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(res.toast.content).toContain('Opening local TRAE');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'traex', mode: 'resume' });
    await Promise.resolve();
    expect(deps.sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('Terminal is not available'),
      undefined,
      'h1',
    );
  });

  it('unexpected opener rejection is reported asynchronously after an immediate ack', async () => {
    const { types, opener, handler } = await fresh();
    const ds = makeDs('codex');
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);
    vi.mocked(opener.openLocalCliInIterm).mockRejectedValueOnce(new Error('osascript crashed'));

    const res = await handler.handleCardAction(action('ou_owner', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'codex', mode: 'resume' });
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.sessionReply).toHaveBeenCalledWith(
      'om_root',
      expect.stringContaining('osascript crashed'),
      undefined,
      'h1',
    );
  });

  it("private open_local_cli async failure doesn't send a public fallback reply", async () => {
    const { types, opener, handler } = await fresh();
    const ds = makeDs('codex');
    deps.activeSessions.set(types.sessionKey('om_root', 'h1'), ds);
    vi.mocked(opener.openLocalCliInIterm).mockResolvedValueOnce({
      ok: false,
      error: 'terminal_unavailable',
      message: 'automation denied',
    });

    const res = await handler.handleCardAction(action('ou_owner', 'codex', {}, { visibility: 'private' }), deps, 'h1');

    expect(res?.toast?.type).toBe('success');
    expect(opener.openLocalCliInIterm).toHaveBeenCalledWith(ds, { cliId: 'codex', mode: 'resume' });
    await Promise.resolve();
    expect(deps.sessionReply).not.toHaveBeenCalled();
  });

  it('missing active session returns session_gone and does not trust card cwd/command', async () => {
    const { opener, handler } = await fresh();

    const res = await handler.handleCardAction(action('ou_owner', 'codex'), deps, 'h1');

    expect(res?.toast?.type).toBe('warning');
    expect(opener.openLocalCliInIterm).not.toHaveBeenCalled();
  });
});
