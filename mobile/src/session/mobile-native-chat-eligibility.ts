import type { AgentStatusEntry } from '../../../src/shared/agent-status-types'
import { isRuntimeOwnedSshTargetId } from '../../../src/shared/execution-host'
import { isNativeChatSupportedAgent } from '../../../src/shared/native-chat-agent-support'

// Why: native chat renders an agent's own JSONL transcript, and the host
// resolver knows these transcript layouts. Grok is additionally gated on host
// readability because Model-A SSH stores its transcript on the remote target.
export function isMobileNativeChatTranscriptReadable(
  connectionId: string | null | undefined
): boolean {
  return connectionId === null || isRuntimeOwnedSshTargetId(connectionId)
}

export type MobileNativeChatResolution = {
  agent: string
  /** The agent's own session id, or null before it has reported one (the view
   *  then shows a waiting state instead of trying to read an unaddressable file). */
  sessionId: string | null
  /** Hook-reported transcript path. Recent Claude sessions cannot always be
   *  resolved from the provider session id, so mobile forwards this to runtime. */
  transcriptPath: string | null
}

export type MobileNativeChatTab = {
  type: string
  launchAgent?: string | null
  agentStatus?: AgentStatusEntry | null
}

/** Resolve a session tab to the transcript identity native chat needs, or
 *  null when the tab can't show native chat (not a terminal, no agent, or an
 *  agent whose transcript the host can't read). Agent comes from the launch
 *  hint or the live status; session id from the captured provider session. */
export function resolveMobileNativeChat(
  tab: MobileNativeChatTab | null,
  nativeChatTranscriptIsLocalReadable = false
): MobileNativeChatResolution | null {
  if (!tab || tab.type !== 'terminal') {
    return null
  }
  // Why: a supported live hook agent wins. A *known* unsupported live agent
  // (e.g. gemini) must not fall back to a stale launch hint. Missing/unknown
  // status still uses launchAgent so Orca-style agent worktrees stay
  // chat-eligible before the first status frame.
  const liveAgent = tab.agentStatus?.agentType?.trim() || null
  let agent: string | null = null
  if (liveAgent && isNativeChatSupportedAgent(liveAgent)) {
    agent = liveAgent
  } else if (liveAgent && liveAgent !== 'unknown') {
    return null
  } else if (tab.launchAgent && isNativeChatSupportedAgent(tab.launchAgent)) {
    agent = tab.launchAgent
  }
  if (!agent) {
    return null
  }
  if (agent === 'grok' && !nativeChatTranscriptIsLocalReadable) {
    return null
  }
  return {
    agent,
    sessionId: tab.agentStatus?.providerSession?.id ?? null,
    transcriptPath: tab.agentStatus?.providerSession?.transcriptPath ?? null
  }
}

/** Whether the tab can toggle into native chat — gates the long-press item. */
export function canShowMobileNativeChat(
  tab: MobileNativeChatTab | null,
  nativeChatTranscriptIsLocalReadable = false
): boolean {
  return resolveMobileNativeChat(tab, nativeChatTranscriptIsLocalReadable) !== null
}
