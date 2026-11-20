/**
 * CLI handler for `botmux agy-accounts` (alias: `antigravity-accounts`).
 *
 * Manages host-stored Antigravity (`agy`) OAuth token snapshots in
 * `~/.botmux/antigravity-accounts/` and controls automatic quota-limit rotation.
 */
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCliAdapterSync } from '../adapters/cli/registry.js';
import { formatAntigravityCooldown } from '../core/antigravity-rotation.js';
import {
  clearAntigravityAccountCooldown,
  inspectAntigravityAccounts,
  isValidAntigravityAccountId,
  reconcileActiveAntigravityToken,
  removeAntigravityAccount,
  rotateNextAntigravityAccount,
  saveAntigravityAccount,
  setAntigravityAccountEnabled,
  setAntigravityAutoRotate,
  useAntigravityAccount,
  type AntigravityAccountStoreOptions,
} from '../services/antigravity-accounts.js';

export interface RunAntigravityAccountsOptions {
  /** Reject mutating actions when called from a sandboxed or session-scoped CLI process. */
  isBlockedInSession?: boolean;
  /** Store path/clock overrides (test seam). */
  storeOptions?: AntigravityAccountStoreOptions;
  /** Override spawning `agy` during `login` (test seam). */
  runLoginProcess?: (opts: { bin: string; tempHome: string; env: NodeJS.ProcessEnv }) => Promise<number | null>;
  /** Override `agy` binary path (test seam). */
  agyBin?: string;
  writeOut?: (line: string) => void;
  writeErr?: (line: string) => void;
}

const USAGE = [
  '用法：botmux agy-accounts <子命令> [参数]',
  '',
  '子命令：',
  '  list [--json]                     列出已托管的 Antigravity 账号与冷却状态',
  '  save <别名> [--force] [--activate] 纳管当前 ~/.gemini/antigravity-cli/antigravity-oauth-token',
  '  login <别名> [--force] [--activate] 在临时隔离 HOME 启动 agy 登录新账号并导入托管库（不影响现网会话）',
  '  use <别名> [--allow-disabled]     切换活跃账号',
  '  next [--include-cooldown]         轮换到下一个可用账号',
  '  enable <别名>                     启用账号参与轮换',
  '  disable <别名>                    禁用账号（不参与轮换）',
  '  remove <别名>                     从托管库移除账号并删除其凭据快照',
  '  clear-cooldown [<别名> | --all]   清除限额冷却状态',
  '  auto-rotate [on|off|status]       开关或查看限额自动轮换',
  '  sync                              同步当前活跃凭据（回存新刷新的 token 并校准活跃账号）',
].join('\n');

function positionalArgs(args: readonly string[]): string[] {
  return args.filter(a => !a.startsWith('-'));
}

function assertHostMutationAllowed(opts: RunAntigravityAccountsOptions): void {
  if (opts.isBlockedInSession) {
    throw new Error('沙箱/会话内不能修改宿主 Antigravity 托管账号');
  }
}

