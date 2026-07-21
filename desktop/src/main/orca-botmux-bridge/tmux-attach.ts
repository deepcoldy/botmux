/**
 * Build shell lines that attach to a orca_botmux worker tmux session.
 * Mirrors orca_botmux `TmuxBackend.sessionName`: `bmx-${sessionId.slice(0, 8)}`.
 *
 * No bare `exec`: failed attach keeps the shell so errors stay visible.
 * Keep commands **single-line** with no trailing newline — the PTY startup
 * path appends exactly one submit byte; extra `\n`/`\r` after attach land in
 * the agent input as blank lines.
 */

export function botmuxTmuxSessionName(sessionId: string): string {
  const id = String(sessionId ?? '').trim()
  if (!id) return 'bmx-unknown'
  return `bmx-${id.slice(0, 8)}`
}

export function shellQuote(value: string): string {
  if (value === '') return "''"
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function attachFailHint(message: string): string {
  // Single printf on failure only — no leading blank line that could be
  // confused with input after a partial attach.
  return `printf '%s\\n' ${shellQuote(message)}`
}

/** Local machine: attach to tmux; on failure keep the shell open. */
export function buildLocalTmuxAttachShell(tmuxSessionName: string): string {
  const name = shellQuote(tmuxSessionName)
  return (
    `tmux attach-session -t ${name} || ` +
    attachFailHint(
      `OrcaBotmux: could not attach to ${tmuxSessionName}. Is tmux/agent running? Shift+click for Web.`
    )
  )
}

/**
 * Local PTY → system OpenSSH → remote tmux attach.
 * -tt for real TTY; BatchMode + ConnectTimeout fail fast.
 */
export function buildSshTmuxAttachShell(
  destination: string,
  extraArgs: string[],
  tmuxSessionName: string
): string {
  const dest = destination.trim()
  const remote = `tmux attach-session -t ${tmuxSessionName}`
  const argv = [
    'ssh',
    '-tt',
    '-o',
    'ConnectTimeout=20',
    '-o',
    'BatchMode=yes',
    ...extraArgs.filter(Boolean),
    dest,
    remote
  ]
  const sshLine = argv.map(shellQuote).join(' ')
  return (
    `${sshLine} || ` +
    attachFailHint(
      `OrcaBotmux: SSH/tmux attach to ${dest} failed. Check Settings → SSH and agent. Shift+click for Web.`
    )
  )
}

/**
 * Command to run on the remote host once an OrcaBotmux SSH PTY is already open.
 */
export function buildRemoteTmuxAttachShell(tmuxSessionName: string): string {
  return buildLocalTmuxAttachShell(tmuxSessionName)
}
