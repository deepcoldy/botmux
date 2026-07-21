import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether OrcaBotmux-managed agent status hooks are enabled',
    usage: 'orca_botmux agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca_botmux agent hooks status', 'orca_botmux agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable OrcaBotmux-managed agent status hooks and remove local hook entries',
    usage: 'orca_botmux agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca_botmux agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable OrcaBotmux-managed agent status hooks',
    usage: 'orca_botmux agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['orca_botmux agent hooks on']
  }
]
