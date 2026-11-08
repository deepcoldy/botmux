/**
 * 图文说明的存取：上传先写暂存区（不进库），attach 把说明页 / 视频和截图一起挂到事项上、只记一条历史；
 * 大小上限、文件头、暂存和事项 / 会话的绑定、过期清理、总量上限、失败和回滚不留残档；老的截图 attach 不变。
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionBoardService, boardErrorStatus } from '../src/core/decision-board/service.js';
import { BOARD_LIMITS, type StewardConfig } from '../src/core/decision-board/model.js';
import { DecisionBoardStore, decisionBoardFilesDir } from '../src/services/decision-board-store.js';
import {
  BOARD_STAGED_TTL_MS,
  BOARD_STAGING_MAX_BYTES,
  decisionBoardStagingDir,
  readStagedExplainer,
} from '../src/services/decision-board-staging.js';
import { BOARD_HTML_MAX_BYTES, BOARD_VIDEO_MAX_BYTES } from '../src/core/decision-board/files.js';

const MB = (n: number) => `${n / 1024 / 1024}MB`;

const APP = 'cli_steward';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200, 1)]);
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(200, 2)]);
const HTML = Buffer.from('<!doctype html><meta charset="utf-8"><h1>改前改后</h1><img src="data:image/png;base64,AAAA">');

let dir: string;
let steward: StewardConfig | undefined;
let service: DecisionBoardService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-board-explainer-'));
  steward = { enabled: true, chatId: 'oc_steward' };
  service = new DecisionBoardService({
    dataDir: dir,
    larkAppId: () => APP,
    steward: () => steward,
    locale: () => 'zh',
    brand: () => 'feishu',
    dashboardOrigin: () => 'https://dash.example',
    ownerOpenId: () => 'ou_owner',
    ownerName: async () => 'owner',
    timeZone: () => 'UTC',
    batchAttachmentsDir: batchId => join(dir, 'attachments', `board-${batchId}`),
    banner: ({ batchId, count }) => `收到 ${count} 项（#${batchId}）`,
    deliver: async () => ({ sessionId: 'sess-steward' }),
    log: () => {},
    lookupChat: async chatId => ({ ok: true, chatId, appId: APP, name: chatId }),
  });
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

async function addItem(title = '改动 #1'): Promise<number> {
  const res = await service.cli({ action: 'add', title, noChat: '用例' }, { sessionId: 'sess-1' }) as { item: { seq: number } };
  return res.item.seq;
}

/** 按块给出正文，模拟网络上一点点到；记下读了多少。 */
function body(buf: Buffer, chunk = 64 * 1024): AsyncIterable<Buffer> & { read: number } {
  const out = {
    read: 0,
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < buf.length; i += chunk) {
        const part = buf.subarray(i, i + chunk);
        out.read += part.length;
        yield part;
      }
    },
  };
  return out;
}

/** 只在被读到时才生成的大正文（不先在内存里放一整份）。 */
function hugeBody(head: Buffer, total: number): AsyncIterable<Buffer> & { read: number } {
  const block = Buffer.alloc(1024 * 1024, 0x20);
  const out = {
    read: 0,
    async *[Symbol.asyncIterator]() {
      out.read += head.length;
      yield head;
      while (out.read < total) {
        const part = block.subarray(0, Math.min(block.length, total - out.read));
        out.read += part.length;
        yield part;
      }
    },
  };
  return out;
}

const stage = (seq: number, name: string, mime: string, data: Buffer | AsyncIterable<Buffer>, sessionId = 'sess-1') =>
  service.stageExplainer({ ref: String(seq), name, mime, body: Buffer.isBuffer(data) ? body(data) : data }, { sessionId });

const stagingEntries = () => {
  const d = decisionBoardStagingDir(dir, APP);
  return existsSync(d) ? readdirSync(d) : [];
};

const storedFiles = () => {
  const d = decisionBoardFilesDir(dir, APP);
  return existsSync(d) ? readdirSync(d) : [];
};

