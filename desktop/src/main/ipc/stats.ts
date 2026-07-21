import { ipcMain } from 'electron'
import type { StatsCollector } from '../stats/collector'

export function registerStatsHandlers(stats: StatsCollector): void {
  ipcMain.handle('stats:summary', () => {
    return stats.getSummary()
  })
}
