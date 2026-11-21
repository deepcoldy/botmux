/**
 * Claude Code 2.1.319 transcript records for a permission-gated tool call, shaped
 * after a real probe session: the assistant tool_use, then the user tool_result
 * entry whose `permissionDecision` / `toolDenialKind` say how it was decided.
 */

export const PERMISSION_INPUT = {
  command: "cat > out.mjs <<'EOF'\nconst x = `${a}`;\nEOF\nls *.png | awk '{print $5, $9}'",
  description: 'Render report screenshots',
};

export const AUTO_DENIED = {
  toolUseResult: 'Error: Permission for this command was denied by a built-in Claude Code safety check, not by the user.',
  toolDenialKind: 'permission-rule',
  permissionDecision: { decision: 'reject', source: 'config', reasonType: 'safetyCheck', reasonCode: 'safetyCheck', circuitBreaker: 'dangerousRemoval' },
};
export const TERMINAL_YES = {
  permissionDecision: { decision: 'accept', source: 'user_temporary', grantScope: 'once', reasonCode: 'safetyCheck', circuitBreaker: 'dangerousRemoval' },
};
export const TERMINAL_NO = { toolUseResult: 'User rejected tool use', toolDenialKind: 'user-rejected' };
export const HOOK_ALLOW = {
  permissionDecision: { decision: 'accept', source: 'hook', reasonType: 'hook', reasonCode: 'safetyCheck', circuitBreaker: 'dangerousRemoval' },
};

/** Before any test process starts, like a tool_use created ahead of the hook it spawned. */
export const CALL_CREATED_AT = '2025-01-01T00:00:00.000Z';

export function toolUseLine(
  id: string, input: unknown = PERMISSION_INPUT, messageId = `msg_${id}`, extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    parentUuid: null, isSidechain: false, type: 'assistant', uuid: `a-${id}`, version: '2.1.319', timestamp: CALL_CREATED_AT,
    message: { id: messageId, type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id, name: 'Bash', input }] },
    ...extra,
  }) + '\n';
}

export function toolResultLine(id: string, extra: Record<string, unknown>, isError = true): string {
  return JSON.stringify({
    isSidechain: false, promptId: 'prompt-1', type: 'user', uuid: `u-${id}`, version: '2.1.319',
    sourceToolAssistantUUID: `a-${id}`,
    message: { role: 'user', content: [{ type: 'tool_result', content: 'result text', is_error: isError, tool_use_id: id }] },
    ...extra,
  }) + '\n';
}

export const PROMPT_LINE = JSON.stringify({ type: 'user', message: { role: 'user', content: 'go' }, promptId: 'prompt-1' }) + '\n';

export function permissionPayload(
  transcriptPath: string, input: unknown = PERMISSION_INPUT, extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: 'native-1', transcript_path: transcriptPath, cwd: '/tmp', prompt_id: 'prompt-1',
    permission_mode: 'bypassPermissions', hook_event_name: 'PermissionRequest',
    tool_name: 'Bash', tool_input: input, permission_suggestions: [],
    ...extra,
  };
}