describe('附图文说明', () => {
  it('说明页 + 视频 + 截图一次附上：只记一条历史，暂存清空，列表和详情都看得到', async () => {
    const seq = await addItem();
    const page = await stage(seq, '/tmp/说明.htm', 'text/html', HTML);
    const video = await stage(seq, 'demo.mp4', 'video/mp4', MP4);
    expect(page).toMatchObject({ seq, name: '说明.html', mime: 'text/html', bytes: HTML.length, warnings: [] });
    expect(video).toMatchObject({ name: 'demo.mp4', mime: 'video/mp4', bytes: MP4.length });
    // 暂存不进库：还没 attach 时事项上没有文件。
    expect(service.detail(seq, 'owner').files).toEqual([]);

    const res = await service.cli({
      action: 'attach', ref: String(seq), staged: [page.id, video.id],
      files: [{ name: 'shot.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') }],
    }, { sessionId: 'sess-1' }) as any;
    expect(res.files.map((f: any) => f.mime)).toEqual(['text/html', 'video/mp4', 'image/png']);
    expect(res.url).toBe(`https://dash.example/board/${APP}/${seq}`);

    const detail = service.detail(seq, 'owner');
    expect(detail.files.map(f => [f.mime, f.name, f.by])).toEqual([
      ['text/html', '说明.html', 'steward'], ['video/mp4', 'demo.mp4', 'steward'], ['image/png', 'shot.png', 'steward'],
    ]);
    const attach = detail.events.filter(e => e.kind === 'attach');
    expect(attach).toHaveLength(1);
    expect(attach[0]!.text).toMatch(/说明页 1.*视频 1.*截图 1/);
    expect(attach[0]!.fileIds).toEqual(detail.files.map(f => f.id));
    expect(service.list('all', 'owner').items.find(i => i.seq === seq)?.explainers).toBe(2);

    // 内容按 sha256 放进 files/，读回来和上传的一致；暂存区里什么都不剩。
    expect(service.readFile(detail.files[0]!.id)?.data.equals(HTML)).toBe(true);
    expect(service.fileInfo(detail.files[1]!.id)?.path.startsWith(decisionBoardFilesDir(dir, APP))).toBe(true);
    expect(stagingEntries()).toEqual([]);
  });

  it('--note 照写进历史；只有视频时也能附', async () => {
    const seq = await addItem();
    const video = await stage(seq, 'a.webm', 'video/webm', WEBM);
    await service.cli({ action: 'attach', ref: String(seq), staged: [video.id], note: '录屏' }, { sessionId: 'sess-1' });
    expect(service.detail(seq, 'owner').events.find(e => e.kind === 'attach')?.text).toBe('录屏');
  });

  it('老的截图 attach 不变：默认历史文字、列表里不算图文说明', async () => {
    const seq = await addItem();
    const res = await service.cli({ action: 'attach', ref: String(seq), files: [{ name: 'a.png', mimeType: 'image/png', dataBase64: PNG.toString('base64') }] }, { sessionId: 's' }) as any;
    expect(res.files).toEqual([{ id: expect.any(String), name: 'a.png', bytes: PNG.length }]);
    expect(service.detail(seq, 'owner').events.find(e => e.kind === 'attach')?.text).toBe('附了 1 张截图');
    expect(service.list('all', 'owner').items.find(i => i.seq === seq)).not.toHaveProperty('explainers');
    await expect(service.cli({ action: 'attach', ref: String(seq) }, { sessionId: 's' })).rejects.toMatchObject({ code: 'files_required', message: '至少附一张图' });
  });

  it('说明页里的外链和脚本不拒收，上传时提醒', async () => {
    const seq = await addItem();
    const res = await stage(seq, 'x.html', 'text/html', Buffer.from('<html><script>fetch("/api")</script><img src="https://cdn.x/a.png">'));
    expect(res.warnings).toHaveLength(2);
  });
});

describe('上传校验', () => {
  it('说明页超过 10MB：读到上限就停、413、提示里有上限，半截文件删掉', async () => {
    const seq = await addItem();
    const src = hugeBody(Buffer.from('<html>'), 12 * 1024 * 1024);
    const error = await stage(seq, 'big.html', 'text/html', src).catch(e => e);
    expect(error).toMatchObject({ code: 'file_too_large', message: expect.stringContaining(MB(BOARD_HTML_MAX_BYTES)) });
    expect(boardErrorStatus(error).status).toBe(413);
    expect(src.read).toBeLessThanOrEqual(BOARD_HTML_MAX_BYTES + 1024 * 1024);
    expect(stagingEntries()).toEqual([]);
  });

  it('视频超过上限一样拒；正好等于上限的收', async () => {
    const seq = await addItem();
    const head = MP4.subarray(0, 16);
    const over = await stage(seq, 'big.mp4', 'video/mp4', hugeBody(head, BOARD_VIDEO_MAX_BYTES + 1)).catch(e => e);
    expect(over).toMatchObject({ code: 'file_too_large', message: expect.stringContaining(MB(BOARD_VIDEO_MAX_BYTES)) });
    expect(stagingEntries()).toEqual([]);
    const exact = await stage(seq, 'ok.mp4', 'video/mp4', hugeBody(head, BOARD_VIDEO_MAX_BYTES));
    expect(exact.bytes).toBe(BOARD_VIDEO_MAX_BYTES);
  }, 30_000);

  it('文件头对不上、空文件、非 UTF-8、meta refresh、不支持的类型都拒，暂存区不留残档', async () => {
    const seq = await addItem();
    const cases: Array<[string, string, Buffer, string]> = [
      ['fake.mp4', 'video/mp4', PNG, 'invalid_file'],
      ['fake.webm', 'video/webm', MP4, 'invalid_file'],
      ['empty.html', 'text/html', Buffer.alloc(0), 'invalid_file'],
      ['gbk.html', 'text/html', Buffer.from([0x3c, 0x70, 0x3e, 0xc4, 0xe3]), 'invalid_file'],
      ['jump.html', 'text/html', Buffer.from('<meta http-equiv="refresh" content="0;url=https://x">'), 'invalid_file'],
      ['a.svg', 'image/svg+xml', Buffer.from('<svg/>'), 'unsupported_file'],
      ['a.png', 'image/png', PNG, 'unsupported_file'],
    ];
    for (const [name, mime, data, code] of cases) {
      await expect(stage(seq, name, mime, data), name).rejects.toMatchObject({ code });
    }
    expect(stagingEntries()).toEqual([]);
  });

  it('管家关着、事项不存在：读正文之前就拒', async () => {
    const seq = await addItem();
    const src = body(HTML);
    await expect(service.stageExplainer({ ref: '999', name: 'a.html', mime: 'text/html', body: src }, { sessionId: 's' }))
      .rejects.toMatchObject({ code: 'item_not_found' });
    steward = undefined;
    await expect(stage(seq, 'a.html', 'text/html', src)).rejects.toMatchObject({ code: 'not_steward' });
    expect(src.read).toBe(0);
  });
});

