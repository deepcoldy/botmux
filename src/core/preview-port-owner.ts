/**
 * P1-12：Preview 端口的「持有者归属证明」。
 *
 * 背景：`botmux preview <port>` 过去只做一次 TCP connect 就把 (host, port) 存成
 * 会话的 previewTarget。connect 成功只证明**此刻有人在监听这个号码**，不证明
 * 监听者是本会话的进程：
 *   - agent 可以注册 Docker API、本机数据库、别的项目的 dev server、甚至宿主的
 *     管理口，Dashboard 登录用户随后被同源代理进去；
 *   - 自己的 dev server 退出后端口号被内核回收，下一个抢到它的**任意**本机进程
 *     就继承了这条已经登记的预览路由。
 *
 * 所以注册时必须留下可复核的「谁在持有」证据，并且在 probe 与每次代理落地前重新
 * 核对。这里给出的证据是：
 *
 *   inode  — 监听 socket 在内核里的唯一编号。socket 关闭即释放，新监听者一定拿到
 *            新的 inode，所以 inode 不变 ⇔ 还是当初那一个 listen socket。
 *   pid    — 持有该 inode 的进程。
 *   procStart — 该进程的 `starttime`（/proc/<pid>/stat 第 22 字段），用来抵御 pid
 *            复用：pid 相同但 starttime 变了就是另一个进程。
 *
 * 归属（而不仅仅是「稳定」）由血缘判定：持有者必须落在本会话的进程血缘里——从
 * worker fork 的 pid、worker 通过私有 IPC 上报的 CLI pid（tmux/zellij 这类后端 CLI
 * 不是 worker 的子进程，必须单独作根）出发向下遍历 ppid 树。不在血缘里 → 拒绝注册，
 * 宁可没有预览，也不把登录用户代理进一个来路不明的本机服务。
 *
 * 依赖与边界（务必读）：
 *   - **只在 Linux procfs 上成立**。/proc/net/tcp{,6} 给 inode，/proc/<pid>/fd 给
 *     持有者，/proc/<pid>/stat 给 ppid + starttime。daemon 实跑在 Linux；其它平台
 *     拿不到等价的强证明，`resolvePreviewPortOwner` 直接返回 platform_unsupported，
 *     调用方 fail closed（注册失败、不显示预览），而不是降级成「connect 通过就信」。
 *   - **同一 network namespace**。/proc/net/tcp 是 netns 局部的；daemon、dashboard
 *     与被预览的 dev server 都在同一 netns 才有意义（预览本来就只代理 loopback，
 *     跨 netns 本就不可达）。
 *   - **注册与复核的权限要求不同**。注册要扫 /proc/<pid>/fd，需要与目标进程同 uid
 *     （daemon 扫自己的子孙进程，天然满足）；复核只读 /proc/net/tcp{,6} 与
 *     /proc/<pid>/stat，这两者对全体用户可读，所以 dashboard 进程即便与 daemon 不同
 *     用户也能在每次代理前复核。
 */

import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_PROC_ROOT = '/proc';

/** TCP state code for LISTEN in /proc/net/tcp{,6}. */
const TCP_LISTEN_STATE = '0A';

/** 持有证明。随 previewTarget 一起持久化，因此必须是纯 JSON 且可再校验。 */
export interface PreviewPortOwnerProof {
  /** 持有监听 socket 的进程 pid。 */
  pid: number;
  /** /proc/<pid>/stat 的 starttime 字段，抵御 pid 复用。 */
  procStart: string;
  /** 监听 socket 的内核 inode（十进制字符串）。 */
  inode: string;
}

export type PreviewPortOwnerFailure =
  /** 非 Linux：拿不到等价强证明，调用方必须 fail closed。 */
  | 'platform_unsupported'
  /** procfs 读不到（容器裁剪 /proc、权限、netns 不同）。 */
  | 'proc_unreadable'
  /** 这个 host:port 上根本没有 LISTEN socket。 */
  | 'no_listener'
  /** 同等匹配度下有多个监听 socket（SO_REUSEPORT），无法确定代理会落到哪一个。 */
  | 'ambiguous_listener'
  /** 有人在监听，但持有者不在本会话的进程血缘里（或读不到其 fd）。 */
  | 'owner_unknown';

