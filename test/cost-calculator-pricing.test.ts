/**
 * Cost-calculator pricing tests — getSessionUsageSnapshot 的 costCny 累计口径。
 *
 * 仿 cost-calculator.test.ts 的 transcript fixture 风格（mock node:fs /
 * transcript finder），覆盖 claude 与 codex 两个 fixture：带 pricing 且模型
 * 已定价 → costCny 存在且为累计口径正确值；无 pricing / 未定价 / 无 usage
 * → 字段缺省。
 *
 * Run:  pnpm vitest run test/cost-calculator-pricing.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'bun:test';

// ─── Mocks ────────────────────────────────────────────────────────────────

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/home/testuser',
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  const readFileSyncMock = vi.fn(() => '');
  const fdContent = new Map<number, string>();
  let nextFd = 10_000;
  const statsForContent = (content: string) => ({
    dev: 1,
    ino: 1,
    size: Buffer.byteLength(content, 'utf8'),
    mtimeMs: 1,
    ctimeMs: 1,
    isFile: () => true,
  });
  return {
    ...original,
    closeSync: vi.fn((fd: number) => { fdContent.delete(fd); }),
    existsSync: vi.fn(() => false),
    fstatSync: vi.fn((fd: number) => statsForContent(fdContent.get(fd) ?? '')),
    lstatSync: vi.fn(() => ({
      isFile: () => true,
      mtimeMs: 0,
    })),
    openSync: vi.fn((path: string) => {
      const fd = nextFd++;
      fdContent.set(fd, String(readFileSyncMock(path, 'utf-8') ?? ''));
      return fd;
    }),
    readFileSync: readFileSyncMock,
    readSync: vi.fn((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) => {
      const content = Buffer.from(fdContent.get(fd) ?? '', 'utf8');
      const start = Math.max(0, position ?? 0);
      const slice = content.subarray(start, start + length);
      slice.copy(buffer, offset);
      return slice.length;
    }),
    statSync: vi.fn((path: string) => statsForContent(String(readFileSyncMock(path, 'utf-8') ?? ''))),
  };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/core/working-dir.js', () => ({
  expandHome: (p: string) => (p.startsWith('~') ? `/home/testuser${p.slice(1)}` : p),
}));

vi.mock('../src/services/codex-transcript.js', () => ({
  findCodexRolloutBySessionId: vi.fn(() => undefined),
  findCodexSessionIdByBotmuxSessionId: vi.fn(() => undefined),
}));

vi.mock('../src/services/traex-transcript.js', () => ({
  findTraexRolloutBySessionId: vi.fn(() => undefined),
}));

vi.mock('../src/services/pi-transcript.js', () => ({
  findPiTranscriptBySessionId: vi.fn(() => undefined),
}));

vi.mock('../src/services/aiden-checkpoints.js', () => ({
  findAidenLatestCheckpointBySessionId: vi.fn(() => undefined),
  findAidenLatestCheckpointByBotmuxSessionId: vi.fn(() => undefined),
}));

vi.mock('../src/services/jsonl-cursor.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/services/jsonl-cursor.js')>();
  return {
    ...original,
    scanJsonlFromOffset: vi.fn((path: string, fromOffset: number, opts?: { onLine?: (line: string, lineStart: number) => void }) => {
      const text = String(vi.mocked(readFileSync)(path, 'utf-8')).slice(Math.max(0, fromOffset));
      let cursor = Math.max(0, fromOffset);
      const lines = text.split('\n');
      const pendingTail = lines.pop() ?? '';
      for (const line of lines) {
        opts?.onLine?.(line, cursor);
        cursor += Buffer.byteLength(line, 'utf8') + 1;
      }
      return { newOffset: cursor, pendingTail };
    }),
  };
});

vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(() => ({ claudeDataDir: '/fake/pkg/.claude-runtime' })),
}));

import { existsSync, readFileSync } from 'node:fs';
import { findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId } from '../src/services/codex-transcript.js';
import { getSessionUsageSnapshot, __resetSessionUsageCachesForTest } from '../src/core/cost-calculator.js';
import { DEFAULT_USD_CNY, type ResolvedModelPricing } from '../src/services/model-pricing.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

function assistantLine(opts: {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheCreate?: number;
  model?: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    message: {
      model: opts.model ?? 'claude-sonnet-4-5-20250929',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
      },
    },
  });
}

function userLine(text = 'hello'): string {
  return JSON.stringify({ type: 'human', message: { content: text } });
}

function setupJsonl(content: string): void {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(readFileSync).mockReturnValue(content);
}

const pricing: ResolvedModelPricing = { usdCny: DEFAULT_USD_CNY };

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetSessionUsageCachesForTest();
  vi.mocked(existsSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(findCodexRolloutBySessionId).mockReset();
  vi.mocked(findCodexRolloutBySessionId).mockReturnValue(undefined);
  vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReset();
  vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue(undefined);
});

describe('getSessionUsageSnapshot costCny (Claude fixture)', () => {
  it('fills costCny on the cumulative totals when pricing is supplied and the model is priced', () => {
    setupJsonl([
      assistantLine({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5 }),
      assistantLine({ input: 200, output: 80, cacheRead: 20, cacheCreate: 0 }),
    ].join('\n'));

    const snap = getSessionUsageSnapshot({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: '/tmp',
      fresh: true,
      pricing,
    });

    // 累计：input 300 / output 130 / cacheRead 30 / cacheCreate 5
    // claude-sonnet-4: 3 / 15 / 0.3 / 3.75 USD per 1M
    // (300*3 + 130*15 + 30*0.3 + 5*3.75) / 1e6 * 7.2 = 0.0207198
    expect(snap.tokens).toMatchObject({ inputTokens: 300, outputTokens: 130 });
    expect(snap.costCny).toBeCloseTo(0.0207198, 6);
  });

  it('omits costCny when no pricing is supplied', () => {
    setupJsonl(assistantLine({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5 }));

    const snap = getSessionUsageSnapshot({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: '/tmp',
      fresh: true,
    });

    expect(snap.tokens).not.toBeNull();
    expect(snap.costCny).toBeUndefined();
  });

  it('omits costCny when the model is unpriced (fail-closed, no guess)', () => {
    setupJsonl(assistantLine({ input: 100, output: 50, model: 'grok-3' }));

    const snap = getSessionUsageSnapshot({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: '/tmp',
      fresh: true,
      pricing,
    });

    expect(snap.tokens).toMatchObject({ model: 'grok-3' });
    expect(snap.costCny).toBeUndefined();
  });

  it('omits costCny when the transcript has no usage', () => {
    setupJsonl(userLine('hi'));

    const snap = getSessionUsageSnapshot({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: '/tmp',
      fresh: true,
      pricing,
    });

    expect(snap.tokens).toBeNull();
    expect(snap.costCny).toBeUndefined();
  });
});

describe('getSessionUsageSnapshot costCny (Codex fixture)', () => {
  it('prices the cumulative token_count snapshot under the resolved model', () => {
    vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue('codex-sid');
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue('/home/testuser/.codex/sessions/rollout-codex-sid.jsonl');
    setupJsonl([
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.1-codex' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 },
          },
        },
      }),
    ].join('\n'));

    const snap = getSessionUsageSnapshot({
      cliId: 'codex',
      sessionId: 'botmux-sid',
      fresh: true,
      pricing,
    });

    // input 100（含 cache）→ 互斥桶：inputTokens 60 / cacheRead 40 / output 20
    // gpt-5.1-codex: 2 / 15 / 0.5 USD per 1M（cacheWrite 缺省回退 input）
    // (60*2 + 20*15 + 40*0.5) / 1e6 * 7.2 = 0.003168
    expect(snap.tokens).toMatchObject({
      inputTokens: 60,
      outputTokens: 20,
      cacheReadTokens: 40,
      model: 'gpt-5.1-codex',
    });
    expect(snap.costCny).toBeCloseTo(0.003168, 6);
  });
});
