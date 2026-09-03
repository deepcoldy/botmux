// 平台绑定状态：存在 ~/.botmux/platform.json，记录这台机器绑到了哪个平台。
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  readSecureHostFileSync,
  unlinkSecureHostFileSync,
  UnsafeHostAuthorityFileError,
  writeSecureHostFileSync,
} from './secure-host-file.js';

export interface PlatformBinding {
  /** 平台对外地址 */
  platformUrl: string;
  /** 本机稳定标识（重绑保持不变） */
  machineId: string;
  /** 隧道凭证（自包含签名，平台验签） */
  machineToken: string;
  /** 机器展示名（默认机器名） */
  name?: string;
  /** 本机所属的平台团队（成员关系下沉到部署本地，平台零存储靠各机上报重组） */
  teams?: PlatformTeam[];
  /** @deprecated 遗留字段：仅为兼容旧 platform.json 而保留解析，运行期已不再读取。
   *  隧道与所有平台连接现在都不传 family，交给 Node happy-eyeballs 自动选族；
   *  bind 也不再把兜底成功的协议族落盘。 */
  ipFamily?: 4 | 6;
}

export interface PlatformTeam {
  teamId: string;
  teamName: string;
}

export const PLATFORM_BINDING_PATH = join(homedir(), '.botmux', 'platform.json');

export function readPlatformBinding(): PlatformBinding | null {
  try {
    const raw = readSecureHostFileSync(PLATFORM_BINDING_PATH);
    if (raw === null) return null;
    const obj = JSON.parse(raw);
    if (obj && typeof obj.platformUrl === 'string' && typeof obj.machineToken === 'string' && typeof obj.machineId === 'string') {
      return obj as PlatformBinding;
    }
  } catch (error) {
    // File-missing / parse failures still mean "unbound". Permission/symlink
    // failures are different: treat as unbound for callers, but log a clear
    // recovery hint so a hand-copied platform.json does not look like a silent
    // drop-binding mystery.
    if (error instanceof UnsafeHostAuthorityFileError) {
      console.error(
        `[platform-binding] 拒绝读取 ${PLATFORM_BINDING_PATH}: ${error.message}`
        + '（请确保文件权限为 0600、路径不是符号链接，且 ~/.botmux 不可被组/其他用户写入；例: chmod 600 ~/.botmux/platform.json）',
      );
    }
  }
  return null;
}

export function writePlatformBinding(b: PlatformBinding): void {
  writeSecureHostFileSync(PLATFORM_BINDING_PATH, `${JSON.stringify(b, null, 2)}\n`);
}

/**
 * 解绑：删除本地平台绑定文件（~/.botmux/platform.json）。
 * 平台侧 owner 点了「解绑」并吊销了 machine token 后，daemon 收到 unbound 消息时调用，
 * 把本地凭证清干净——下次 `botmux bind` 重新写入即可重新绑定。文件不存在视为已清理。
 */
export function clearPlatformBinding(): void {
  try {
    unlinkSecureHostFileSync(PLATFORM_BINDING_PATH);
  } catch {
    /* ignore */
  }
}

/**
 * 绑定平台后，本机对外可达的「机器子域」基址 `https://m-<machineId>.<平台域名>`，
 * 平台会把该子域经隧道反代回本机 dashboard。域名从 binding.platformUrl 运行时推导
 * （公开仓库不写死平台域名）；前缀 `m-` 是平台约定。未绑定返回 null。
 */
export function platformMachineBaseUrl(): string | null {
  const b = readPlatformBinding();
  if (!b) return null;
  try {
    const u = new URL(b.platformUrl);
    return `${u.protocol}//m-${b.machineId}.${u.host}`;
  } catch {
    return null;
  }
}

