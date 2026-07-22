const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
// botmux monorepo: desktop owns the Botmux shared modules. Mobile still imports
// them as ../../../src/shared (repo-root relative), so watch the real path under
// desktop/ and/or the botmux/src/* compatibility symlinks.
const sharedRoot = path.resolve(projectRoot, '..', 'desktop', 'src', 'shared')
const rendererRoot = path.resolve(projectRoot, '..', 'desktop', 'src', 'renderer')
const compatShared = path.resolve(projectRoot, '..', 'src', 'shared')
const compatRenderer = path.resolve(projectRoot, '..', 'src', 'renderer')

const config = getDefaultConfig(projectRoot)

config.watchFolders = Array.from(
  new Set(
    [...(config.watchFolders ?? []), sharedRoot, rendererRoot, compatShared, compatRenderer].filter(
      (folder) => {
        try {
          require('node:fs').accessSync(folder)
          return true
        } catch {
          return false
        }
      }
    )
  )
)

module.exports = config
