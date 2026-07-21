export function getOrcaCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'orca-botmux-ide'
  }
  if (platform === 'win32') {
    return 'orca_botmux.cmd'
  }
  return 'orca_botmux'
}