export type PreviewPortOwnerResolution =
  | { ok: true; proof: PreviewPortOwnerProof }
  | { ok: false; reason: PreviewPortOwnerFailure };

/**
 * 复核结论。`changed` 与 `unverifiable` 都必须按失效处理——区分它们只为把原因写
 * 进日志/错误码，不是为了给任何一种放行。
 */
export type PreviewPortOwnerVerdict = 'ok' | 'changed' | 'unverifiable';

export function safePreviewPortOwnerProof(value: unknown): PreviewPortOwnerProof | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 1) return undefined;
  if (typeof raw.procStart !== 'string' || !/^\d{1,20}$/.test(raw.procStart)) return undefined;
  if (typeof raw.inode !== 'string' || !/^\d{1,20}$/.test(raw.inode)) return undefined;
  return { pid: raw.pid as number, procStart: raw.procStart, inode: raw.inode };
}

interface ListenSocket {
  /** 归一化后的本地监听地址，见 decodeLocalAddress。 */
  address: string;
  port: number;
  inode: string;
}

/** 4 字节小端 hex → 点分十进制。 */
function decodeIpv4Word(hex: string): string {
  const bytes = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)];
  return bytes.map(byte => parseInt(byte, 16)).join('.');
}

/**
 * 归一化 /proc/net/tcp{,6} 的 local_address。只需要「可比较」而非通用 v6 规范化：
 * 预览目标只可能是字面 loopback，因此只识别 v4、v4-mapped、`::`、`::1`，其余原样
 * 返回小写 hex（永远匹配不上，等价于 fail closed）。
 */
function decodeLocalAddress(hex: string): string {
  if (hex.length === 8) return decodeIpv4Word(hex);
  if (hex.length !== 32) return hex.toLowerCase();
  const words = [hex.slice(0, 8), hex.slice(8, 16), hex.slice(16, 24), hex.slice(24, 32)];
  const bytes: number[] = [];
  for (const word of words) {
    // 每个 32bit word 内部是小端序，word 之间是网络序。
    for (let i = 3; i >= 0; i--) bytes.push(parseInt(word.slice(i * 2, i * 2 + 2), 16));
  }
  if (bytes.every(byte => byte === 0)) return '::';
  if (bytes.slice(0, 15).every(byte => byte === 0) && bytes[15] === 1) return '::1';
  const v4Mapped = bytes.slice(0, 10).every(byte => byte === 0)
    && bytes[10] === 0xff && bytes[11] === 0xff;
  if (v4Mapped) return `::ffff:${bytes.slice(12).join('.')}`;
  return hex.toLowerCase();
}

function parseListenTable(text: string, ipv6: boolean): ListenSocket[] {
  const out: ListenSocket[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    // sl local rem st tx:rx tr:when retrnsmt uid timeout inode …
    if (fields.length < 10 || fields[3] !== TCP_LISTEN_STATE) continue;
    const [addrHex, portHex] = fields[1].split(':');
    if (!addrHex || !portHex) continue;
    if (addrHex.length !== (ipv6 ? 32 : 8)) continue;
    const port = parseInt(portHex, 16);
    if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) continue;
    if (!/^\d+$/.test(fields[9])) continue;
    out.push({ address: decodeLocalAddress(addrHex), port, inode: fields[9] });
  }
  return out;
}

function readListenSockets(procRoot: string): ListenSocket[] | undefined {
  const tables: Array<[string, boolean]> = [['net/tcp', false], ['net/tcp6', true]];
  let read = false;
  const sockets: ListenSocket[] = [];
  for (const [relative, ipv6] of tables) {
    let text: string;
    try {
      text = readFileSync(join(procRoot, relative), 'utf8');
    } catch {
      // 纯 IPv4 内核没有 net/tcp6；只要有一张表读到就继续。
      continue;
    }
    read = true;
    sockets.push(...parseListenTable(text, ipv6));
  }
  return read ? sockets : undefined;
}

