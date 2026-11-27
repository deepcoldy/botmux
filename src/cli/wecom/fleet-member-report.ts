/**
 * The WeCom lines `botmux start` / `botmux restart` print after the fleet is up.
 *
 * WeCom members are not part of the fleet's health gate (a connection replaced
 * elsewhere, or with revoked credentials, must not fail a Feishu restart or roll
 * an update back). Their state is reported on its own instead: one line naming
 * the connections that came up, one warning per connection that did not, and
 * nothing at all on a host without a running WeCom connection. Never changes the
 * command's exit code.
 */
import { join } from 'node:path';

/** How long the report waits for every WeCom member to be online. */
export const WECOM_FLEET_REPORT_WAIT_MS = 15_000;
/**
 * Then how long it keeps watching before saying a member is up. A member is
 * `online` the moment its gateway process exists; a gateway that cannot use its
 * configuration or credentials exits a second or two later, and should be
 * reported as not up rather than as up.
 */
export const WECOM_FLEET_REPORT_SETTLE_MS = 3_000;

export interface WecomFleetReportDeps {
  /** wecomFleetMemberNames(): the WeCom members the supervisor should run. */
  memberNames(): string[];
  /** waitFleetOnline(names, timeoutMs).pending */
  pendingAfter(names: readonly string[], timeoutMs: number): string[];
  sleep(ms: number): Promise<void>;
  logDir: string;
  log(line: string): void;
  warn(line: string): void;
}

export async function reportWecomFleetMembers(deps: WecomFleetReportDeps): Promise<void> {
  let names: string[];
  try {
    names = deps.memberNames();
  } catch {
    return;
  }
  if (names.length === 0) return;
  let pending = deps.pendingAfter(names, WECOM_FLEET_REPORT_WAIT_MS);
  if (pending.length === 0) {
    await deps.sleep(WECOM_FLEET_REPORT_SETTLE_MS);
    pending = deps.pendingAfter(names, 0);
  }
  const up = names.filter(name => !pending.includes(name));
  if (up.length > 0) deps.log(`   企业微信连接已上线: ${up.join(', ')}`);
  for (const name of pending) {
    const logs = join(deps.logDir, `${name}-{out,err}.log`);
    deps.warn(`⚠️  企业微信连接 ${name} 没有上线（不影响本次结果）；用 \`botmux status\` 查看，日志: ${logs}`);
  }
}
