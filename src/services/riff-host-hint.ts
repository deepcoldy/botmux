/**
 * Operator-facing pointer for every "the Riff sandbox got no botmux answer from
 * the host-tools endpoint" failure. Shared by the sandbox CLI
 * (`callRiffHostTool`) and the verified-CLI bootstrap (riff-backend) so both
 * name the same fix. Leaf module: the sandbox CLI path imports it, so it must
 * stay dependency-free.
 */
export const RIFF_HOST_UNREACHABLE_HINT = 'check that the Riff sandbox can reach the botmux host-tools endpoint'
  + ' (botmux operator: set riff.hostToolsUrl, or platform remote access / BOTMUX_PUBLIC_URL;'
  + ' see https://github.com/deepcoldy/botmux/blob/master/docs/riff.md)';
