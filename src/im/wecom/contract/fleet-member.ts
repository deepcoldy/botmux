/** gateway 以此退出码退出时，supervisor 不重启该成员。 */
export const WECOM_GATEWAY_NO_RESTART_EXIT_CODE = 78;

/** supervisor 拉起 gateway 时设置；gateway 读取后从自身环境删除。 */
export const WECOM_FLEET_MEMBER_ENV = 'BOTMUX_WECOM_FLEET_MEMBER';

export function wecomFleetMemberName(configId: string): string {
  return `wecom-${configId.slice(0, 12)}`;
}

/** gateway 为它的专用 core 写的日志文件基名：fleet 日志目录下的 `<基名>-out.log` / `<基名>-err.log`。 */
export function wecomCoreLogBaseName(configId: string): string {
  return `${wecomFleetMemberName(configId)}-core`;
}
