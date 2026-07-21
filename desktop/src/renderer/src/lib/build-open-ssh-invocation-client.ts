/**
 * Renderer-side mirror of main `buildOpenSshInvocation` for display labels.
 * Keep in sync with `src/main/orca-botmux-bridge/ssh-target-destination.ts`.
 */
import type { SshTarget } from '../../../shared/ssh-types'

export function buildOpenSshInvocation(
  target: Pick<
    SshTarget,
    | 'configHost'
    | 'label'
    | 'host'
    | 'port'
    | 'username'
    | 'identityFile'
    | 'identitiesOnly'
    | 'identityAgent'
    | 'proxyCommand'
    | 'jumpHost'
  >
): {
  destination: string
  label: string
} {
  const configHost = target.configHost?.trim() || ''
  const host = target.host?.trim() || ''
  const user = target.username?.trim() || ''

  if (host) {
    const destination = user ? `${user}@${host}` : host
    return {
      destination,
      label: target.label || configHost || destination
    }
  }

  if (configHost) {
    return {
      destination: configHost,
      label: target.label || configHost
    }
  }

  return {
    destination: 'localhost',
    label: target.label || 'localhost'
  }
}
