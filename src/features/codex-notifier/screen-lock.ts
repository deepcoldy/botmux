import { execFileSync } from 'node:child_process';

export type ScreenLockState = 'locked' | 'unlocked' | 'unknown' | 'unsupported';

/** 解析 macOS IORegistry 的控制台会话锁屏字段。 */
export function parseMacScreenLock(output: string | Buffer): Exclude<ScreenLockState, 'unsupported'> {
  const text = typeof output === 'string' ? output : output.toString();
  const root = text.match(/"IOConsoleLocked"\s*=\s*(Yes|No|true|false)/i)?.[1]?.toLowerCase();
  if (root === 'yes' || root === 'true') {
    return 'locked';
  }
  if (root === 'no' || root === 'false') {
    return 'unlocked';
  }
  if (/"CGSSessionScreenIsLocked"\s*=\s*(?:Yes|true)/i.test(text)) {
    return 'locked';
  }
  if (/"CGSSessionScreenIsLocked"\s*=\s*(?:No|false)/i.test(text)) {
    return 'unlocked';
  }
  // 较老系统只提供 IOConsoleUsers；没有 locked=true 时按已解锁处理。
  if (/"IOConsoleUsers"\s*=/.test(text)) return 'unlocked';
  return 'unknown';
}

/** 在任务完成时读取当前锁屏状态；探测失败返回 unknown，非 macOS 明确 unsupported。 */
export function detectScreenLock(options: {
  platform?: NodeJS.Platform;
  execFile?: typeof execFileSync;
} = {}): ScreenLockState {
  const platform = options.platform ?? process.platform;
  const execFile = options.execFile ?? execFileSync;
  if (platform !== 'darwin') return 'unsupported';
  try {
    const output = execFile('/usr/sbin/ioreg', ['-n', 'Root', '-d1'], {
      encoding: 'utf8',
      timeout: 1_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseMacScreenLock(output);
  } catch {
    return 'unknown';
  }
}

/** macOS 探测异常时宁可多通知一次；不支持的平台不会把 locked_only 退化成 always。 */
export function shouldNotifyForLockState(
  notifyWhen: 'locked_only' | 'always',
  lockState: ScreenLockState,
): boolean {
  if (notifyWhen === 'always') return true;
  return lockState === 'locked' || lockState === 'unknown';
}