async function defaultRunLoginProcess(opts: {
  bin: string;
  tempHome: string;
  env: NodeJS.ProcessEnv;
}): Promise<number | null> {
  return await new Promise<number | null>((resolve, reject) => {
    const child = spawn(opts.bin, [], { env: opts.env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}

function buildIsolatedLoginEnv(tempHome: string, baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HOME: tempHome,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
  // On Linux, drop D-Bus / keyring env so agy writes the file fallback token
  // inside tempHome rather than mutating the desktop keyring.
  if (process.platform === 'linux') {
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.GNOME_KEYRING_CONTROL;
    delete env.GNOME_KEYRING_PID;
  }
  return env;
}

export async function runAntigravityAccountsCommand(
  args: readonly string[],
  opts: RunAntigravityAccountsOptions = {},
): Promise<void> {
  const out = opts.writeOut ?? ((line: string) => console.log(line));
  const err = opts.writeErr ?? ((line: string) => console.error(line));
  const storeOpts = opts.storeOptions ?? {};

  const action = args[0] ?? 'list';
  const rest = args.slice(1);
  const pos = positionalArgs(rest);

  if (action === 'help' || action === '--help' || action === '-h' || rest.includes('--help') || rest.includes('-h')) {
    out(USAGE);
    return;
  }

  if (action === 'list' || action === 'ls') {
    const rawInfo = inspectAntigravityAccounts(storeOpts);
    const info = opts.isBlockedInSession
      ? {
          ...rawInfo,
          liveEmail: undefined,
          accounts: rawInfo.accounts.map(({ email: _redacted, ...acc }) => acc),
        }
      : rawInfo;
    if (rest.includes('--json')) {
      out(JSON.stringify(info, null, 2));
      return;
    }
    if (info.keyringRisk.warning) {
      err(`⚠️ ${info.keyringRisk.warning}`);
    }
    out(`自动轮换: ${info.autoRotate ? '开启' : '关闭'}  |  可用: ${info.availableCount}/${info.enabledCount}`);
    const liveDisplay = opts.isBlockedInSession ? info.liveMaskedEmail : info.liveEmail;
    out(`本机当前凭据: ${info.liveTokenPresent ? (liveDisplay ?? '<已登录，无邮箱字段>') : '<未登录>'}`);
    if (!info.managed) {
      out('尚无托管账号。可执行 `botmux agy-accounts save <别名>` 纳管当前账号，或 `botmux agy-accounts login <别名>` 登录新账号。');
      return;
    }
    if (info.activeId && !info.liveTokenMatchesActive) {
      err(`⚠️ 本机 live token 与当前活跃托管账号 "${info.activeId}" 不一致；下次启动 agy 或执行 \`botmux agy-accounts sync\` 将自动校准。`);
    }
    out('');
    for (const acc of info.accounts) {
      const mark = acc.active ? '*' : ' ';
      const flags: string[] = [];
      if (!acc.enabled) flags.push('disabled');
      if (!acc.hasValidToken) flags.push('token-missing');
      if (acc.inCooldown && acc.cooldownRemainingMs !== undefined) {
        flags.push(`cooldown ${formatAntigravityCooldown(acc.cooldownRemainingMs, 'zh')}`);
      }
      const statusText = flags.length > 0 ? `[${flags.join(', ')}]` : '[ready]';
      const emailDisplay = opts.isBlockedInSession ? acc.maskedEmail : ('email' in acc ? acc.email : undefined);
      out(`  ${mark} ${acc.id.padEnd(16)} ${(emailDisplay ?? '-').padEnd(32)} ${statusText}`);
    }
    return;
  }

  if (action === 'auto-rotate') {
    const mode = pos[0] ?? 'status';
    if (mode === 'status') {
      const info = inspectAntigravityAccounts(storeOpts);
      out(`auto-rotate: ${info.autoRotate ? 'on' : 'off'}`);
      return;
    }
    assertHostMutationAllowed(opts);
    if (mode !== 'on' && mode !== 'off') {
      throw new Error('用法：botmux agy-accounts auto-rotate [on|off|status]');
    }
    const res = setAntigravityAutoRotate(mode === 'on', storeOpts);
    out(`✅ 已${res.autoRotate ? '开启' : '关闭'} Antigravity 限额自动轮换`);
    return;
  }

  assertHostMutationAllowed(opts);

  switch (action) {
    case 'save': {
      const id = pos[0];
      if (!id) throw new Error('用法：botmux agy-accounts save <别名> [--force] [--activate]');
      const res = saveAntigravityAccount(id, {
        ...storeOpts,
        force: rest.includes('--force'),
        activate: rest.includes('--activate') ? true : undefined,
      });
      out(
        `✅ 已${res.updated ? '更新' : '纳管'}账号 ${res.id}`
        + `${res.email ? ` (${res.email})` : ''}`
        + `${res.activated ? '（已设为当前活跃账号）' : ''}`,
      );
      return;
    }

    case 'login': {
      const id = pos[0];
      if (!id) throw new Error('用法：botmux agy-accounts login <别名> [--force] [--activate]');
      if (!isValidAntigravityAccountId(id)) {
        throw new Error('账号别名只能包含字母、数字、-、_，且必须以字母或数字开头（最长 64 字符）');
      }
      const keyringRisk = inspectAntigravityAccounts(storeOpts).keyringRisk;
      if (keyringRisk.status === 'macos-keychain' && keyringRisk.warning) {
        err(`⚠️ ${keyringRisk.warning}`);
      }
      const bin = opts.agyBin ?? createCliAdapterSync('antigravity').resolvedBin;
      const tempHome = mkdtempSync(join(tmpdir(), 'botmux-agy-login-'));
      if (process.platform !== 'win32') {
        try { chmodSync(tempHome, 0o700); } catch { /* best-effort */ }
      }
      const tempTokenPath = join(tempHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
      out(`正在隔离目录启动 agy 登录账号 "${id}"（不会影响当前已登录账号与在线会话）。`);
      out('完成 Google OAuth 登录后，在 agy 界面输入 /exit 退出即可自动导入托管库。');
      try {
        const env = buildIsolatedLoginEnv(tempHome);
        const runner = opts.runLoginProcess ?? defaultRunLoginProcess;
        await runner({ bin, tempHome, env });
        const res = saveAntigravityAccount(id, {
          ...storeOpts,
          sourceTokenPath: tempTokenPath,
          force: rest.includes('--force'),
          activate: rest.includes('--activate') ? true : undefined,
        });
        out(
          `✅ 登录并导入账号 ${res.id}`
          + `${res.email ? ` (${res.email})` : ''}`
          + `${res.activated ? '（已设为当前活跃账号）' : ''}`,
        );
      } finally {
        try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* best-effort */ }
      }
      return;
    }

    case 'use': {
      const id = pos[0];
      if (!id) throw new Error('用法：botmux agy-accounts use <别名> [--allow-disabled]');
      const res = useAntigravityAccount(id, {
        ...storeOpts,
        allowDisabled: rest.includes('--allow-disabled'),
      });
      out(
        `✅ 已切换活跃账号：${res.fromId ?? '<无>'} → ${res.toId}`
        + `${res.email ? ` (${res.email})` : ''}`
        + `${res.inCooldown ? '（注意：该账号当前仍在冷却中）' : ''}`,
      );
      out('提示：新会话及重启后的会话将立即使用该账号；正在运行的旧会话如需切换请执行 /restart。');
      return;
    }

    case 'next': {
      const res = rotateNextAntigravityAccount({
        ...storeOpts,
        includeCooldown: rest.includes('--include-cooldown'),
      });
      out(
        `✅ 已轮换活跃账号：${res.fromId ?? '<无>'} → ${res.toId}`
        + `${res.email ? ` (${res.email})` : ''}`,
      );
      out('提示：新会话及重启后的会话将立即使用该账号；正在运行的旧会话如需切换请执行 /restart。');
      return;
    }

    case 'enable': {
      const id = pos[0];
      if (!id) throw new Error('用法：botmux agy-accounts enable <别名>');
      const res = setAntigravityAccountEnabled(id, true, storeOpts);
      out(`✅ 已启用账号 ${res.id}`);
      return;
    }

    case 'disable': {
      const id = pos[0];
      if (!id) throw new Error('用法：botmux agy-accounts disable <别名>');
      const res = setAntigravityAccountEnabled(id, false, storeOpts);
      out(`✅ 已禁用账号 ${res.id}`);
      if (res.activeId === res.id) {
        out('提示：该账号仍是当前 activeId；下次自动轮换或新会话启动时将自动切向其他可用账号，也可手动执行 `botmux agy-accounts next`。');
      }
      return;
    }

    case 'remove':
    case 'rm': {
      const id = pos[0];
      if (!id) throw new Error('用法：botmux agy-accounts remove <别名>');
      const res = removeAntigravityAccount(id, storeOpts);
      out(
        `✅ 已移除账号 ${res.removedId}`
        + (res.newActiveId ? `（当前活跃账号已切换为 ${res.newActiveId}）` : '（当前无剩余活跃托管账号）'),
      );
      return;
    }

    case 'clear-cooldown': {
      const all = rest.includes('--all') || pos[0] === 'all';
      const target = all ? 'all' : pos[0];
      if (!target) throw new Error('用法：botmux agy-accounts clear-cooldown <别名> | --all');
      const res = clearAntigravityAccountCooldown(target, storeOpts);
      if (res.clearedIds.length === 0) {
        out('当前没有需要清除的冷却状态。');
      } else {
        out(`✅ 已清除冷却状态：${res.clearedIds.join(', ')}`);
      }
      return;
    }

    case 'sync': {
      const res = reconcileActiveAntigravityToken(storeOpts);
      if (!res.managed) {
        out('尚未托管任何 Antigravity 账号，无需同步。');
        return;
      }
      if (res.error) {
        throw new Error(`同步失败：${res.error}`);
      }
      const notes: string[] = [];
      if (res.syncedBackId) notes.push(`已回存最新 token 到 ${res.syncedBackId}`);
      if (res.advancedFrom) notes.push(`已从 ${res.advancedFrom} 自动前进至 ${res.activeId}`);
      if (res.restored) notes.push(`已将 live token 校准为 ${res.activeId}`);
      out(`✅ 同步完成（当前活跃账号: ${res.activeId}${res.email ? ` (${res.email})` : ''}）${notes.length ? ` — ${notes.join('；')}` : ''}`);
      return;
    }

    default:
      throw new Error(`未知子命令: ${action}\n\n${USAGE}`);
  }
}
