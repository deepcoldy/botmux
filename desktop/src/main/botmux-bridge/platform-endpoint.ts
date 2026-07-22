/**
 * Resolve botmux dashboard via central platform machine subdomain
 * (https://m-<machineId>.<platform-host>) when platform.json is bound.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DashboardEndpoint } from './botmux-dashboard-client'
import type { BotmuxBridgeTransport } from './types'

function resolvePlatformBotmuxHome(home = homedir()): string {
  const primary = join(home, '.botmux')
  const legacy = join(home, '.botmux')
  if (existsSync(join(primary, 'platform.json'))) return primary
  if (existsSync(join(legacy, 'platform.json'))) return legacy
  return primary
}

export function resolvePlatformDashboardEndpoint(
  transport: Extract<BotmuxBridgeTransport, { kind: 'platform' }>
): DashboardEndpoint | { ok: false; reason: string; message: string } {
  const botmuxHome = resolvePlatformBotmuxHome()
  let baseUrl = transport.baseUrl?.trim()
  let token = transport.token?.trim() || null

  if (!baseUrl) {
    const bindingPath = join(botmuxHome, 'platform.json')
    if (!existsSync(bindingPath)) {
      return {
        ok: false,
        reason: 'no_platform_binding',
        message:
          'No platform.json under ~/.botmux (or legacy ~/.botmux). Run `botmux bind` or pass baseUrl for platform tunnel.'
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
