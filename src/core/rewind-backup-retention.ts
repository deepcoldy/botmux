/**
 * 截断会话记录前留下的回退备份：命名、位置与保留策略（#3572）。
 *
 * 两处截断 Claude Code 会话记录（transcript）前都会先留一份备份：
 *  - `/rewind` 确认回退：整份会话记录，`<transcript>.rewind-<stamp>.bak`；
 *  - 失败回合回退（failed-turn-rewind.ts）：只留剪掉的那段，
 *    `<transcript>.rewind-<stamp>.removed.bak`。
 * 备份放在会话记录旁边；会话记录在 CLI 可写的树里时（沙盒），改放 daemon 数据目录的
 * `rewind-backups/<sessionId>/`（#3560）。
 *
 * 程序从不读回这些文件：撤销一次剪切用的是剪切时留在内存里的字节
 * （context-rewind.ts restoreRewoundTranscript），备份只供人手动恢复。所以按「人还可能
 * 用得上」来留，两处、两类共用一个策略（{@link REWIND_BACKUP_RETENTION}）：
 *  - 1 小时内的一律不删：回退还在进行、刚做完还没确认的窗口里不碰；
 *  - 超过 7 天的删；
 *  - 同一份会话记录的同一类备份只留最新 10 份，更旧的提前删（仍受 1 小时下限保护）——
 *    模型服务长时间故障时失败回合会反复回退，这一条让份数不随故障时长增长。
 *  时间比现在还晚 1 小时以上的（写它时时钟走快了）不占份数名额、也不按时间删，等真实时间
 *  追上它再说。
 *
 * 什么时候清：一次回退结算之后清它的备份所在目录（{@link pruneRewindBackupsBeside}）；
 * daemon 的周期清扫（session-runtime-sweep.ts）清数据目录下每个会话的备份目录，以及登记过的
 * 会话记录旁边的目录（{@link registerRewindBackup}）——之后再也不回退的会话也清得到。
 *
 * 只认本模块生成的文件名（{@link rewindBackupSuffix} 的逆）、只认直接位于该目录下的
 * 普通文件：符号链接、子目录、名字对不上的一律不动；不下钻，不跟随链接。目录先以
 * O_DIRECTORY|O_NOFOLLOW 打开钉住，Linux 上之后每一步都经 /proc/self/fd 落在这个打开的目录
 * 里，路径中途被换成链接也走不出去；没有 /proc 时（macOS）每删一个前核对路径仍是钉住的那个
 * 目录——核对与删除之间仍有一个极短的窗口，要换掉这个目录得先能写它的上级目录。
 */
import { createHash } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { lstat, open, readdir, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { atomicWriteFileSync, isAtomicWriteTempName } from '../utils/atomic-write.js';

export type RewindBackupKind = 'full' | 'removed';

export interface RewindBackupRetentionPolicy {
  /** 比这更新的备份任何规则都不删。 */
  minAgeMs: number;
  /** 比这更旧的备份删掉。 */
  maxAgeMs: number;
  /** 每份会话记录、每类备份保留最新的这么多份；更旧的过了 minAgeMs 就删。 */
  maxPerTranscript: number;
}

const HOUR_MS = 60 * 60_000;

export const REWIND_BACKUP_RETENTION: Readonly<RewindBackupRetentionPolicy> = Object.freeze({
  minAgeMs: HOUR_MS,
  maxAgeMs: 7 * 24 * HOUR_MS,
  maxPerTranscript: 10,
});

/** daemon 数据目录下放回退备份的目录名。 */
export const REWIND_BACKUP_DIRNAME = 'rewind-backups';
/** daemon 数据目录下登记「会话记录旁边放过备份的目录」的目录名。 */
export const REWIND_BACKUP_PLACES_DIRNAME = 'rewind-backup-places';

/** 会话记录在 CLI 可写的树里时，这个会话的回退备份放这里。 */
export function rewindBackupDirForSession(dataDir: string, sessionId: string): string {
  return join(dataDir, REWIND_BACKUP_DIRNAME, sessionId);
}

function stampOf(now: number): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

/** 接在会话记录文件名后面的备份后缀：`.rewind-<stamp>[.removed].bak`。 */
export function rewindBackupSuffix(now: number, kind: RewindBackupKind): string {
  return `.rewind-${stampOf(now)}${kind === 'removed' ? '.removed' : ''}.bak`;
}

const BACKUP_NAME_RE = /^(.+\.jsonl)\.rewind-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)(\.removed)?\.bak$/;

