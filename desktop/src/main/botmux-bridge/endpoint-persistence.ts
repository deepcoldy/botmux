/**
 * Persist multi-host Botmux bridge endpoints across app restarts.
 * Stored under Electron userData so it follows the Desktop profile, not ~/.botmux CLI home.
 *
 * The file is the **user-desired** endpoint list (not only currently-live tunnels).
 * Failed reconnects must not erase hosts — otherwise every cold start that races
 * SSH readiness forces the user to click "+ remote" again.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { botmuxEndpointId, type BotmuxBridgeTransport } from './types'

const FILE_NAME = 'botmux-bridge-endpoints.json'
const SCHEMA = 1 as const

export type PersistedBridgeEndpoint = {
  /** Stable endpoint id (local | ssh:… | ssh:manual:…) */
  id: string
  transport: BotmuxBridgeTransport
}

type PersistFile = {
  schemaVersion: typeof SCHEMA
  endpoints: PersistedBridgeEndpoint[]
  updatedAt: number
}

function filePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

export function loadPersistedBridgeEndpoints(): PersistedBridgeEndpoint[] {
  try {
    const path = filePath()
    if (!existsSync(path)) return []
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PersistFile>
    if (raw.schemaVersion !== SCHEMA || !Array.isArray(raw.endpoints)) return []
    return raw.endpoints.filter(
      (e) => e && typeof e.id === 'string' && e.transport && typeof e.transport === 'object'
    )
  } catch {
    return []
  }
}

export function savePersistedBridgeEndpoints(endpoints: PersistedBridgeEndpoint[]): void {
  try {
    const path = filePath()
    mkdirSync(dirname(path), { recursive: true })
    const body: PersistFile = {
      schemaVersion: SCHEMA,
      endpoints,
      updatedAt: Date.now()
    }
    writeFileSync(path, JSON.stringify(body, null, 2), { mode: 0o600 })
  } catch (error) {
    console.warn(
      '[botmux-bridge] failed to persist endpoints',
      error instanceof Error ? error.message : error
    )
  }
}

/** Serialize transport without ephemeral fields that shouldn't be re-applied blindly. */
export function transportForPersist(transport: BotmuxBridgeTransport): BotmuxBridgeTransport {
  if (transport.kind === 'local') return { kind: 'local' }
  if (transport.kind === 'platform') {
    return {
      kind: 'platform',
      baseUrl: transport.baseUrl,
      label: transport.label
      // token re-read from ~/.botmux on reconnect
    }
  }
  return {
    kind: 'ssh',
    sshTargetId: transport.sshTargetId,
    target: transport.target,
    label: transport.label,
    remoteBotmuxHome: transport.remoteBotmuxHome,
    remoteDashboardPort: transport.remoteDashboardPort
    // sshExtraArgs rebuilt from SSH store on reconnect when sshTargetId is set
  }
}

/** Remember a host the user connected (or reconnected). Never drops other hosts. */
export function upsertPersistedBridgeEndpoint(transport: BotmuxBridgeTransport): string {
  const normalized = transportForPersist(transport)
  const id = botmuxEndpointId(normalized)
  const existing = loadPersistedBridgeEndpoints().filter((e) => e.id !== id)
  existing.push({ id, transport: normalized })
  savePersistedBridgeEndpoints(existing)
  return id
}

/** Remove only after explicit user disconnect. */
export function removePersistedBridgeEndpoint(endpointId: string): void {
  const next = loadPersistedBridgeEndpoints().filter((e) => e.id !== endpointId)
  savePersistedBridgeEndpoints(next)
}

export function clearPersistedBridgeEndpoints(): void {
  savePersistedBridgeEndpoints([])
}
