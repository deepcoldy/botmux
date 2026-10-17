import { describe, expect, it } from 'vitest';
import {
  AGENT_BACKEND_TYPES,
  agentBotDrift,
  agentHasSections,
  agentLinkedBots,
  agentPushRequests,
  botSectionValues,
  diffAgentSections,
  normalizeAgentInput,
  normalizeAgentProfilesDoc,
  parseStartupCommands,
  type AgentBotSnapshot,
  type AgentSectionsConfig,
} from '../src/dashboard/agent-profiles-model.js';
import { EDITABLE_BACKEND_TYPES } from '../src/services/backend-type-store.js';

function bot(over: Partial<AgentBotSnapshot> = {}): AgentBotSnapshot {
  return {
    larkAppId: 'cli_a',
    online: true,
    cliId: 'claude-code',
    agentSelectionKey: 'claude-code',
    defaultOncall: { enabled: false, workingDir: '' },
    defaultWorkingDir: '/repo',
    sandboxMode: 'off',
    backendType: null,
    startupCommands: '',
    ...over,
  };
}

const fullAgent: AgentSectionsConfig = {
  exec: { cliId: 'claude-code', model: '', reasoningEffort: '', configDir: '' },
  workspace: { mode: 'default', workingDir: '/repo', autoWorktree: false },
  sandbox: { mode: 'off' },
  backend: { backendType: '' },
  startup: { commands: [] },
};

describe('agent profile normalization', () => {
  it('keeps backend choices aligned with the daemon editable backend list', () => {
    expect([...AGENT_BACKEND_TYPES]).toEqual([...EDITABLE_BACKEND_TYPES]);
  });

  it('treats null / missing sections as "not managed" and trims text', () => {
    const result = normalizeAgentInput({ name: '  主仓库  ', description: ' d ', exec: { cliId: ' codex ', model: ' gpt ' }, sandbox: null });
    expect(result).toEqual({
      ok: true,
      value: { name: '主仓库', description: 'd', exec: { cliId: 'codex', model: 'gpt', reasoningEffort: '', configDir: '' } },
    });
  });

  it('rejects a section it cannot honour instead of silently dropping it', () => {
    expect(normalizeAgentInput({ name: 'x', workspace: { mode: 'default', workingDir: '' } }))
      .toEqual({ ok: false, error: 'workspace:working_dir_required' });
    expect(normalizeAgentInput({ name: 'x', backend: { backendType: 'screen' } }))
      .toEqual({ ok: false, error: 'backend:invalid_backend_type' });
    expect(normalizeAgentInput({ name: 'x', sandbox: { mode: 'on' } }))
      .toEqual({ ok: false, error: 'sandbox:invalid_sandbox_mode' });
    expect(normalizeAgentInput({ name: '' })).toEqual({ ok: false, error: 'name_required' });
    expect(normalizeAgentInput({ name: 'x', exec: { cliId: 'claude-code', configDir: 'relative' } }))
      .toEqual({ ok: false, error: 'exec:invalid_config_dir' });
  });

  it('drops workspace dir and auto-worktree where the mode makes them meaningless', () => {
    expect(normalizeAgentInput({ name: 'x', workspace: { mode: 'off', workingDir: '/a', autoWorktree: true } }))
      .toMatchObject({ ok: true, value: { workspace: { mode: 'off', workingDir: '', autoWorktree: false } } });
    expect(normalizeAgentInput({ name: 'x', workspace: { mode: 'oncall', workingDir: '/a', autoWorktree: true } }))
      .toMatchObject({ ok: true, value: { workspace: { mode: 'oncall', workingDir: '/a', autoWorktree: false } } });
  });

  it('normalizes startup commands exactly like the daemon writes them to bots.json', () => {
    expect(parseStartupCommands('/effort high, /model x\n\n /foo ')).toEqual(['/effort high', '/model x', '/foo']);
    // stored array form: each entry normalized, not re-split
    expect(parseStartupCommands(['/a', '/c'])).toEqual(['/a', '/c']);
  });

  it('adds the leading slash, dedupes, and drops over-long entries like the daemon', () => {
    expect(parseStartupCommands('effort high, /effort high')).toEqual(['/effort high']);
    expect(parseStartupCommands(['model x', '/model x'])).toEqual(['/model x']);
    expect(parseStartupCommands(`/ok, /${'x'.repeat(250)}`)).toEqual(['/ok']);
    // so a bot synced from this Agent compares equal afterwards (no permanent drift)
    expect(diffAgentSections({ startup: { commands: parseStartupCommands('effort high') } }, bot({ startupCommands: '/effort high' })))
      .toEqual([]);
  });

  it('drops invalid agents and dangling links when reading the file, keeping the rest', () => {
    const { doc, dropped } = normalizeAgentProfilesDoc({
      version: 1,
      agents: [
        { id: 'ag_good1', name: 'ok', exec: { cliId: 'codex' }, createdAt: 5 },
        { id: 'bad id', name: 'nope' },
        { id: 'ag_good1', name: 'duplicate' },
        { id: 'ag_badsec', name: 'x', sandbox: { mode: 'weird' } },
      ],
      links: { cli_a: 'ag_good1', cli_b: 'ag_missing', cli_c: 'ag_badsec' },
    });
    expect(doc.agents.map(agent => agent.id)).toEqual(['ag_good1']);
    expect(doc.agents[0]).toMatchObject({ createdAt: 5, updatedAt: 5 });
    expect(doc.links).toEqual({ cli_a: 'ag_good1' });
    expect(dropped).toEqual(['bad id', 'ag_good1', 'ag_badsec']);
    expect(agentLinkedBots(doc, 'ag_good1')).toEqual(['cli_a']);
  });
});