export interface RewindBackupName {
  /** 被备份的会话记录的文件名。 */
  transcript: string;
  /** 名字里记的创建时间（毫秒）。 */
  createdAt: number;
  kind: RewindBackupKind;
}

/** {@link rewindBackupSuffix} 的逆：名字不是本功能生成的就返回 undefined。 */
export function parseRewindBackupName(name: string): RewindBackupName | undefined {
  const match = BACKUP_NAME_RE.exec(name);
  if (!match) return undefined;
  const [, transcript, stamp, removed] = match as unknown as [string, string, string, string | undefined];
  const createdAt = Date.parse(
    `${stamp.slice(0, 13)}:${stamp.slice(14, 16)}:${stamp.slice(17, 19)}.${stamp.slice(20, 23)}Z`,
  );
  // 写出来再比一次：拒掉 13 月、2 月 30 日这类正则放过、Date.parse 却会挪动的时间。
  if (!Number.isFinite(createdAt) || stampOf(createdAt) !== stamp) return undefined;
  return { transcript, createdAt, kind: removed ? 'removed' : 'full' };
}

export interface RewindBackupPruneOptions {
  now?: number;
  /** 刚写下的那份备份的文件名：无论规则怎么说都不删。 */
  keep?: string;
  policy?: RewindBackupRetentionPolicy;
  /** Test seam: runs once after the directory was listed, before anything is removed. */
  beforeRemove?: () => void | Promise<void>;
  /** Test seam: pin directories as where /proc is missing (path re-checks). */
  withoutProc?: boolean;
  /** Test seam: runs right after a place's registration was withdrawn. */
  afterUnregister?: () => void | Promise<void>;
}

interface PinnedDir {
  /** Path every lookup goes through: the opened directory itself where /proc allows. */
  base: string;
  /** The path still names the opened directory (always true through /proc). */
  stillThere(): Promise<boolean>;
  mtimeMs: number;
}

/** 以 O_DIRECTORY|O_NOFOLLOW 打开 `path`（最后一段是链接、不是目录、不存在：undefined），
 *  在 `use` 返回前一直持有。`path` 可以是经另一个钉住的目录的路径。 */
async function withPinnedDir<T>(
  path: string,
  use: (dir: PinnedDir) => Promise<T>,
  opts: { withoutProc?: boolean } = {},
): Promise<T | undefined> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const pinned = await handle.stat();
    if (!pinned.isDirectory()) return undefined;
    const same = (st: { dev: number; ino: number } | undefined) => !!st && st.dev === pinned.dev && st.ino === pinned.ino;
    const viaFd = `/proc/self/fd/${handle.fd}`;
    const pinnedByFd = !opts.withoutProc && same(await stat(viaFd).catch(() => undefined));
    return await use({
      base: pinnedByFd ? viaFd : path,
      stillThere: async () => pinnedByFd || same(await lstat(path).catch(() => undefined)),
      mtimeMs: pinned.mtimeMs,
    });
  } finally {
    await handle.close();
  }
}

interface DirPrune {
  removed: string[];
  /** 本功能的备份在清理后还剩几份。 */
  left: number;
  /** 目录在清理前的 mtime。 */
  mtimeMs: number;
}