describe('暂存的绑定与清理', () => {
  it('只能由同一会话、挂到上传时指定的事项；用过一次就没了；乱写的 id 当不存在', async () => {
    const a = await addItem('a');
    const b = await addItem('b');
    const page = await stage(a, 'a.html', 'text/html', HTML);
    const attach = (seq: number, staged: unknown[], sessionId = 'sess-1') =>
      service.cli({ action: 'attach', ref: String(seq), staged }, { sessionId });
    await expect(attach(a, [page.id], 'sess-other')).rejects.toMatchObject({ code: 'unknown_file' });
    await expect(attach(b, [page.id])).rejects.toMatchObject({ code: 'unknown_file' });
    for (const bad of ['../../decision-board.sqlite', '', 42, `${page.id}/..`]) {
      await expect(attach(a, [bad])).rejects.toMatchObject({ code: 'unknown_file' });
    }
    await expect(attach(a, [])).rejects.toMatchObject({ code: 'files_required' });
    await attach(a, [page.id]);
    await expect(attach(a, [page.id])).rejects.toMatchObject({ code: 'unknown_file' });
    expect(service.detail(a, 'owner').events.filter(e => e.kind === 'attach')).toHaveLength(1);
    expect(service.detail(b, 'owner').files).toEqual([]);
  });

  it('一次最多 4 个说明页 / 视频', async () => {
    const seq = await addItem();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await stage(seq, `p${i}.html`, 'text/html', Buffer.from(`<p>${i}</p>`))).id);
    await expect(service.cli({ action: 'attach', ref: String(seq), staged: ids }, { sessionId: 'sess-1' }))
      .rejects.toMatchObject({ code: 'too_many_files' });
  });

  it('同一份内容附两次只存一份文件，各有一条元数据', async () => {
    const seq = await addItem();
    for (let i = 0; i < 2; i++) {
      const page = await stage(seq, 'same.html', 'text/html', HTML);
      await service.cli({ action: 'attach', ref: String(seq), staged: [page.id] }, { sessionId: 'sess-1' });
    }
    expect(service.detail(seq, 'owner').files).toHaveLength(2);
    expect(readdirSync(decisionBoardFilesDir(dir, APP))).toHaveLength(1);
    expect(stagingEntries()).toEqual([]);
  });

  it('过了保留期没附上的暂存，下次上传时清掉；没过期的不动', async () => {
    const seq = await addItem();
    const old = await stage(seq, 'old.html', 'text/html', HTML);
    const staging = decisionBoardStagingDir(dir, APP);
    const past = (Date.now() - BOARD_STAGED_TTL_MS - 60_000) / 1000;
    for (const f of readdirSync(staging)) utimesSync(join(staging, f), past, past);
    writeFileSync(join(staging, 'leftover.part'), 'x');
    utimesSync(join(staging, 'leftover.part'), past, past);
    const fresh = await stage(seq, 'new.html', 'text/html', HTML);
    expect(stagingEntries().sort()).toEqual([`${fresh.id}.bin`, `${fresh.id}.json`]);
    await expect(service.cli({ action: 'attach', ref: String(seq), staged: [old.id] }, { sessionId: 'sess-1' }))
      .rejects.toMatchObject({ code: 'unknown_file' });
  });
});

