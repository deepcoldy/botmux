import type { CommandSpec } from '../args'
import { GLOBAL_FLAGS } from '../args'

export const ENVIRONMENT_COMMAND_SPECS: CommandSpec[] = [
  {
    path: ['environment', 'add'],
    summary: 'Save a remote OrcaBotmux runtime environment from a pairing code',
    usage: 'orca_botmux environment add --name <name> --pairing-code <code> [--json]',
    allowedFlags: [...GLOBAL_FLAGS, 'name'],
    examples: ['orca_botmux environment add --name work-laptop --pairing-code orca_botmux://pair?code=...']
  },
  {
    path: ['environment', 'list'],
    summary: 'List saved OrcaBotmux runtime environments',
    usage: 'orca_botmux environment list [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'show'],
    summary: 'Show one saved OrcaBotmux runtime environment',
    usage: 'orca_botmux environment show --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  },
  {
    path: ['environment', 'rm'],
    destructive: true,
    summary: 'Remove one saved OrcaBotmux runtime environment',
    usage: 'orca_botmux environment rm --environment <selector> [--json]',
    allowedFlags: [...GLOBAL_FLAGS]
  }
]
