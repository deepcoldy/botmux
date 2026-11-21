/**
 * `/botconfig set|unset` and the config card write bots.json directly, past the
 * Dashboard's Agent lock. The reply must say when an Agent manages the field
 * (its next save / sync on the Agent page will overwrite the change).
 */
import { describe, expect, it } from 'vitest';
import { agentManagingConfigField } from '../src/services/agent-managed-config-note.js';
import type { AgentProfilesDoc } from '../src/dashboard/agent-profiles-model.js';

const doc: AgentProfilesDoc = {
  version: 1,
  agents: [
    { id: 'ag_example0001', name: '示例 Agent', startup: { commands: ['/effort xhigh'] }, exec: { cliId: 'claude-code', model: '', reasoningEffort: '', configDir: '' }, createdAt: 1, updatedAt: 1 },
    { id: 'ag_plain00001', name: '只管目录', workspace: { mode: 'off', workingDir: '', autoWorktree: false }, backend: { backendType: 'tmux' }, createdAt: 1, updatedAt: 1 },
  ],
  links: { cli_paid: 'ag_example0001', cli_plain: 'ag_plain00001', cli_dangling: 'ag_missing0001' },
} as AgentProfilesDoc;
const read = async () => doc;

describe('agentManagingConfigField', () => {
  it('names the Agent when it manages the section the field belongs to', async () => {
    expect(await agentManagingConfigField('cli_paid', 'startupCommands', read)).toBe('示例 Agent');
    expect(await agentManagingConfigField('cli_paid', 'model', read)).toBe('示例 Agent');
    expect(await agentManagingConfigField('cli_paid', 'reasoningEffort', read)).toBe('示例 Agent');
    expect(await agentManagingConfigField('cli_plain', 'backendType', read)).toBe('只管目录');
  });

  it('null when the linked Agent leaves that section unset, the field is not Agent-managed, or the bot is unlinked', async () => {
    expect(await agentManagingConfigField('cli_plain', 'startupCommands', read)).toBeNull();
    expect(await agentManagingConfigField('cli_paid', 'launchShell', read)).toBeNull();
    expect(await agentManagingConfigField('cli_other', 'startupCommands', read)).toBeNull();
    expect(await agentManagingConfigField('cli_dangling', 'startupCommands', read)).toBeNull();
  });

  it('an unreadable agents.json never fails the write: no note', async () => {
    expect(await agentManagingConfigField('cli_paid', 'startupCommands', async () => { throw new Error('bad json'); })).toBeNull();
  });
});