describe('失败不留残档', () => {
  it('attach 失败（说明太长、截图不合规）也丢掉这次引用的暂存；别的会话传的不动', async () => {
    const seq = await addItem();
    const attach = (staged: string[], extra: Record<string, unknown>) =>
      service.cli({ action: 'attach', ref: String(seq), staged, ...extra }, { sessionId: 'sess-1' });
    const theirs = await stage(seq, 'theirs.html', 'text/html', HTML, 'sess-2');

    const page = await stage(seq, 'a.html', 'text/html', HTML);
    await expect(attach([page.id, theirs.id], {})).rejects.toMatchObject({ code: 'unknown_file' });
    await expect(attach([page.id], {})).rejects.toMatchObject({ code: 'unknown_file' });

    const video = await stage(seq, 'demo.webm', 'video/webm', WEBM);
    await expect(attach([video.id], { note: 'x'.repeat(BOARD_LIMITS.note + 1) })).rejects.toThrow();
    const again = await stage(seq, 'b.html', 'text/html', HTML);
    await expect(attach([again.id], { files: [{ name: 'x.png', mimeType: 'image/png', dataBase64: 'not-an-image' }] }))
      .rejects.toMatchObject({ code: 'invalid_files' });

    expect(stagingEntries().sort()).toEqual([`${theirs.id}.bin`, `${theirs.id}.json`]);
    expect(storedFiles()).toEqual([]);
    expect(service.detail(seq, 'owner').files).toEqual([]);
  });

  it('事务回滚：挪进 files/ 的说明文件挪回暂存区，内容重复的暂存副本和原有文件都留着', async () => {
    const seq = await addItem();
    const first = await stage(seq, 'first.html', 'text/html', HTML);
    await service.cli({ action: 'attach', ref: String(seq), staged: [first.id] }, { sessionId: 'sess-1' });
    expect(storedFiles()).toHaveLength(1);

    const fresh = await stage(seq, 'fresh.webm', 'video/webm', WEBM);
    const dup = await stage(seq, 'dup.html', 'text/html', HTML);
    const read = (id: string) => readStagedExplainer(dir, APP, id, { seq, sessionId: 'sess-1' });
    const [freshIn, dupIn] = [read(fresh.id), read(dup.id)];
    const missing = { ...freshIn, path: join(decisionBoardStagingDir(dir, APP), 'gone.bin'), sha256: 'f'.repeat(64) };

    const store = DecisionBoardStore.open(dir);
    try {
      expect(() => store.attachExplainers(APP, seq, { images: [], staged: [freshIn, dupIn, missing] }, undefined))
        .toThrow(expect.objectContaining({ code: 'unknown_file' }));
    } finally {
      store.close();
    }
    expect(readFileSync(freshIn.path).equals(WEBM)).toBe(true);
    expect(readFileSync(dupIn.path).equals(HTML)).toBe(true);
    expect(storedFiles()).toHaveLength(1);
    const detail = service.detail(seq, 'owner');
    expect(detail.files.map(f => f.name)).toEqual(['first.html']);
    expect(service.readFile(detail.files[0]!.id)?.data.equals(HTML)).toBe(true);

    // 没提交的那次不影响之后照常 attach。
    await service.cli({ action: 'attach', ref: String(seq), staged: [fresh.id, dup.id] }, { sessionId: 'sess-1' });
    expect(service.detail(seq, 'owner').files.map(f => f.name)).toEqual(['first.html', 'fresh.webm', 'dup.html']);
    expect(stagingEntries()).toEqual([]);
  });

  it('暂存区总量有上限：满了拒收、提示里有上限，过期的清掉后又能传', async () => {
    const seq = await addItem();
    await stage(seq, 'a.html', 'text/html', HTML);
    const filler = join(decisionBoardStagingDir(dir, APP), 'filler.part');
    writeFileSync(filler, '');
    truncateSync(filler, BOARD_STAGING_MAX_BYTES - HTML.length);

    const err = await stage(seq, 'b.html', 'text/html', HTML).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'staging_full' });
    expect(boardErrorStatus(err).status).toBe(507);
    expect((err as Error).message).toContain(`${Math.ceil(BOARD_STAGING_MAX_BYTES / 1024 / 1024)} MB`);
    expect(stagingEntries().filter(f => f.endsWith('.part'))).toEqual(['filler.part']);

    const past = (Date.now() - BOARD_STAGED_TTL_MS - 60_000) / 1000;
    utimesSync(filler, past, past);
    await expect(stage(seq, 'c.html', 'text/html', HTML)).resolves.toMatchObject({ seq });
    expect(stagingEntries()).not.toContain('filler.part');
  });
});
