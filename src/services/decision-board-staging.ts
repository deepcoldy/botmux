/**
 * 决策看板「图文说明」的暂存区：`<dataDir>/decision-board/<app_id>/staging/`。
 *
 * 说明页 / 视频走单独的原始字节上传（CLI → daemon），先流式写进这里（边写边算 sha256、超上限立即停），
 * 再由 attach 在一个事务里挪进 files/ 并写元数据和历史——一次 attach 不管带几个文件都只记一条历史，
 * daemon 内存也不随视频大小涨。
 *
 * 暂存区只有文件、不进数据库：attach 之前库里看不到它们。attach 不管成败都会丢掉它引用的暂存；
 * 没被 attach 的在下次上传时按时间清掉，整个暂存区另有总量上限。
 * 每份暂存是 `<id>.bin`（文件内容）+ `<id>.json`（文件名、类型、绑定的事项和会话）。
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BOARD_EXPLAINERS_PER_ATTACH,
  BOARD_VIDEO_MAX_BYTES,
  boardExplainerHtmlWarnings,
  boardExplainerMaxBytes,
  boardExplainerTooLargeText,
  boardFileKind,
  checkBoardExplainerHtml,
  isBoardExplainerMime,
  sniffBoardExplainer,
} from '../core/decision-board/files.js';
import { BoardError, type StagedFileInput } from './decision-board-store.js';

export const decisionBoardStagingDir = (dataDir: string, appId: string): string =>
  join(dataDir, 'decision-board', appId, 'staging');

/** 上传后多久没 attach 就当废料清掉（CLI 上传完紧接着 attach，正常只停留几秒）。 */
export const BOARD_STAGED_TTL_MS = 60 * 60 * 1000;
/** 每个管家的暂存区最多占这么多字节：够两次塞满的 attach，挡住只上传不 attach 的循环把磁盘写满。 */
export const BOARD_STAGING_MAX_BYTES = 2 * BOARD_EXPLAINERS_PER_ATTACH * BOARD_VIDEO_MAX_BYTES;
const STAGED_ID_RE = /^[0-9a-f]{20}$/;
const HEAD_BYTES = 64;

export interface StagedExplainer {
  id: string;
  seq: number;
  sessionId: string;
  name: string;
  mime: string;
  bytes: number;
  sha256: string;
  createdAt: number;
}

function removeQuietly(path: string): void {
  try { unlinkSync(path); } catch { /* 已经不在 */ }
}

/** 清掉过期的暂存（含上传中途断掉留下的 .part），返回留下的共占多少字节。 */
export function sweepBoardStaging(dir: string, now = Date.now()): number {
  let names: string[];
  try { names = readdirSync(dir); } catch { return 0; }
  let kept = 0;
  for (const name of names) {
    const path = join(dir, name);
    try {
      const st = statSync(path);
      if (now - st.mtimeMs > BOARD_STAGED_TTL_MS) unlinkSync(path);
      else kept += st.size;
    } catch { /* 并发清理或刚被 attach 挪走 */ }
  }
  return kept;
}

const mb = (bytes: number): number => Math.ceil(bytes / (1024 * 1024));

/**
 * 把一个说明页 / 视频流式写进暂存区。不信扩展名：按文件头核验类型，HTML 另外要求 UTF-8、不带 meta refresh。
 * 超过单个文件上限或暂存区总量时立即停止读取并删掉半截文件（调用方负责丢弃请求里剩下的字节）。
 */