/** `path` 是实际打开用的路径，`shown` 是报告里用的路径（两者相同，除非经钉住的上级目录）。 */
async function pruneDir(path: string, shown: string, opts: RewindBackupPruneOptions): Promise<DirPrune | undefined> {
  const policy = opts.policy ?? REWIND_BACKUP_RETENTION;
  const now = opts.now ?? Date.now();
  return withPinnedDir(path, async dir => {
    const groups = new Map<string, { name: string; at: number }[]>();
    let found = 0;
    for (const name of await readdir(dir.base)) {
      const parsed = parseRewindBackupName(name);
      if (!parsed) continue;
      const st = await lstat(join(dir.base, name)).catch(() => undefined);
      if (!st?.isFile()) continue;
      found += 1;
      // 时间取名字里记的和 mtime 中较新的：有人改过它，就按改过之后算。
      const at = Math.max(parsed.createdAt, st.mtimeMs);
      // 时钟走快时写下的：不知道它真实的年龄，不占名额、不删。
      if (at > now + policy.minAgeMs) continue;
      const key = `${parsed.kind}\0${parsed.transcript}`;
      const group = groups.get(key) ?? [];
      group.push({ name, at });
      groups.set(key, group);
    }
    const doomed: string[] = [];
    for (const group of groups.values()) {
      // 新的在前；同一时刻按名字倒序，结果与目录顺序无关。
      group.sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
      for (const [rank, backup] of group.entries()) {
        const age = now - backup.at;
        if (backup.name === opts.keep || age < policy.minAgeMs) continue;
        if (age < policy.maxAgeMs && rank < policy.maxPerTranscript) continue;
        doomed.push(backup.name);
      }
    }
    await opts.beforeRemove?.();
    const removed: string[] = [];
    for (const name of doomed) {
      // 目录被挪走、换成链接：不在别处删。
      if (!(await dir.stillThere())) break;
      try {
        await unlink(join(dir.base, name));
        removed.push(join(shown, name));
      } catch {
        /* 已被别人删掉或删不掉：留给下一轮 */
      }
    }
    return { removed, left: found - removed.length, mtimeMs: dir.mtimeMs };
  }, opts);
}

/** 目录里本功能的备份有几份（打不开：undefined）。 */
async function countBackups(path: string, opts: RewindBackupPruneOptions): Promise<number | undefined> {
  return withPinnedDir(path, async dir => {
    let found = 0;
    for (const name of await readdir(dir.base)) {
      if (!parseRewindBackupName(name)) continue;
      if ((await lstat(join(dir.base, name)).catch(() => undefined))?.isFile()) found += 1;
    }
    return found;
  }, opts);
}

/**
 * 按 {@link REWIND_BACKUP_RETENTION} 清理一个目录里的回退备份，返回删掉的路径。只看 `dir`
 * 自己（是链接就整个不动）的直接子项；单个文件删不掉就跳过，下一轮再说。
 *
 * lstat 与 unlink 之间名字被换成链接，unlink 删的也只是链接本身、碰不到它指向的文件；
 * 会话 CLI 写得到的树里本来就不放备份（见 context-rewind.ts 的 backupDir）。
 */
export async function pruneRewindBackupDir(dir: string, opts: RewindBackupPruneOptions = {}): Promise<string[]> {
  return (await pruneDir(dir, dir, opts))?.removed ?? [];
}

function placeName(dir: string): string {
  return createHash('sha256').update(dir).digest('hex');
}

function isInside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 一次剪切写下 `backupPath` 之后：备份不在数据目录自己的备份目录里（即在会话记录旁边），
 * 就把它所在的目录登记到 `<dataDir>/rewind-backup-places/`，让周期清扫找得到它——即使这个
 * 目录之后再也没有回退。重复登记只刷新登记的时间。不抛错，失败写进 `log`。
 */
