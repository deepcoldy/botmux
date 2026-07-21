/**
 * Open orca_botmux web-terminal write-link inside Desktop (secondary BrowserWindow).
 * Prefer in-app over shell.openExternal so users stay in the product shell.
 */
import { BrowserWindow, session } from 'electron'

const openWindows = new Map<string, BrowserWindow>()

export async function openOrcaBotmuxTerminalWindow(opts: {
  url: string
  title?: string
  token?: string | null
}): Promise<{ ok: true; mode: 'in-app' } | { ok: false; reason: string; message: string }> {
  let parsed: URL
  try {
    parsed = new URL(opts.url)
  } catch {
    return { ok: false, reason: 'bad_url', message: 'Invalid terminal URL' }
  }

  const key = `${parsed.origin}${parsed.pathname}`
  const existing = openWindows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    if (existing.webContents.getURL() !== opts.url) {
      await existing.loadURL(opts.url)
    }
    return { ok: true, mode: 'in-app' }
  }

  const partition = `persist:orca-botmux-bridge-terminal`
  const ses = session.fromPartition(partition)

  // Inject dashboard token cookie when URL is loopback so /s/* auth works.
  if (opts.token) {
    try {
      await ses.cookies.set({
        url: parsed.origin,
        name: 'orca_botmux_dashboard_token',
        value: opts.token,
        path: '/',
        httpOnly: true
      })
    } catch {
      // Cookie optional when write-link already embeds ?token=
    }
  }

  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 640,
    minHeight: 420,
    title: opts.title ?? 'OrcaBotmux Terminal',
    show: false,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  })

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show()
  })
  win.on('closed', () => {
    openWindows.delete(key)
  })

  openWindows.set(key, win)
  try {
    await win.loadURL(opts.url)
  } catch (error) {
    openWindows.delete(key)
    if (!win.isDestroyed()) win.destroy()
    return {
      ok: false,
      reason: 'load_failed',
      message: error instanceof Error ? error.message : 'Failed to load terminal URL'
    }
  }
  return { ok: true, mode: 'in-app' }
}
