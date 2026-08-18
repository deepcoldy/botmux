/**
 * `botmux mojo-containment ...` — the auditable operator exit for containment
 * blockers that are correct-but-permanent.
 *
 * WHY this exists: the containment ledger fails closed on purpose. A weak
 * (tree-identity) handle on a host without cgroup v2 can never produce a
 * boundary proof, and an `unprovable` handle never releases by design — so a
 * single mojo session run-and-closed on such a host leaves a durable handle
 * whose device-isolation blocker turns every credential activation into a
 * whole-machine `activation_blocked` 409, forever. That is not a transient
 * retry situation, and the only previous way out was hand-editing the ledger
 * JSON. This command makes the exit explicit, human-only and logged, instead
 * of undocumented file surgery.
 *
 * The runtime never revokes on its own: revokeContainmentHandles is called from
 * here and from nowhere else.
 *
 * SAFETY GATE (P1-c): revoking is the one manual act that can turn into a
 * credential leak — dropping the handle of a subtree that is STILL ALIVE stops
 * tracking a process that still holds the injected credential. The command
 * therefore machine-checks what it can before revoking and default-REJECTS:
 *   - a weak handle whose recorded rootPid is still the ORIGINAL process
 *     (boot id + starttime verify — the same primitive the runtime kill gate
 *     uses), and
 *   - a session row that is still `active`.
 * `--force` overrides both, and the override is written into the audit line so
 * forensics can tell a routine cleanup from an operator overruling live
 * evidence.
 */
import {
  MojoContainmentUnavailableError,
  containmentHandleKey,
  cgroupHandleLiveMembers,
  containmentHandles,
  containmentSessionIds,
  killPreparedBoundary,
  readBootId,
  revokeContainmentHandles,
  weakHandleRootStillOriginal,
  type ContainmentHandle,
  type StrongContainmentHandle,
} from './mojo-containment.js';

const USAGE = `用法:
  botmux mojo-containment list
      列出 containment 账本中仍未证明静止的会话与 handle（弱 handle 会标注
      记录的 root 进程当前是否仍存活）。

  botmux mojo-containment revoke <sessionId> [--handle <key>] --yes [--force]
      操作员显式撤销：不经静止证明直接丢弃该会话的 handle（默认全部，
      --handle 只撤销指定 key）。撤销后对应的设备隔离 blocker 立即消失，
      若该 turn 子树仍有存活进程，将不再被追踪。必须携带 --yes。
      安全闸（默认拒绝，--force 可越过，越过会写入审计日志）：
        · 弱 handle 记录的 root 进程仍是原进程且存活；
        · 会话行仍处于 active。`;

/**
 * "Is this session row still active" — a STRICT cross-process read of every
 * session file, from the CLI process.
 *
 * Tri-state on purpose (gate-5 review): the store's lenient readers swallow a
 * parse failure into "no row", which this gate would read as proven-inactive —
 * silently passing on exactly the corrupted-state day an operator reaches for
 * this command. Here an unreadable file yields `undefined` ("evidence
 * unavailable"), which does NOT block the revoke but IS surfaced to the
 * operator; only a definite `status === 'active'` blocks.
 */
export async function defaultIsSessionActive(sessionId: string): Promise<boolean | undefined> {
  try {
    const [{ config }, { readdirSync, readFileSync }, { join }] = await Promise.all([
      import('../config.js'),
      import('node:fs'),
      import('node:path'),
    ]);
    const dir = config.session.dataDir;
    let sawUnreadable = false;
    for (const file of readdirSync(dir)) {
      if (!/^sessions(-[^.]+)?\.json$/.test(file)) continue;
      try {
        const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as
          Record<string, { status?: string } | undefined>;
        const row = data[sessionId];
        if (row) return row.status === 'active';
      } catch {
        // A corrupt file may be the very one hiding this row: unknown, never
        // "proven inactive".
        sawUnreadable = true;
      }
    }
    return sawUnreadable ? undefined : false;
  } catch {
    return undefined;
  }
}

function describeHandle(h: ContainmentHandle, liveNote?: string): string {
  const key = containmentHandleKey(h);
  if (h.kind === 'cgroup') return `${key}  (强 handle：内核 cgroup)`;
  if (h.kind === 'unprovable') return `${key}  (不可证明：该平台无法枚举子树)`;
  return `${key}  (弱 handle：root pid ${h.rootPid}, generation ${h.generation ?? '?'}`
    + `${liveNote ? `, ${liveNote}` : ''})`;
}