/**
 * 平台面向浏览器的、本机可信子域 authority 列表（`host` 形式，不含 scheme）。
 *
 * 中心平台把本机放在 `<前缀>-<machineId>.<平台域名>` 子域下,再经隧道反代回本机
 * dashboard——反代时把 `Host` 改写成回环上游、且**不带 `X-Forwarded-Host`**,于是
 * 浏览器发的管理类 WS/请求携带的 `Origin: https://<前缀>-<machineId>.<平台域名>`
 * 在 dashboard 的同源校验里找不到匹配的候选 authority(见 dashboard/control-csrf.ts
 * 的 `requestAuthorities`),被判跨站拒掉——平台浏览器终端 disconnected。
 *
 * 这里由本机 `platform.json`(0600 host-authority,machineId 平台签发、跨站页面
 * **伪造不进**)派生出**精确前缀**的可信 authority,交给 `requestAuthorities` 并入
 * 候选。为什么**枚举** `m-`/`t-` 精确前缀而非通配 `<任意前缀>-<machineId>`:
 *   • 安全门须 fail-closed。枚举只依赖「这 2 个前缀反代到本机」这条弱不变量;通配
 *     `*-<machineId>` 依赖「**任何**前缀标签都不会落到攻击者可控源」——强得多、且
 *     本进程无从验证(平台路由表不在部署机上)。
 *   • 失败方向相反:枚举漏一个前缀 = 那种终端连不上(响、加一行前缀即修);通配一旦
 *     平台某天把某 `<label>-<machineId>` 挂到多租户/共享源上 = **静默把跨源认成同源**
 *     的 CSRF 洞。宁可响不可哑。
 * `m-` 是仓库既有约定(`platformMachineBaseUrl`);`t-` 是平台给浏览器分享链接实际使用
 * 的独立终端子域(仓库无此字面量,故 #933 的同源门漏了它)。未绑定平台 → 返回空数组,
 * 不放行任何平台 authority(fail-closed)。
 *
 * 每次调用都重读 `platform.json`(不缓存):`botmux bind|unbind` 热重载不重启 daemon
 * (见 worker.ts 亦每请求 uncached 读),缓存会在解绑+machineToken 吊销后仍放行 stale
 * 平台 authority = fail-open;每请求读天然 fail-closed(解绑→文件没了→空数组)。
 *
 * **两个子域不是一个用途**,所以按 surface 分开给:
 *   • `terminal-upgrade`(终端 WebSocket 升级)= `m-` + `t-`。业务上就是这一条需要
 *     `t-`:平台分享出去的终端页挂在 `t-` 子域下,它的 WS 握手 Origin 就是 `t-`
 *     (#933/#960 修的正是这条)。
 *   • `management`(有副作用的管理类 POST:接管/释放、预览解锁、locate)= 只给 `m-`。
 *     Dashboard SPA 只在 `m-` 子域下渲染,CSRF 票据也只注入到那张壳页里;`t-` 上的
 *     终端页既没有票据、也没有任何管理请求要发。把它一并算作「同源」只会让一条本
 *     不需要的子域凭空具备发起写操作的资格——收窄不影响任何现有链路,却把面缩小。
 */
export type PlatformBrowserSurface = 'management' | 'terminal-upgrade';

export function platformBrowserAuthorities(surface: PlatformBrowserSurface = 'management'): string[] {
  const b = readPlatformBinding();
  if (!b) return [];
  try {
    const host = new URL(b.platformUrl).host;
    if (!host) return [];
    const machine = `m-${b.machineId}.${host}`;
    return surface === 'terminal-upgrade' ? [machine, `t-${b.machineId}.${host}`] : [machine];
  } catch {
    return [];
  }
}

/**
 * 自建反代对外基址（`BOTMUX_PUBLIC_URL`）：没接中心平台、但自己用 nginx 等反代把
 * dashboard 暴露到单一公网/内网域名时，设成 `http://botmux.example.com`
 * （scheme + host[:port]，尾部斜杠会被去掉）。设了之后 dashboard / 卡片终端链接改吐
 * `<基址>/…`、`<基址>/s/<sessionId>`，走 dashboard 前门、无需 per-bot 端口。未设返回
 * null → 调用方回退本地 `host:port`。它与 {@link platformMachineBaseUrl} 是「中心平台
 * vs 自建反代」两条对外基址来源；优先级由调用方定（平台 > 本函数 > 本地）。
 */
export function publicReverseProxyBaseUrl(): string | null {
  const raw = process.env.BOTMUX_PUBLIC_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/** 更新本机平台团队列表并落盘（读最新 binding 防覆盖其它字段）。返回更新后的列表。 */
export function setPlatformTeams(teams: PlatformTeam[]): PlatformTeam[] {
  const b = readPlatformBinding();
  if (!b) return [];
  b.teams = teams;
  writePlatformBinding(b);
  return teams;
}
