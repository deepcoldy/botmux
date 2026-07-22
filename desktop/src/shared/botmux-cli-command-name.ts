export function getBotmuxCliCommandNameForPlatform(platform: NodeJS.Platform): string {
  if (platform === 'linux') {
    return 'botmux-ide'
  }
  if (platform === 'win32') {
    return 'botmux.cmd'
  }
  return 'botmux'
}
