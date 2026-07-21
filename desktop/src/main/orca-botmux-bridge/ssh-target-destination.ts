import type { SshTarget } from '../../shared/ssh-types'

/**
 * Map an OrcaBotmux/orca_botmux SSH target into OpenSSH CLI args.
 *
 * Prefer explicit host+username from the Desktop SSH form when available so we
 * do not silently pick a Host-block User (e.g. root) that the stored key cannot
 * authenticate. Always pass IdentityFile/port/jump when present — Desktop PTYs
 * often lack the user's interactive agent (SSH_AUTH_SOCK).
 */
export function buildOpenSshInvocation(target: SshTarget): {
  destination: string
  extraArgs: string[]
  label: string
} {
  const extraArgs = buildOpenSshExtraArgs(target)
  const configHost = target.configHost?.trim() || ''
  const host = target.host?.trim() || ''
  const user = target.username?.trim() || ''

  // Structured user@host wins when both are set — matches how OrcaBotmux connects
  // and avoids Host-block User=root with a non-root key (common Permission denied).
  if (host) {
    const destination = user ? `${user}@${host}` : host
    return {
      destination,
      extraArgs,
      label: target.label || configHost || destination
    }
  }

  if (configHost) {
    return {
      destination: configHost,
      extraArgs,
      label: target.label || configHost
    }
  }

  return {
    destination: 'localhost',
    extraArgs,
    label: target.label || 'localhost'
  }
}

export function buildOpenSshExtraArgs(target: SshTarget): string[] {
  const extraArgs: string[] = []
  if (typeof target.port === 'number' && target.port > 0 && target.port !== 22) {
    extraArgs.push('-p', String(target.port))
  }
  if (target.identityFile?.trim()) {
    extraArgs.push('-i', target.identityFile.trim())
    // Why: without this OpenSSH still tries many agent keys first; IdentitiesOnly
    // forces the stored key that OrcaBotmux used when connecting this target.
    if (target.identitiesOnly !== false) {
      extraArgs.push('-o', 'IdentitiesOnly=yes')
    }
  } else if (target.identitiesOnly) {
    extraArgs.push('-o', 'IdentitiesOnly=yes')
  }
  if (target.identityAgent?.trim()) {
    extraArgs.push('-o', `IdentityAgent=${target.identityAgent.trim()}`)
  }
  if (target.proxyCommand?.trim()) {
    extraArgs.push('-o', `ProxyCommand=${target.proxyCommand.trim()}`)
  }
  if (target.jumpHost?.trim()) {
    extraArgs.push('-J', target.jumpHost.trim())
  }
  return extraArgs
}
