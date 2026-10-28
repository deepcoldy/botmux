/**
 * Codex rollout 里 `type === 'compacted'` 条目的增量计数。
 *
 * 为什么不放进 cost-calculator 的 `foldCodexLine`：Codex 的用量读取会在已跟踪的
 * 源偏移处重放一个有界窗口，并且每次窗口都从全新的聚合开始（见 cost-calculator
 * 的 `scanFromWindow`）——对「最新快照」这类 latest-wins 指标无害，对计数却会把窗口
 * 之前的压缩次数丢掉。所以这里单独维护一个按文件的游标：已计数的字节前沿 + 计数，
 * 文件只追加就从前沿继续，被替换/截断才重扫。
 *
 * 只数 `compacted`，不数 `event_msg/context_compacted`：同一次压缩两个条目都会写，
 * 一起数会翻倍。
 *
 * 叶子模块：只依赖 node:fs 与 jsonl-cursor。
 */
import { statSync } from 'node:fs';
import { scanJsonlFromOffset } from './jsonl-cursor.js';

interface CompactionCursor {
  dev: number;
  ino: number;
  /** 最后一个完整行之后的字节偏移（只前进，不回退）。 */
  offset: number;
  /** offset 之前（含）已确认的 compacted 条目数。 */
  count: number;
  /** 写到一半、还没有换行的尾行是否已经是一条完整的 compacted 记录（预览，不进 count）。 */
  tailCounts: boolean;
  mtimeMs: number;
  size: number;
}

const CURSOR_MAX_ENTRIES = 512;
const cursors = new Map<string, CompactionCursor>();

export function __resetCodexCompactionCountForTest(): void {
  cursors.clear();
}

function isCompactedRecord(line: string): boolean {
  // 先做廉价的子串过滤：compacted 条目往往带很长的 replacement_history，
  // 其余绝大多数行不含这个词，不必 JSON.parse。命中后再解析确认是顶层 type。
  if (!line.includes('"compacted"')) return false;
  try {
    return JSON.parse(line)?.type === 'compacted';
  } catch {
    return false;
  }
}

function remember(path: string, cursor: CompactionCursor): void {
  if (cursors.size >= CURSOR_MAX_ENTRIES && !cursors.has(path)) {
    const oldest = cursors.keys().next().value;
    if (oldest !== undefined) cursors.delete(oldest);
  }
  cursors.set(path, cursor);
}

/**
 * 返回 rollout 里 `compacted` 条目的个数；读不到或不可信时返回 null（调用方据此省略，
 * 不要当 0 用）。
 *
 * `maxColdScanBytes`：没有可复用游标（冷启动 / 文件被替换）时，超过这个大小的文件不扫，
 * 返回 null——和用量读取对超大 rollout 的保护一致，避免在 daemon 里同步扫几百 MB。
 * 已有游标时从前沿继续追加部分，不受此限。
 */
export function readCodexCompactionCount(
  path: string,
  opts: { maxColdScanBytes: number },
): number | null {
  let st;
  try {
    st = statSync(path);
  } catch {
    cursors.delete(path);
    return null;
  }
  if (!st.isFile()) {
    cursors.delete(path);
    return null;
  }

  const prior = cursors.get(path);
  const reusable = prior !== undefined
    && prior.dev === st.dev
    && prior.ino === st.ino
    && st.size >= prior.offset;
  if (reusable && prior.size === st.size && prior.mtimeMs === st.mtimeMs) {
    return prior.count + (prior.tailCounts ? 1 : 0);
  }
  if (!reusable && st.size > opts.maxColdScanBytes) {
    cursors.delete(path);
    return null;
  }

  let count = reusable ? prior.count : 0;
  const fromOffset = reusable ? prior.offset : 0;
  let scanError = false;
  const scanned = scanJsonlFromOffset(path, fromOffset, {
    endOffset: st.size,
    onLine: (line) => { if (isCompactedRecord(line)) count++; },
    onError: () => { scanError = true; },
  });
  if (!scanned || scanError) {
    cursors.delete(path);
    return null;
  }

  const tail = scanned.pendingTail.trim();
  const tailCounts = tail.length > 0 && isCompactedRecord(tail);
  remember(path, {
    dev: st.dev,
    ino: st.ino,
    offset: scanned.newOffset,
    count,
    tailCounts,
    mtimeMs: st.mtimeMs,
    size: st.size,
  });
  return count + (tailCounts ? 1 : 0);
}