export function registerRewindBackup(backupPath: string, dataDir: string | undefined, log?: (message: string) => void): void {
  if (!dataDir) return;
  const dir = resolve(dirname(backupPath));
  if (isInside(dir, resolve(dataDir, REWIND_BACKUP_DIRNAME))) return;
  try {
    registerPlace(dataDir, dir);
  } catch (err) {
    log?.(`Registering rewind backups in ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function registerPlace(dataDir: string, dir: string): void {
  const places = join(dataDir, REWIND_BACKUP_PLACES_DIRNAME);
  mkdirSync(places, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(join(places, placeName(dir)), dir, { mode: 0o600, followTargetSymlink: false });
}

/** 数据目录下每个会话的备份目录。清空了、且 7 天没有变化的会话目录删掉（rmdir，不递归）。 */
async function sweepSessionDirs(dataDir: string, opts: RewindBackupPruneOptions): Promise<string[]> {
  const policy = opts.policy ?? REWIND_BACKUP_RETENTION;
  const now = opts.now ?? Date.now();
  const root = join(dataDir, REWIND_BACKUP_DIRNAME);
  return (await withPinnedDir(root, async pinned => {
    const removed: string[] = [];
    for (const name of await readdir(pinned.base)) {
      try {
        const pruned = await pruneDir(join(pinned.base, name), join(root, name), { ...opts, keep: undefined });
        if (!pruned) continue;
        removed.push(...pruned.removed);
        // 与正在「mkdir → 写备份」的回退撞上也无妨：写备份时目录不在会重建它（context-rewind.ts）。
        if (pruned.removed.length === 0 && pruned.left === 0 && now - pruned.mtimeMs >= policy.maxAgeMs
          && await pinned.stillThere()) {
          await rmdir(join(pinned.base, name)).catch(() => { /* 不空，或刚被用上 */ });
        }
      } catch {
        /* 一个会话的目录读不了，不耽误其余的 */
      }
    }
    return removed;
  }, opts)) ?? [];
}

/** 登记过的会话记录旁边的目录。目录没了（或不再是目录），或者里面不再有备份、1 小时内也没人
 *  再登记它，就撤掉登记；撤掉之后再看一眼，这期间有剪切写下了备份就重新登记（剪切总是先写
 *  备份、后登记，所以这样不会漏）。登记文件名对不上内容的不认、不动；写到一半留下的临时文件
 *  过了 1 小时删掉。 */
async function sweepPlaces(dataDir: string, opts: RewindBackupPruneOptions): Promise<string[]> {
  const policy = opts.policy ?? REWIND_BACKUP_RETENTION;
  const now = opts.now ?? Date.now();
  return (await withPinnedDir(join(dataDir, REWIND_BACKUP_PLACES_DIRNAME), async places => {
    const removed: string[] = [];
    const markerAge = async (marker: string) => {
      const st = await lstat(marker).catch(() => undefined);
      return st?.isFile() ? now - st.mtimeMs : undefined;
    };
    for (const name of await readdir(places.base)) {
      if (/^[0-9a-f]{64}\./.test(name) && isAtomicWriteTempName(name)) {
        const age = await markerAge(join(places.base, name));
        if (age !== undefined && age >= policy.minAgeMs) await unlink(join(places.base, name)).catch(() => {});
        continue;
      }
      if (!/^[0-9a-f]{64}$/.test(name)) continue;
      const marker = join(places.base, name);
      try {
        if ((await markerAge(marker)) === undefined) continue;
        const dir = await readFile(marker, 'utf8');
        if (!isAbsolute(dir) || placeName(dir) !== name) continue;
        const pruned = await pruneDir(dir, dir, { ...opts, keep: undefined });
        if (pruned) removed.push(...pruned.removed);
        const gone = !pruned && !(await lstat(dir).catch(() => undefined))?.isDirectory();
        const empty = pruned?.left === 0 && ((await markerAge(marker)) ?? 0) >= policy.minAgeMs;
        if (!(gone || empty) || !(await places.stillThere())) continue;
        try {
          await unlink(marker);
        } catch {
          continue;
        }
        await opts.afterUnregister?.();
        if (!gone && ((await countBackups(dir, opts)) ?? 0) > 0) registerPlace(dataDir, dir);
      } catch {
        /* 一处读不了，不耽误其余的 */
      }
    }
    return removed;
  }, opts)) ?? [];
}

/** daemon 周期清扫：数据目录下每个会话的备份目录，加上登记过的会话记录旁边的目录。 */
export async function sweepRewindBackups(dataDir: string, opts: Omit<RewindBackupPruneOptions, 'keep'> = {}): Promise<string[]> {
  return [...await sweepSessionDirs(dataDir, opts), ...await sweepPlaces(dataDir, opts)];
}

/**
 * 一次回退结算之后：登记（见 {@link registerRewindBackup}）并清理它的备份所在的目录，这份
 * 备份本身不动。不抛错，做了什么写进 `log`。调用方不 await——清理不挡回合。
 */
export async function pruneRewindBackupsBeside(
  backupPath: string,
  opts: { dataDir?: string; log?: (message: string) => void } = {},
): Promise<void> {
  const dir = dirname(backupPath);
  registerRewindBackup(backupPath, opts.dataDir, opts.log);
  try {
    const removed = await pruneRewindBackupDir(dir, { keep: basename(backupPath) });
    if (removed.length > 0) opts.log?.(`Removed ${removed.length} rewind backup(s) past retention in ${dir}`);
  } catch (err) {
    opts.log?.(`Pruning rewind backups in ${dir} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