/**
 * 一个 loopback host 能被哪些本地监听地址服务，按「越具体越优先」分层。
 *
 * 分层不是形式主义：v4 精确绑定与 `0.0.0.0`/双栈 `::` 同时存在时，内核把
 * 127.0.0.1 的连接交给最具体的那一个，复核也必须盯住同一个 socket。
 */
function acceptableAddressTiers(host: string): string[][] {
  if (host === '::1') return [['::1'], ['::']];
  return [[host], ['0.0.0.0'], [`::ffff:${host}`, '::ffff:0.0.0.0'], ['::']];
}

function findListenInode(
  sockets: ListenSocket[],
  host: string,
  port: number,
): { ok: true; inode: string } | { ok: false; reason: 'no_listener' | 'ambiguous_listener' } {
  const onPort = sockets.filter(socket => socket.port === port);
  for (const tier of acceptableAddressTiers(host)) {
    const matches = onPort.filter(socket => tier.includes(socket.address));
    if (matches.length === 0) continue;
    const inodes = new Set(matches.map(match => match.inode));
    // SO_REUSEPORT 下同一地址可以有多个 listen socket，内核按 hash 分发；无法确定
    // 代理这一跳会落到谁身上，就不给出「归属证明」。
    if (inodes.size > 1) return { ok: false, reason: 'ambiguous_listener' };
    return { ok: true, inode: matches[0].inode };
  }
  return { ok: false, reason: 'no_listener' };
}

interface ProcStat {
  ppid: number;
  startTime: string;
}

/**
 * 读 /proc/<pid>/stat 的 ppid 与 starttime。comm 字段可以含空格与右括号，所以按
 * **最后一个** `)` 切分——与 utils/process-identity.ts 的口径一致。
 */
function readProcStat(procRoot: string, pid: number): ProcStat | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(procRoot, String(pid), 'stat'), 'utf8');
  } catch {
    return undefined;
  }
  const closeParen = raw.lastIndexOf(')');
  if (closeParen < 0) return undefined;
  const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
  const ppid = Number(fields[1]);
  const startTime = fields[19];
  if (!Number.isSafeInteger(ppid) || ppid < 0) return undefined;
  if (typeof startTime !== 'string' || !/^\d+$/.test(startTime)) return undefined;
  return { ppid, startTime };
}

