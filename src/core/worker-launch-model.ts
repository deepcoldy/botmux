import type { CodexReasoningEffort } from '../services/codex-reasoning-effort.js';
/** Wire tri-state: absent retains a snapshot; null explicitly removes a flag. */
export function applyWorkerLaunchModel(
  snapshot: { model?: string; reasoningEffort?: CodexReasoningEffort } | undefined,
  message: { model?: string | null; reasoningEffort?: CodexReasoningEffort | null },
): void {
  if (!snapshot) return;
  if (message.model !== undefined) snapshot.model = message.model ?? undefined;
  if (message.reasoningEffort !== undefined) snapshot.reasoningEffort = message.reasoningEffort ?? undefined;
}
