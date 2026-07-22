import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const AGENT_HOOK_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['agent', 'hooks', 'status'],
    summary: 'Show whether Botmux-managed agent status hooks are enabled',
    usage: 'botmux agent hooks status [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['botmux agent hooks status', 'botmux agent hooks status --json']
  },
  {
    path: ['agent', 'hooks', 'off'],
    summary: 'Disable Botmux-managed agent status hooks and remove local hook entries',
    usage: 'botmux agent hooks off [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['botmux agent hooks off']
  },
  {
    path: ['agent', 'hooks', 'on'],
    summary: 'Enable Botmux-managed agent status hooks',
    usage: 'botmux agent hooks on [--json]',
    allowedFlags: [...GLOBAL_FLAGS],
    examples: ['botmux agent hooks on']
  }
]