function listProcPids(procRoot: string): number[] | undefined {
  let entries: string[];
  try {
    entries = readdirSync(procRoot);
  } catch {
    return undefined;
  }
  const pids: number[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const pid = Number(entry);
    if (Number.isSafeInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

/**
 * 会话血缘：从给定的根 pid 出发，收集所有仍然活着的子孙进程。
 *
 * 用一次 /proc 全量 ppid 扫描建反向索引，而不是逐层 fork `pgrep`：注册是低频动作，
 * 一次几百个 stat 读远比拉子进程便宜，也不引入外部命令依赖。
 *
 * 被 daemon 化（setsid / 双 fork）而被 init 收养的 dev server 会脱离血缘——那正是
 * 这里要拒绝的一类：它已经不能证明自己属于本会话。
 */
export function collectSessionLineagePids(procRoot: string, roots: number[]): Set<number> | undefined {
  const seeds = roots.filter(pid => Number.isSafeInteger(pid) && pid > 1);
  if (seeds.length === 0) return new Set();
  const pids = listProcPids(procRoot);
  if (!pids) return undefined;
  const children = new Map<number, number[]>();
  for (const pid of pids) {
    const stat = readProcStat(procRoot, pid);
    if (!stat) continue;
    const siblings = children.get(stat.ppid);
    if (siblings) siblings.push(pid);
    else children.set(stat.ppid, [pid]);
  }
  const lineage = new Set<number>();
  const queue = [...seeds];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (lineage.has(pid)) continue;
    lineage.add(pid);
    for (const child of children.get(pid) ?? []) {
      if (!lineage.has(child)) queue.push(child);
    }
  }
  return lineage;
}

/** 在候选 pid 集合里找出持有该 socket inode 的进程。 */
function findSocketHolder(procRoot: string, candidates: Iterable<number>, inode: string): number | undefined {
  const needle = `socket:[${inode}]`;
  for (const pid of candidates) {
    let fds: string[];
    try {
      fds = readdirSync(join(procRoot, String(pid), 'fd'));
    } catch {
      // 进程刚退出、或与本进程不同 uid：读不到就不能算它持有。
      continue;
    }
    for (const fd of fds) {
      let link: string;
      try {
        link = readlinkSync(join(procRoot, String(pid), 'fd', fd));
      } catch {
        continue;
      }
      if (link === needle) return pid;
    }
  }
  return undefined;
}

function procfsAvailable(procRoot: string): boolean {
  // 只有 Linux 才有本模块依赖的 procfs 语义；测试用假 procRoot 时显式跳过平台判断
  // （目录内容自证），生产路径永远是 '/proc'。
  return procRoot !== DEFAULT_PROC_ROOT || process.platform === 'linux';
}

/**
 * 注册时求取持有证明。必须在 daemon 进程内调用（需要读会话子孙进程的 fd）。
 */
export function resolvePreviewPortOwner(input: {
  host: string;
  port: number;
  /** 会话血缘的根 pid：worker fork pid、worker 上报的 CLI pid、adopt 的 CLI pid 等。 */
  ownerPids: Array<number | undefined>;
  procRoot?: string;
}): PreviewPortOwnerResolution {
  const procRoot = input.procRoot ?? DEFAULT_PROC_ROOT;
  if (!procfsAvailable(procRoot)) return { ok: false, reason: 'platform_unsupported' };
  const sockets = readListenSockets(procRoot);
  if (!sockets) return { ok: false, reason: 'proc_unreadable' };
  const listener = findListenInode(sockets, input.host, input.port);
  if (!listener.ok) return { ok: false, reason: listener.reason };
  const lineage = collectSessionLineagePids(procRoot, input.ownerPids.filter(
    (pid): pid is number => typeof pid === 'number',
  ));
  if (!lineage) return { ok: false, reason: 'proc_unreadable' };
  if (lineage.size === 0) return { ok: false, reason: 'owner_unknown' };
  const pid = findSocketHolder(procRoot, lineage, listener.inode);
  if (pid === undefined) return { ok: false, reason: 'owner_unknown' };
  const stat = readProcStat(procRoot, pid);
  if (!stat) return { ok: false, reason: 'owner_unknown' };
  return { ok: true, proof: { pid, procStart: stat.startTime, inode: listener.inode } };
}

/**
 * 复核持有证明。probe 之后与**每次代理落地之前**都要跑一遍。
 *
 * 只读全体可读的 /proc/net/tcp{,6} 与 /proc/<pid>/stat：dashboard 进程即使与 daemon
 * 不同用户也能复核。成本是每跳一次 procfs 表读取（page cache 命中，无系统调用之外的
 * I/O）；这里不做结果缓存——缓存窗口就是「端口已经易主但仍在代理」的窗口。判定 `ok`
 * 需要同时满足：
 *   1. 该 host:port 现在的监听 socket 还是当初那个 inode（socket 没被关过）；
 *   2. 当初那个 pid 还活着，且 starttime 未变（不是 pid 复用后的另一个进程）。
 */
export function verifyPreviewPortOwner(input: {
  host: string;
  port: number;
  proof: PreviewPortOwnerProof;
  procRoot?: string;
}): PreviewPortOwnerVerdict {
  const procRoot = input.procRoot ?? DEFAULT_PROC_ROOT;
  if (!procfsAvailable(procRoot)) return 'unverifiable';
  const sockets = readListenSockets(procRoot);
  if (!sockets) return 'unverifiable';
  const listener = findListenInode(sockets, input.host, input.port);
  if (!listener.ok) return 'changed';
  if (listener.inode !== input.proof.inode) return 'changed';
  const stat = readProcStat(procRoot, input.proof.pid);
  if (!stat) return 'changed';
  return stat.startTime === input.proof.procStart ? 'ok' : 'changed';
}
