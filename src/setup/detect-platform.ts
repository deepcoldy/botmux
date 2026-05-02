/**
 * Platform / package-manager detection for the auto-install flow.
 *
 * All probes are best-effort and synchronous; failures degrade gracefully
 * to "unknown" so callers can route to a manual-install message.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

export type DistroId =
  | 'debian' | 'ubuntu'
  | 'fedora' | 'rhel' | 'centos' | 'rocky' | 'almalinux'
  | 'arch' | 'manjaro'
  | 'alpine'
  | 'opensuse' | 'opensuse-leap' | 'opensuse-tumbleweed'
  | 'unknown';

export type PackageManager =
  | 'brew'      // user-scope, no sudo
  | 'conda'     // user-scope, no sudo
  | 'apt'       // sudo
  | 'dnf' | 'yum'
  | 'pacman'
  | 'zypper'
  | 'apk'
  | 'unknown';

export interface PlatformInfo {
  os: 'darwin' | 'linux' | 'other';
  distro: DistroId;
  /** Ordered preference: user-scope managers first, then system ones. */
  packageManagers: PackageManager[];
  isRoot: boolean;
  hasTty: boolean;
  /** True iff `sudo -n true` succeeds — i.e. NOPASSWD sudoers are configured. */
  passwordlessSudo: boolean;
}

function which(cmd: string): boolean {
  try {
    execSync(`command -v ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readOsRelease(): Record<string, string> {
  try {
    const raw = readFileSync('/etc/os-release', 'utf-8');
    const out: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      let val = m[2]!;
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      out[m[1]!] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function detectDistro(): DistroId {
  if (process.platform !== 'linux') return 'unknown';
  const rel = readOsRelease();
  const id = (rel['ID'] ?? '').toLowerCase();
  const idLike = (rel['ID_LIKE'] ?? '').toLowerCase();
  const candidates = [id, ...idLike.split(/\s+/)].filter(Boolean);

  for (const c of candidates) {
    if (c === 'debian' || c === 'ubuntu') return c as DistroId;
    if (c === 'fedora' || c === 'rhel' || c === 'centos' || c === 'rocky' || c === 'almalinux') {
      return c as DistroId;
    }
    if (c === 'arch' || c === 'manjaro') return c as DistroId;
    if (c === 'alpine') return 'alpine';
    if (c === 'opensuse' || c === 'opensuse-leap' || c === 'opensuse-tumbleweed') return c as DistroId;
    // ID_LIKE often only has the family name; fold it down.
    if (c === 'rhel' || c === 'fedora') return c as DistroId;
  }
  return 'unknown';
}

function detectPackageManagers(distro: DistroId): PackageManager[] {
  const out: PackageManager[] = [];

  // User-scope managers first. brew on Linux works the same as on macOS.
  if (which('brew')) out.push('brew');
  if (which('conda') || which('mamba')) out.push('conda');

  // System managers — order by distro preference, but only include if the binary is present.
  if (process.platform === 'linux') {
    const tryAdd = (bin: string, pm: PackageManager) => {
      if (which(bin)) out.push(pm);
    };
    switch (distro) {
      case 'debian':
      case 'ubuntu':
        tryAdd('apt-get', 'apt');
        break;
      case 'fedora':
      case 'rhel':
      case 'centos':
      case 'rocky':
      case 'almalinux':
        tryAdd('dnf', 'dnf');
        if (!out.includes('dnf')) tryAdd('yum', 'yum');
        break;
      case 'arch':
      case 'manjaro':
        tryAdd('pacman', 'pacman');
        break;
      case 'alpine':
        tryAdd('apk', 'apk');
        break;
      case 'opensuse':
      case 'opensuse-leap':
      case 'opensuse-tumbleweed':
        tryAdd('zypper', 'zypper');
        break;
      default:
        // Unknown distro — try generic probes so we still pick something up.
        for (const [bin, pm] of [
          ['apt-get', 'apt'], ['dnf', 'dnf'], ['yum', 'yum'],
          ['pacman', 'pacman'], ['apk', 'apk'], ['zypper', 'zypper'],
        ] as const) {
          if (which(bin)) out.push(pm);
        }
    }
  }

  if (out.length === 0) out.push('unknown');
  return out;
}

function detectPasswordlessSudo(): boolean {
  if (process.getuid && process.getuid() === 0) return true; // already root
  if (!which('sudo')) return false;
  try {
    execSync('sudo -n true', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

export function detectPlatform(): PlatformInfo {
  const os = process.platform === 'darwin' ? 'darwin'
    : process.platform === 'linux' ? 'linux' : 'other';
  const distro = detectDistro();
  return {
    os,
    distro,
    packageManagers: detectPackageManagers(distro),
    isRoot: !!(process.getuid && process.getuid() === 0),
    hasTty: !!(process.stdin.isTTY && process.stdout.isTTY),
    passwordlessSudo: detectPasswordlessSudo(),
  };
}
