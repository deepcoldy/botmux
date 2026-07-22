export function pickRemoteCliEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {}
  for (const key of [
    'BOTMUX_TERMINAL_HANDLE',
    'BOTMUX_WORKTREE_ID',
    'BOTMUX_PANE_KEY',
    'BOTMUX_WORKSPACE_ID',
    'BOTMUX_USER_DATA_PATH',
    'PATH',
    'Path'
  ]) {
    const value = env[key]
    if (typeof value === 'string') {
      picked[key] = value
    }
  }
  return picked
}
