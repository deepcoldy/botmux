/**
 * Resolve orca_botmux dashboard via central platform machine subdomain
 * (https://m-<machineId>.<platform-host>) when ~/.orca_botmux/platform.json is bound.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DashboardEndpoint } from './orca-botmux-dashboard-client'
import type { OrcaBotmuxBridgeTransport } from './types'

export function resolvePlatformDashboardEndpoint(
  transport: Extract<OrcaBotmuxBridgeTransport, { kind: 'platform' }>
): DashboardEndpoint | { ok: false; reason: string; message: string } {
  const botmuxHome = join(homedir(), '.orca_botmux')
  let baseUrl = transport.baseUrl?.trim()
  let token = transport.token?.trim() || null

  if (!baseUrl) {
    const bindingPath = join(botmuxHome, 'platform.json')
    if (!existsSync(bindingPath)) {
      return {
        ok: false,
        reason: 'no_platform_binding',
        message:
          'No ~/.orca_botmux/platform.json. Run `orca_botmux bind` or pass baseUrl for platform tunnel.'
      }
    }
    try {
      const b = JSON.parse(readFileSync(bindingPath, 'utf8')) as {
        platformUrl?: string
        machineId?: string
      }
      if (!b.platformUrl || !b.machineId) {
        return {
          ok: false,
          reason: 'bad_platform_binding',
          message: 'platform.json missing platformUrl or machineId'
        }
      }
      const u = new URL(b.platformUrl)
      baseUrl = `${u.protocol}//m-${b.machineId}.${u.host}`
    } catch (error) {
      return {
        ok: false,
        reason: 'bad_platform_binding',
        message: error instanceof Error ? error.message : 'invalid platform.json'
      }
    }
  }

  if (!token) {
    const tokenPath = join(botmuxHome, '.dashboard-token')
    if (existsSync(tokenPath)) {
      token = readFileSync(tokenPath, 'utf8').trim() || null
    }
  }

  return {
    baseUrl: baseUrl.replace(/\/$/, ''),
    token,
    transport
  }
}
