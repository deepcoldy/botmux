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
 */
import {
  containmentHandleKey,
  containmentHandles,
  containmentSessionIds,
  revokeContainmentHandles,
  type ContainmentHandle,
} from './mojo-containment.js';

const USAGE = `用法:
  botmux mojo-containment list
      列出 containment 账本中仍未证明静止的会话与 handle。

  botmux mojo-containment revoke <sessionId> [--handle <key>] --yes
      操作员显式撤销：不经静止证明直接丢弃该会话的 handle（默认全部，
      --handle 只撤销指定 key）。撤销后对应的设备隔离 blocker 立即消失，
      若该 turn 子树仍有存活进程，将不再被追踪 —— 请先人工确认后再执行。
      必须携带 --yes。`;

function describeHandle(h: ContainmentHandle): string {
  const key = containmentHandleKey(h);
  if (h.kind === 'cgroup') return `${key}  (强 handle：内核 cgroup)`;
  if (h.kind === 'unprovable') return `${key}  (不可证明：该平台无法枚举子树)`;
  return `${key}  (弱 handle：root pid ${h.rootPid}, generation ${h.generation ?? '?'})`;
}

export function runMojoContainmentCommand(
  argv: string[],
  deps: {
    dataDir?: string;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): number {
  const out = deps.stdout ?? ((line: string) => { console.log(line); });
  const err = deps.stderr ?? ((line: string) => { console.error(line); });
  const [sub, ...rest] = argv;

  if (sub === 'list') {
    const ids = containmentSessionIds(deps.dataDir);
    if (ids.length === 0) {
      out('containment 账本为空：没有未证明静止的 mojo 子树。');
      return 0;
    }
    for (const id of ids) {
      out(`session ${id}`);
      for (const h of containmentHandles(id, deps.dataDir)) {
        out(`  ${describeHandle(h)}`);
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
    if (handleFlag >= 0 && !handleKey) {
      err('--handle 需要一个 handle key（见 `botmux mojo-containment list`）。');
      return 1;
    }
    if (!rest.includes('--yes')) {
      err('撤销会在没有静止证明的情况下丢弃 handle：若子树仍有进程存活，将不再被追踪。');
      err('确认后请追加 --yes 重新执行。');
      return 1;
    }
    const { removed, remaining } = revokeContainmentHandles(sessionId, {
      ...(handleKey ? { handleKey } : {}),
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    });
    if (removed.length === 0) {
      err(`session ${sessionId} 没有匹配的 containment handle，未做任何修改。`);
      return 1;
    }
    for (const h of removed) out(`已撤销: ${describeHandle(h)}`);
    if (remaining.length > 0) {
      out(`session ${sessionId} 仍保留 ${remaining.length} 个 handle。`);
    } else {
      out(`session ${sessionId} 的 containment blocker 已全部清除。`);
    }
    return 0;
  }

  err(USAGE);
  return sub === undefined || sub === 'help' || sub === '--help' ? 0 : 1;
}