describe('bot projection and drift', () => {
  it('projects the three working-dir shapes the bot config page uses', () => {
    expect(botSectionValues(bot()).workspace).toEqual({ mode: 'default', workingDir: '/repo', autoWorktree: false });
    expect(botSectionValues(bot({ defaultOncall: { enabled: true, workingDir: '/oncall' }, defaultWorkingDir: null })).workspace)
      .toEqual({ mode: 'oncall', workingDir: '/oncall', autoWorktree: false });
    expect(botSectionValues(bot({ defaultWorkingDir: null, defaultOncall: { enabled: false, workingDir: '/kept-for-roundtrip' } })).workspace)
      .toEqual({ mode: 'off', workingDir: '', autoWorktree: false });
  });

  it('prefers the wrapper-aware selection key over the bare cliId', () => {
    expect(botSectionValues(bot({ cliId: 'claude-code', agentSelectionKey: 'aiden-claude' })).exec.cliId).toBe('aiden-claude');
  });

  it('falls back to the legacy boolean sandbox flag', () => {
    expect(botSectionValues(bot({ sandboxMode: null, sandbox: true })).sandbox.mode).toBe('oncall');
  });

  it('is in sync when every managed section matches', () => {
    expect(agentBotDrift(fullAgent, bot())).toEqual({ state: 'synced', diffs: [], sections: [] });
  });

  it('reports field-level diffs grouped by section', () => {
    const status = agentBotDrift(
      { ...fullAgent, exec: { cliId: 'codex', model: 'gpt-5.5', reasoningEffort: 'high', configDir: '' } },
      bot({ startupCommands: '/a' }),
    );
    expect(status.state).toBe('drift');
    expect(status.sections).toEqual(['exec', 'startup']);
    expect(status.diffs.map(diff => [diff.field, diff.bot, diff.agent])).toEqual([
      ['cliId', 'claude-code', 'codex'],
      ['model', '', 'gpt-5.5'],
      ['reasoningEffort', '', 'high'],
      ['startupCommands', '/a', ''],
    ]);
  });

  it('compares the Claude config profile as part of the run section', () => {
    const agent = { exec: { cliId: 'claude-code', model: '', reasoningEffort: '', configDir: '~/.claude-api' } };
    expect(diffAgentSections(agent, bot()).map(diff => [diff.field, diff.bot, diff.agent]))
      .toEqual([['configDir', '', '~/.claude-api']]);
    expect(diffAgentSections(agent, bot({ cliConfigDir: '~/.claude-api/' }))).toEqual([]);
  });

  it('does not compare (or push) sandbox / backend for a remote CLI bot', () => {
    const agent = { sandbox: { mode: 'oncall' as const }, backend: { backendType: 'tmux' as const } };
    expect(diffAgentSections(agent, bot({ cliId: 'riff', agentSelectionKey: 'riff', backendType: 'riff' }))).toEqual([]);
    // an Agent that switches a local bot to a remote CLI also stops managing them
    expect(diffAgentSections({ ...agent, exec: { cliId: 'mojo', model: '', reasoningEffort: '', configDir: '' } }, bot())
      .map(diff => diff.section)).toEqual(['exec']);
    expect(diffAgentSections(agent, bot()).map(diff => diff.field)).toEqual(['sandboxMode', 'backendType']);
  });

  it('ignores sections the agent does not manage', () => {
    expect(diffAgentSections({ exec: fullAgent.exec }, bot({ sandboxMode: 'scratch', defaultWorkingDir: '/elsewhere' }))).toEqual([]);
  });

  it('treats a trailing slash on the directory as the same directory', () => {
    expect(diffAgentSections({ workspace: { mode: 'default', workingDir: '/repo/', autoWorktree: false } }, bot())).toEqual([]);
  });

  it('never compares against an offline / errored bot row', () => {
    expect(agentBotDrift(fullAgent, bot({ online: false, cliId: 'codex' })).state).toBe('offline');
    expect(agentBotDrift(fullAgent, bot({ error: 'timeout' })).state).toBe('offline');
  });
});