export async function runMojoContainmentCommand(
  argv: string[],
  deps: {
    dataDir?: string;
    procRoot?: string;
    isSessionActive?: (sessionId: string) => Promise<boolean | undefined> | boolean | undefined;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const out = deps.stdout ?? ((line: string) => { console.log(line); });
  const err = deps.stderr ?? ((line: string) => { console.error(line); });
  const [sub, ...rest] = argv;
  const rootStillLive = (h: ContainmentHandle): boolean =>
    h.kind === 'tree-identity'
    && weakHandleRootStillOriginal(h, deps.procRoot ? { procRoot: deps.procRoot } : {});

  try {
    if (sub === 'list') {
      const ids = containmentSessionIds(deps.dataDir);
      if (ids.length === 0) {
        out('containment 账本为空：没有未证明静止的 mojo 子树。');
        return 0;
      }
      for (const id of ids) {
        out(`session ${id}`);
        for (const h of containmentHandles(id, deps.dataDir)) {
          out(`  ${describeHandle(h, h.kind === 'tree-identity'
            ? (rootStillLive(h) ? 'root 仍存活（原进程）' : 'root 已不在/已换代')
            : undefined)}`);
        }
      }
      out('');
      out('这些 handle 会保持设备隔离 blocker（activation_blocked）。确认对应子树');
      out('确实已不存在后，可用 `botmux mojo-containment revoke <sessionId> --yes` 显式撤销。');
      return 0;
    }

    if (sub === 'revoke') {
      const sessionId = rest[0];
      if (!sessionId || sessionId.startsWith('--')) {
        err(USAGE);
        return 1;
      }
      const handleFlag = rest.indexOf('--handle');
      const handleKey = handleFlag >= 0 ? rest[handleFlag + 1] : undefined;
      if (handleFlag >= 0 && (!handleKey || handleKey.startsWith('--'))) {
        err('--handle 需要一个 handle key（见 `botmux mojo-containment list`），不能是另一个开关。');
        return 1;
      }
      const known = new Set(['--handle', '--yes', '--force', handleKey].filter(Boolean));
      const unknown = rest.slice(1).filter(a => a.startsWith('--') && !known.has(a));
      if (unknown.length > 0) {
        err(`未知参数: ${unknown.join(' ')}`);
        err(USAGE);
        return 1;
      }
      // Reject stray positionals instead of silently dropping them: a typo'd
      // second sessionId must not quietly revoke only the first.
      const strays = rest.filter((a, i) => i > 0
        && !a.startsWith('--')
        && !(handleFlag >= 0 && i === handleFlag + 1));
      if (strays.length > 0) {
        err(`多余的参数: ${strays.join(' ')}（revoke 一次只处理一个 sessionId）`);
        err(USAGE);
        return 1;
      }
      if (!rest.includes('--yes')) {
        err('撤销会在没有静止证明的情况下丢弃 handle：若子树仍有进程存活，将不再被追踪。');
        err('确认后请追加 --yes 重新执行。');
        return 1;
      }
      const force = rest.includes('--force');

      // Machine checks BEFORE mutating anything (P1-c). Only PROVEN liveness
      // blocks; an unreadable probe stays non-blocking so a ledger-only host
      // can still clean up.
      const candidates = containmentHandles(sessionId, deps.dataDir)
        .filter(h => handleKey === undefined || containmentHandleKey(h) === handleKey);
      if (candidates.length === 0) {
        err(`session ${sessionId} 没有匹配的 containment handle，未做任何修改。`);
        return 1;
      }
      const liveBlockers: string[] = [];
      // Evidence-availability surfacing (gate-5 review): "only PROVEN liveness
      // blocks" must not silently degrade into "no check ran". When the probe
      // substrate itself is unreadable, say so — the operator decides with
      // open eyes instead of a gate that quietly became a no-op.
      if (candidates.some(h => h.kind === 'tree-identity')
          && readBootId(deps.procRoot ? { procRoot: deps.procRoot } : {}) === null) {
        err('⚠️ 无法读取 /proc 启动身份（hidepid / 非 Linux？）：弱 handle 的存活检测'
          + '不可用，不作为拦截依据——撤销前请自行确认子树已消亡。');
      }
      for (const h of candidates) {
        if (rootStillLive(h)) {
          liveBlockers.push(`${containmentHandleKey(h)}：记录的 root pid `
            + `${(h as { rootPid: number }).rootPid} 仍是原进程且存活`);
        }
        // A cgroup handle has no rootPid, so the tree-identity check above skips
        // it. Read its cgroup membership directly: revoking while a credentialed
        // process still runs in the cgroup drops the blocker over a live tree.
        if (h.kind === 'cgroup') {
          const members = cgroupHandleLiveMembers(h as StrongContainmentHandle,
            deps.procRoot ? { procRoot: deps.procRoot } : {});
          if (members.unreadable) {
            err(`⚠️ 无法读取 cgroup ${(h as StrongContainmentHandle).cgroupPath} 的成员：`
              + '强 handle 的存活检测不可用，不作为拦截依据——撤销前请自行确认子树已消亡。');
          } else if (members.live.length > 0) {
            liveBlockers.push(`${containmentHandleKey(h)}：cgroup 内仍有执行中的成员 `
              + `(${members.live.join(',')})`);
          }
        }
      }
      const active = await (deps.isSessionActive ?? defaultIsSessionActive)(sessionId);
      if (active === true) {
        liveBlockers.push(`session ${sessionId} 的会话行仍处于 active（先 /close 它）`);
      } else if (active === undefined) {
        err('⚠️ 会话库不可读：无法判定会话行是否 active，不作为拦截依据——'
          + '撤销前请自行确认会话已关闭。');
      }
      if (liveBlockers.length > 0 && !force) {
        err('拒绝撤销 —— 以下证据表明目标可能仍在运行（撤销即凭证泄漏面）：');
        for (const b of liveBlockers) err(`  · ${b}`);
        err('确认要放弃追踪这些存活对象，请追加 --force（该越过会写入审计日志）。');
        return 1;
      }

      const { removed, remaining } = revokeContainmentHandles(sessionId, {
        ...(handleKey ? { handleKey } : {}),
        ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
        ...(liveBlockers.length > 0
          ? { auditNote: `--force past LIVE evidence: ${liveBlockers.join('; ')}` }
          : {}),
      });
      if (removed.length === 0) {
        err(`session ${sessionId} 没有匹配的 containment handle，未做任何修改。`);
        return 1;
      }
      // cgroup.kill + reclaim the directory of every revoked cgroup handle — the
      // runtime never removes it now (a cgroup handle is never released by proof).
      // AWAITED and its result LOGGED, not fire-and-forget: an operator forcing
      // past live evidence must at least SIGKILL the tree, and a failure to prove
      // it empty must be visible rather than leaving a live tree behind a cleared
      // blocker.
      for (const h of removed) {
        if (h.kind !== 'cgroup') continue;
        const cg = h as StrongContainmentHandle;
        const emptied = await killPreparedBoundary({
          sessionId: cg.sessionId, generation: cg.generation,
          cgroupPath: cg.cgroupPath, nonce: cg.nonce,
        });
        if (emptied) out(`已回收 cgroup ${cg.cgroupPath}（已 SIGKILL 并证实清空）`);
        else err(`⚠️ cgroup ${cg.cgroupPath} 未能证实清空：可能仍有存活成员，blocker 已撤销，请人工核查该子树。`);
      }
      for (const h of removed) out(`已撤销: ${describeHandle(h)}`);
      if (liveBlockers.length > 0) {
        out(`⚠️ 本次为 --force 越过存活证据的撤销，已写入审计日志。`);
      }
      if (remaining.length > 0) {
        out(`session ${sessionId} 仍保留 ${remaining.length} 个 handle。`);
      } else {
        out(`session ${sessionId} 的 containment blocker 已全部清除。`);
      }
      return 0;
    }

    err(USAGE);
    return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 1;
  } catch (error) {
    // A corrupt/locked ledger is exactly the state an operator reaches for this
    // command in — surface it as a message, never a stack trace.
    if (error instanceof MojoContainmentUnavailableError) {
      err(`containment 账本不可用：${error.message}`);
    } else {
      err(`mojo-containment 命令失败：${error instanceof Error ? error.message : String(error)}`);
    }
    return 1;
  }
}