export async function stageBoardExplainer(
  dataDir: string,
  appId: string,
  input: { seq: number; sessionId: string; name: string; mime: string; body: AsyncIterable<Uint8Array | string> },
  now = Date.now(),
): Promise<{ staged: StagedExplainer; warnings: string[] }> {
  const mime = input.mime.toLowerCase();
  if (!isBoardExplainerMime(mime)) throw new BoardError('unsupported_file', '图文说明只支持 .html 说明页和 .mp4 / .webm 视频');
  const max = boardExplainerMaxBytes(mime);
  const dir = decisionBoardStagingDir(dataDir, appId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const used = sweepBoardStaging(dir, now);

  const id = randomBytes(10).toString('hex');
  const part = join(dir, `${id}.part`);
  const hash = createHash('sha256');
  const head = Buffer.alloc(HEAD_BYTES);
  let headLen = 0;
  let total = 0;
  const fh = await open(part, 'wx', 0o600);
  try {
    for await (const raw of input.body) {
      const chunk = typeof raw === 'string' ? Buffer.from(raw) : Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
      total += chunk.length;
      if (total > max) throw new BoardError('file_too_large', boardExplainerTooLargeText(mime, input.name));
      if (used + total > BOARD_STAGING_MAX_BYTES) {
        throw new BoardError('staging_full', `图文说明暂存区已满：上传了还没附上的文件已占 ${mb(used)} MB（上限 ${mb(BOARD_STAGING_MAX_BYTES)} MB），`
          + `它们上传 ${BOARD_STAGED_TTL_MS / 60_000} 分钟后自动清掉，稍后再试`);
      }
      hash.update(chunk);
      if (headLen < HEAD_BYTES) headLen += chunk.copy(head, headLen, 0, Math.min(chunk.length, HEAD_BYTES - headLen));
      for (let off = 0; off < chunk.length;) off += (await fh.write(chunk, off, chunk.length - off)).bytesWritten;
    }
    await fh.close();
  } catch (error) {
    await fh.close().catch(() => {});
    removeQuietly(part);
    throw error;
  }

  const kindLabel = boardFileKind(mime) === 'video' ? '视频' : 'HTML 说明页';
  try {
    if (total === 0) throw new BoardError('invalid_file', `${input.name} 是空文件`);
    if (!sniffBoardExplainer(mime, head.subarray(0, headLen))) {
      throw new BoardError('invalid_file', `${input.name} 不是有效的${kindLabel}（文件头对不上）`);
    }
    let warnings: string[] = [];
    if (boardFileKind(mime) === 'html') {
      const checked = checkBoardExplainerHtml(readFileSync(part));
      if (!checked.ok) throw new BoardError('invalid_file', `${input.name}：${checked.reason}`);
      warnings = boardExplainerHtmlWarnings(checked.text);
    }
    const staged: StagedExplainer = {
      id, seq: input.seq, sessionId: input.sessionId, name: input.name, mime, bytes: total,
      sha256: hash.digest('hex'), createdAt: now,
    };
    renameSync(part, join(dir, `${id}.bin`));
    const metaTmp = join(dir, `${id}.json.part`);
    writeFileSync(metaTmp, JSON.stringify(staged), { mode: 0o600 });
    renameSync(metaTmp, join(dir, `${id}.json`));
    return { staged, warnings };
  } catch (error) {
    removeQuietly(part);
    removeQuietly(join(dir, `${id}.bin`));
    throw error;
  }
}

/** 取一份暂存：必须是同一事项、同一会话上传的，否则当不存在。 */
export function readStagedExplainer(
  dataDir: string,
  appId: string,
  id: unknown,
  expect: { seq: number; sessionId: string },
): StagedFileInput & { id: string } {
  const missing = new BoardError('unknown_file', '说明文件不存在或已过期，重新 attach');
  if (typeof id !== 'string' || !STAGED_ID_RE.test(id)) throw missing;
  const dir = decisionBoardStagingDir(dataDir, appId);
  let meta: Partial<StagedExplainer>;
  try { meta = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as Partial<StagedExplainer>; } catch { throw missing; }
  const path = join(dir, `${id}.bin`);
  if (meta.id !== id || meta.seq !== expect.seq || meta.sessionId !== expect.sessionId
    || typeof meta.mime !== 'string' || !isBoardExplainerMime(meta.mime)
    || typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)
    || typeof meta.bytes !== 'number' || typeof meta.name !== 'string' || !existsSync(path)) {
    throw missing;
  }
  return { id, path, sha256: meta.sha256, bytes: meta.bytes, mime: meta.mime, name: meta.name };
}

/** attach 之后丢掉暂存：成功时内容已经挪进 files/，失败时连内容一起删（CLI 重试会重新上传）。 */
export function discardStagedExplainer(dataDir: string, appId: string, id: string): void {
  if (!STAGED_ID_RE.test(id)) return;
  const dir = decisionBoardStagingDir(dataDir, appId);
  removeQuietly(join(dir, `${id}.json`));
  removeQuietly(join(dir, `${id}.bin`));
}