describe('agentPushRequests', () => {
  it('maps each managed section to the existing per-bot write route', () => {
    const requests = agentPushRequests({
      exec: { cliId: 'codex', model: 'gpt', reasoningEffort: '', configDir: '' },
      workspace: { mode: 'default', workingDir: '~/repo', autoWorktree: true },
      sandbox: { mode: 'scratch' },
      backend: { backendType: '' },
      startup: { commands: ['/a', '/b'] },
    }, 'cli/a b');
    expect(requests.map(request => [request.section, request.url, request.body])).toEqual([
      ['exec', '/api/bots/cli%2Fa%20b/agent', { cliId: 'codex', model: 'gpt', reasoningEffort: '', cliConfigDir: null }],
      ['workspace', '/api/bots/cli%2Fa%20b/working-dir-mode', { mode: 'default', workingDir: '~/repo', autoWorktree: true }],
      ['sandbox', '/api/bots/cli%2Fa%20b/sandbox', { mode: 'scratch' }],
      ['backend', '/api/bots/cli%2Fa%20b/backend-type', { backendType: '' }],
      ['startup', '/api/bots/cli%2Fa%20b/startup-commands', { startupCommands: '/a\n/b' }],
    ]);
    expect(requests.every(request => request.method === 'PUT')).toBe(true);
  });

  it('sends the profile dir (or an explicit clear) with the run section', () => {
    const withProfile = agentPushRequests({ exec: { cliId: 'claude-code', model: '', reasoningEffort: '', configDir: '~/.claude-api' } }, 'cli_a');
    expect(withProfile[0]!.body.cliConfigDir).toBe('~/.claude-api');
  });

  it('can be limited to the drifted sections only', () => {
    expect(agentPushRequests(fullAgent, 'cli_a', ['sandbox']).map(request => request.section)).toEqual(['sandbox']);
    expect(agentPushRequests({}, 'cli_a')).toEqual([]);
    expect(agentHasSections({})).toBe(false);
    expect(agentHasSections({ sandbox: { mode: 'off' } })).toBe(true);
  });
});
