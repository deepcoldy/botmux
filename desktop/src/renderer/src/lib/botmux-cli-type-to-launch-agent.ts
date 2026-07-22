/**
 * Map a Botmux daemon `cliType` / `cliId` onto a desktop `TuiAgent` so attach
 * tabs can opt into native chat like Orca agent worktrees.
 *
 * Daemon rows use product ids (`claude-code`); desktop tabs use TuiAgent ids
 * (`claude`). Aliases cover common historical / wrapper spellings.
 */
import { agentKindToTuiAgent } from '../../../shared/agent-kind'
import type { AgentKind } from '../../../shared/telemetry-events'
import type { TuiAgent } from '../../../shared/types'

/** Extra botmux/daemon spellings that are not AgentKind enum members. */
const CLI_TYPE_ALIASES: Record<string, TuiAgent> = {
  claude: 'claude',
  'claude-code': 'claude',
  claudecode: 'claude',
  openclaude: 'openclaude',
  codex: 'codex',
  grok: 'grok',
  // Why: some bots report the bin name rather than the product id.
  'claude-code-cli': 'claude'
}

export function resolveBotmuxCliTypeToLaunchAgent(
  cliType: string | null | undefined
): TuiAgent | null {
  const raw = cliType?.trim().toLowerCase()
  if (!raw) return null
  const aliased = CLI_TYPE_ALIASES[raw]
  if (aliased) return aliased
  // Why: agentKindToTuiAgent already reverse-maps every shipped AgentKind.
  return agentKindToTuiAgent(raw as AgentKind)
}
