/**
 * Unit tests for cost-calculator: getSessionJsonlPath, getSessionCost, formatNumber.
 *
 * Run:  pnpm vitest run test/cost-calculator.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// ─── Mocks ────────────────────────────────────────────────────────────────

// Mock os.homedir before importing the module under test
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  homedir: () => '/home/testuser',
}));

// Mock fs so we never touch real disk
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  };
});

// Mock the logger to suppress output
vi.mock('../src/utils/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// expandHome is imported by cost-calculator from working-dir; provide a simple impl
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

// Seed/Relay data root resolution goes through the adapter (binary realpath →
// <pkg>/.claude-runtime). Mock it to a deterministic package-local root so the
// path assertion below proves we no longer read from ~/.claude-runtime.
const FORK_DATA_DIR = '/fake/pkg/.claude-runtime';
vi.mock('../src/adapters/cli/registry.js', () => ({
  createCliAdapterSync: vi.fn(() => ({ claudeDataDir: FORK_DATA_DIR })),
}));

import { existsSync, readFileSync } from 'node:fs';
import { findAidenLatestCheckpointByBotmuxSessionId, findAidenLatestCheckpointBySessionId } from '../src/services/aiden-checkpoints.js';
import { findCodexRolloutBySessionId, findCodexSessionIdByBotmuxSessionId } from '../src/services/codex-transcript.js';
import { findTraexRolloutBySessionId } from '../src/services/traex-transcript.js';
import {
  getSessionJsonlPath,
  getSessionCost,
  getSessionTokenUsage,
  formatNumber,
  __resetSessionUsageCachesForTest,
  type SessionCost,
} from '../src/core/cost-calculator.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Build a JSONL assistant entry with usage info. */
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
      model: opts.model ?? 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: opts.input ?? 0,
        output_tokens: opts.output ?? 0,
        cache_read_input_tokens: opts.cacheRead ?? 0,
        cache_creation_input_tokens: opts.cacheCreate ?? 0,
      },
    },
  });
}

/** Build a non-assistant JSONL entry (should be skipped). */
function userLine(text = 'hello'): string {
  return JSON.stringify({ type: 'human', message: { content: text } });
}

// ─── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => {
  __resetSessionUsageCachesForTest();
  vi.mocked(existsSync).mockReset();
  vi.mocked(readFileSync).mockReset();
  vi.mocked(findCodexRolloutBySessionId).mockReset();
  vi.mocked(findCodexRolloutBySessionId).mockReturnValue(undefined);
  vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReset();
  vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue(undefined);
  vi.mocked(findTraexRolloutBySessionId).mockReset();
  vi.mocked(findTraexRolloutBySessionId).mockReturnValue(undefined);
  vi.mocked(findAidenLatestCheckpointBySessionId).mockReset();
  vi.mocked(findAidenLatestCheckpointBySessionId).mockReturnValue(undefined);
  vi.mocked(findAidenLatestCheckpointByBotmuxSessionId).mockReset();
  vi.mocked(findAidenLatestCheckpointByBotmuxSessionId).mockReturnValue(undefined);
});

// ── getSessionJsonlPath ──────────────────────────────────────────────────

describe('getSessionJsonlPath', () => {
  it('returns the expected path when the jsonl file exists', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const result = getSessionJsonlPath('abc-123', '/projects/my-app');
    // cwd resolves to /projects/my-app; project key replaces / with -
    const expectedPath = join(
      '/home/testuser',
      '.claude',
      'projects',
      '-projects-my-app',
      'abc-123.jsonl',
    );
    expect(result).toBe(expectedPath);
    expect(existsSync).toHaveBeenCalledWith(expectedPath);
  });

  it('returns null when the jsonl file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const result = getSessionJsonlPath('abc-123', '/projects/my-app');
    expect(result).toBeNull();
  });

  it('handles cwd with tilde (expandHome)', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const result = getSessionJsonlPath('sess-1', '~/code/repo');
    // expandHome turns ~/code/repo -> /home/testuser/code/repo
    // project key: -home-testuser-code-repo
    const expectedPath = join(
      '/home/testuser',
      '.claude',
      'projects',
      '-home-testuser-code-repo',
      'sess-1.jsonl',
    );
    expect(result).toBe(expectedPath);
  });

  it('matches Claude project keys by replacing all non-alnum path chars', () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const result = getSessionJsonlPath('sess-2', '/Users/test/.codex/work_trees/repo');
    const expectedPath = join(
      '/home/testuser',
      '.claude',
      'projects',
      '-Users-test--codex-work-trees-repo',
      'sess-2.jsonl',
    );
    expect(result).toBe(expectedPath);
  });
});

// ── getSessionCost ──────────────────────────────────────────────────────

describe('getSessionCost', () => {
  /** Arrange: make the path exist and return the given file content. */
  function setupJsonl(content: string) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(content);
  }

  it('returns null when the jsonl file does not exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(getSessionCost('id', '/tmp')).toBeNull();
  });

  it('parses a single assistant turn', () => {
    setupJsonl(assistantLine({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5, model: 'claude-sonnet-4-20250514' }));

    const cost = getSessionCost('s1', '/tmp')!;
    expect(cost).toEqual<SessionCost>({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 10,
      cacheCreateTokens: 5,
      model: 'claude-sonnet-4-20250514',
      turns: 1,
    });
  });

  it('aggregates multiple assistant turns', () => {
    const lines = [
      assistantLine({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5, model: 'claude-sonnet-4-20250514' }),
      assistantLine({ input: 200, output: 80, cacheRead: 20, cacheCreate: 0 }),
      assistantLine({ input: 300, output: 120, cacheRead: 30, cacheCreate: 15, model: 'claude-opus-4-20250514' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s2', '/tmp')!;
    expect(cost.inputTokens).toBe(600);
    expect(cost.outputTokens).toBe(250);
    expect(cost.cacheReadTokens).toBe(60);
    expect(cost.cacheCreateTokens).toBe(20);
    // model is set from the first assistant entry
    expect(cost.model).toBe('claude-sonnet-4-20250514');
    expect(cost.turns).toBe(3);
  });

  it('skips non-assistant entries', () => {
    const lines = [
      userLine('hi'),
      assistantLine({ input: 50, output: 25 }),
      userLine('bye'),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s3', '/tmp')!;
    expect(cost.inputTokens).toBe(50);
    expect(cost.outputTokens).toBe(25);
    expect(cost.turns).toBe(1);
  });

  it('handles empty file', () => {
    setupJsonl('');

    const cost = getSessionCost('s4', '/tmp')!;
    expect(cost).toEqual<SessionCost>({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      model: '',
      turns: 0,
    });
  });

  it('handles file with only blank lines', () => {
    setupJsonl('\n\n  \n');

    const cost = getSessionCost('s5', '/tmp')!;
    expect(cost.turns).toBe(0);
    expect(cost.inputTokens).toBe(0);
  });

  it('skips malformed JSON lines gracefully', () => {
    const lines = [
      'this is not json',
      assistantLine({ input: 100, output: 50 }),
      '{ broken json',
      assistantLine({ input: 200, output: 100 }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s6', '/tmp')!;
    expect(cost.inputTokens).toBe(300);
    expect(cost.outputTokens).toBe(150);
    expect(cost.turns).toBe(2);
  });

  it('skips assistant entries without usage field', () => {
    const lines = [
      JSON.stringify({ type: 'assistant', message: { model: 'test' } }),
      assistantLine({ input: 50, output: 25 }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s7', '/tmp')!;
    // First line is type=assistant but has no usage, so skipped
    expect(cost.turns).toBe(1);
    expect(cost.inputTokens).toBe(50);
  });

  it('skips assistant entries without message field', () => {
    const lines = [
      JSON.stringify({ type: 'assistant' }),
      assistantLine({ input: 40, output: 20, model: 'my-model' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s8', '/tmp')!;
    expect(cost.turns).toBe(1);
    expect(cost.model).toBe('my-model');
  });

  it('handles missing token fields by defaulting to 0', () => {
    // usage object present but with only partial fields
    const partial = JSON.stringify({
      type: 'assistant',
      message: {
        model: 'partial-model',
        usage: { input_tokens: 42 },
      },
    });
    setupJsonl(partial);

    const cost = getSessionCost('s9', '/tmp')!;
    expect(cost.inputTokens).toBe(42);
    expect(cost.outputTokens).toBe(0);
    expect(cost.cacheReadTokens).toBe(0);
    expect(cost.cacheCreateTokens).toBe(0);
    expect(cost.turns).toBe(1);
  });

  it('uses model from first assistant entry only', () => {
    const lines = [
      assistantLine({ input: 10, output: 5, model: 'first-model' }),
      assistantLine({ input: 10, output: 5, model: 'second-model' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s10', '/tmp')!;
    expect(cost.model).toBe('first-model');
  });

  it('picks up model from a later entry if earlier ones lack model', () => {
    const noModel = JSON.stringify({
      type: 'assistant',
      message: { usage: { input_tokens: 10, output_tokens: 5 } },
    });
    const lines = [
      noModel,
      assistantLine({ input: 20, output: 10, model: 'late-model' }),
    ].join('\n');
    setupJsonl(lines);

    const cost = getSessionCost('s11', '/tmp')!;
    // First entry has no model field, so model comes from the second entry
    expect(cost.model).toBe('late-model');
    expect(cost.turns).toBe(2);
  });

  it('returns null when readFileSync throws', () => {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    const cost = getSessionCost('s12', '/tmp');
    expect(cost).toBeNull();
  });

  it('handles trailing newline in JSONL file', () => {
    const content = assistantLine({ input: 10, output: 5 }) + '\n';
    setupJsonl(content);

    const cost = getSessionCost('s13', '/tmp')!;
    expect(cost.turns).toBe(1);
    expect(cost.inputTokens).toBe(10);
  });
});

// ── getSessionTokenUsage ─────────────────────────────────────────────────

describe('getSessionTokenUsage', () => {
  function setupJsonl(content: string) {
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(readFileSync).mockReturnValue(content);
  }

  it('reports dashboard token in/out from native Claude usage, including cache input tokens', () => {
    setupJsonl([
      assistantLine({ input: 100, output: 50, cacheRead: 10, cacheCreate: 5, model: 'claude-sonnet-4-20250514' }),
      assistantLine({ input: 200, output: 80, cacheRead: 20, cacheCreate: 7 }),
    ].join('\n'));

    expect(getSessionTokenUsage({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: '/tmp',
    })).toEqual({
      in: 342,
      out: 130,
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 30,
      cacheCreateTokens: 12,
      turns: 2,
      model: 'claude-sonnet-4-20250514',
    });
  });

  it('returns null when an Agent CLI has no native token usage available', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(getSessionTokenUsage({
      cliId: 'gemini',
      sessionId: 's1',
      cwd: '/tmp',
    })).toBeNull();
  });

  it('resolves relay usage under the adapter\'s package-local .claude-runtime (not ~/.claude-runtime)', () => {
    delete process.env.CLAUDE_CONFIG_DIR;
    setupJsonl(assistantLine({ input: 100, output: 50, model: 'ark/relay-code' }));

    const usage = getSessionTokenUsage({ cliId: 'relay', sessionId: 's1', cwd: '/tmp' });

    expect(usage).toMatchObject({ inputTokens: 100, outputTokens: 50, turns: 1 });
    // The jsonl path must sit under the adapter-derived package root, never the
    // old ~/.claude-runtime fallback that the daemon's unset env produced.
    const readPaths = vi.mocked(readFileSync).mock.calls.map((c) => String(c[0]));
    expect(readPaths.some((p) => p.startsWith(`${FORK_DATA_DIR}/projects/`))).toBe(true);
    expect(readPaths.every((p) => !p.startsWith('/home/testuser/.claude-runtime/'))).toBe(true);
  });

  it('ignores the daemon CLAUDE_CONFIG_DIR for seed/relay, matching the worker (adapter-forced dataDir)', () => {
    // worker.ts spawns seed/relay with spawnEnv={CLAUDE_CONFIG_DIR: <adapter dataDir>},
    // overriding any inherited env — so the transcript is ALWAYS under the package
    // .claude-runtime. The calculator must read that same root, not the daemon's env,
    // else usage reads diverge from where the CLI actually wrote.
    process.env.CLAUDE_CONFIG_DIR = '/explicit/config-dir';
    setupJsonl(assistantLine({ input: 10, output: 5 }));
    try {
      getSessionTokenUsage({ cliId: 'seed', sessionId: 's1', cwd: '/tmp', fresh: true });
      const readPaths = vi.mocked(readFileSync).mock.calls.map((c) => String(c[0]));
      expect(readPaths.some((p) => p.startsWith(`${FORK_DATA_DIR}/projects/`))).toBe(true);
      expect(readPaths.every((p) => !p.startsWith('/explicit/config-dir/'))).toBe(true);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('reports Codex token_count totals without double-counting cached input', () => {
    vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue('codex-sid');
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue('/home/testuser/.codex/sessions/rollout-codex-sid.jsonl');
    setupJsonl([
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 100,
              cached_input_tokens: 40,
              output_tokens: 20,
            },
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 150,
              cached_input_tokens: 60,
              output_tokens: 30,
            },
          },
        },
      }),
    ].join('\n'));

    expect(getSessionTokenUsage({
      cliId: 'codex',
      sessionId: 'botmux-sid',
    })).toEqual({
      in: 150,
      out: 30,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 60,
      cacheCreateTokens: 0,
      turns: 0,
      model: '',
    });
    expect(findCodexSessionIdByBotmuxSessionId).toHaveBeenCalledWith('botmux-sid');
    expect(findCodexRolloutBySessionId).toHaveBeenCalledWith('codex-sid');
  });

  it('reports TraeX rollouts via the codex fold, capturing the turn_context model', () => {
    vi.mocked(findTraexRolloutBySessionId).mockReturnValue('/home/testuser/.trae/cli/sessions/2026/06/30/rollout-traex-sid.jsonl');
    // Real TRAE rollout shapes: codex-format turn_context carries the model;
    // token_count carries cumulative totals. Under the old 'generic' fold the
    // model was never read and records shipped with model "".
    setupJsonl([
      JSON.stringify({
        type: 'turn_context',
        payload: { turn_id: 't-1', model: 'openrouter-1', model_provider: 'trae' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 52634,
              cached_input_tokens: 0,
              output_tokens: 307,
            },
          },
        },
      }),
    ].join('\n'));

    expect(getSessionTokenUsage({
      cliId: 'traex',
      sessionId: 'botmux-sid',
      cliSessionId: 'traex-sid',
    })).toEqual({
      in: 52634,
      out: 307,
      inputTokens: 52634,
      outputTokens: 307,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      turns: 0,
      model: 'openrouter-1',
    });
    expect(findTraexRolloutBySessionId).toHaveBeenCalledWith('traex-sid');
  });

  it('reports CoCo nested response_meta usage without counting agent_end duplicates', () => {
    setupJsonl([
      JSON.stringify({
        message: {
          message: {
            role: 'assistant',
            response_meta: {
              finish_reason: 'tool_calls',
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            },
            extra: { _source_model: 'openrouter-2o' },
          },
        },
      }),
      JSON.stringify({
        agent_end: {
          output: {
            response_meta: {
              usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
            },
          },
        },
      }),
      JSON.stringify({
        message: {
          message: {
            role: 'assistant',
            response_meta: {
              finish_reason: 'stop',
              usage: { prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 },
            },
            extra: { _source_model: 'openrouter-2o' },
          },
        },
      }),
    ].join('\n'));

    expect(getSessionTokenUsage({
      cliId: 'coco',
      sessionId: 'coco-sid',
    })).toEqual({
      in: 300,
      out: 40,
      inputTokens: 300,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'openrouter-2o',
    });
  });

  it('reports Aiden checkpoint usage_metadata without double-counting cache read', () => {
    vi.mocked(findAidenLatestCheckpointBySessionId).mockReturnValue('/home/testuser/.aiden/checkpoints/ws/aiden-sid/latest-checkpoint.json');
    setupJsonl(JSON.stringify({
      checkpoint: {
        channel_values: {
          messages: [
            {
              type: 'human',
              content: 'hello',
            },
            {
              type: 'ai',
              response_metadata: { model_name: 'aiden-model' },
              usage_metadata: {
                input_tokens: 100,
                output_tokens: 20,
                total_tokens: 120,
                input_token_details: { cache_read: 40 },
              },
            },
            {
              type: 'ai',
              usage_metadata: {
                input_tokens: 150,
                output_tokens: 30,
                total_tokens: 180,
                input_token_details: { cache_read: 60 },
              },
            },
          ],
        },
      },
    }));

    expect(getSessionTokenUsage({
      cliId: 'aiden',
      sessionId: 'aiden-sid',
    })).toEqual({
      in: 250,
      out: 50,
      inputTokens: 250,
      outputTokens: 50,
      cacheReadTokens: 100,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'aiden-model',
    });
    expect(findAidenLatestCheckpointBySessionId).toHaveBeenCalledWith('aiden-sid', undefined, undefined);
  });

  it('Aiden skips human/tool messages even when they carry usage metadata', () => {
    vi.mocked(findAidenLatestCheckpointBySessionId).mockReturnValue('/home/testuser/.aiden/checkpoints/ws/aiden-sid/checkpoint.json');
    setupJsonl(JSON.stringify({
      checkpoint: {
        channel_values: {
          messages: [
            { type: 'human', content: 'hi', usage_metadata: { input_tokens: 999, output_tokens: 999 } },
            { type: 'tool', content: 'result', usage_metadata: { input_tokens: 888, output_tokens: 888 } },
            { type: 'ai', usage_metadata: { input_tokens: 100, output_tokens: 20 } },
          ],
        },
      },
    }));

    expect(getSessionTokenUsage({ cliId: 'aiden', sessionId: 'aiden-sid' })).toEqual({
      in: 100,
      out: 20,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      turns: 1,
      model: '',
    });
  });

  it('falls back to locating Aiden checkpoint by botmux session id', () => {
    vi.mocked(findAidenLatestCheckpointByBotmuxSessionId).mockReturnValue('/home/testuser/.aiden/checkpoints/ws/native-sid/checkpoint.json');
    setupJsonl(JSON.stringify({
      checkpoint: {
        channel_values: {
          messages: [
            { type: 'ai', usage_metadata: { input_tokens: 10, output_tokens: 5 } },
          ],
        },
      },
    }));

    expect(getSessionTokenUsage({
      cliId: 'aiden',
      sessionId: 'botmux-sid',
      cwd: '/workspace/current',
    })?.in).toBe(10);
    expect(findAidenLatestCheckpointBySessionId).toHaveBeenCalledWith('botmux-sid', undefined, '/workspace/current');
    expect(findAidenLatestCheckpointByBotmuxSessionId).toHaveBeenCalledWith('botmux-sid', undefined, '/workspace/current');
  });

  it('Codex only counts token_count snapshots and picks up the rollout model', () => {
    vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue('codex-sid');
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue('/home/testuser/.codex/sessions/rollout-codex-sid.jsonl');
    setupJsonl([
      // Should provide model: turn_context carries the active model.
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.3-codex' } }),
      // Should NOT count: a stray assistant-message-shaped line in the rollout.
      JSON.stringify({ type: 'response_item', message: { usage: { input_tokens: 999, output_tokens: 999 } } }),
      // Should count (latest snapshot wins): cumulative token_count events.
      JSON.stringify({
        type: 'event_msg',
        payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 150, cached_input_tokens: 60, output_tokens: 30 } } },
      }),
    ].join('\n'));

    expect(getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' })).toEqual({
      in: 150,
      out: 30,
      inputTokens: 150,
      outputTokens: 30,
      cacheReadTokens: 60,
      cacheCreateTokens: 0,
      turns: 0,
      model: 'gpt-5.3-codex',
    });
  });

  it('CoCo only counts assistant response_meta usage, not stray usage-shaped lines', () => {
    setupJsonl([
      // Should count: assistant message with response_meta.usage.
      JSON.stringify({
        message: {
          message: {
            role: 'assistant',
            response_meta: { usage: { prompt_tokens: 100, completion_tokens: 10 } },
            extra: { _source_model: 'openrouter-2o' },
          },
        },
      }),
      // Should NOT count: telemetry-style event with payload.usage.
      JSON.stringify({ payload: { usage: { prompt_tokens: 999, completion_tokens: 999 } } }),
      // Should NOT count: top-level usage on a non-message event.
      JSON.stringify({ usage: { prompt_tokens: 888, completion_tokens: 888 } }),
      // Should NOT count: tool-role message carrying usage.
      JSON.stringify({
        message: {
          message: {
            role: 'tool',
            response_meta: { usage: { prompt_tokens: 777, completion_tokens: 777 } },
          },
        },
      }),
    ].join('\n'));

    expect(getSessionTokenUsage({ cliId: 'coco', sessionId: 'coco-sid' })).toEqual({
      in: 100,
      out: 10,
      inputTokens: 100,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      turns: 1,
      model: 'openrouter-2o',
    });
  });

  it('getSessionCost shares the message.id dedup with getSessionTokenUsage', () => {
    const block = (id: string, input: number, output: number) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          model: 'claude-sonnet-4-20250514',
          usage: { input_tokens: input, output_tokens: output },
        },
      });
    setupJsonl([block('msg_a', 100, 50), block('msg_a', 100, 50), block('msg_b', 200, 80)].join('\n'));

    expect(getSessionCost('s1', '/tmp')).toEqual({
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 0,
      cacheCreateTokens: 0,
      turns: 2,
      model: 'claude-sonnet-4-20250514',
    });
  });

  it('caches codex rollout path resolution across calls', () => {
    vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue('codex-sid');
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue('/home/testuser/.codex/sessions/rollout-codex-sid.jsonl');
    setupJsonl(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 1, output_tokens: 1 } } },
    }));

    getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' });
    getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' });

    expect(findCodexSessionIdByBotmuxSessionId).toHaveBeenCalledTimes(1);
    expect(findCodexRolloutBySessionId).toHaveBeenCalledTimes(1);
  });

  it('retries a missed codex path lookup only after the retry window', () => {
    vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue(undefined);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(undefined);
    const nowSpy = vi.spyOn(Date, 'now');
    try {
      nowSpy.mockReturnValue(1_000_000);
      expect(getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' })).toBeNull();
      expect(getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' })).toBeNull();
      expect(findCodexRolloutBySessionId).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(1_000_000 + 31_000);
      expect(getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' })).toBeNull();
      expect(findCodexRolloutBySessionId).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('fresh lookups bypass a cached codex path miss', () => {
    vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue(undefined);
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue(undefined);
    expect(getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' })).toBeNull(); // miss now cached

    // The rollout appears moments later (transcripts are created lazily).
    vi.mocked(findCodexSessionIdByBotmuxSessionId).mockReturnValue('codex-sid');
    vi.mocked(findCodexRolloutBySessionId).mockReturnValue('/home/testuser/.codex/sessions/rollout-codex-sid.jsonl');
    setupJsonl(JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 42, output_tokens: 7 } } },
    }));

    // The dashboard path keeps the negative cache…
    expect(getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid' })).toBeNull();
    // …but a fresh (ledger) read must see the newly created transcript.
    expect(getSessionTokenUsage({ cliId: 'codex', sessionId: 'botmux-sid', fresh: true })).toMatchObject({
      in: 42,
      out: 7,
    });
  });

  it('caches the aiden checkpoint lookup briefly', () => {
    vi.mocked(findAidenLatestCheckpointBySessionId).mockReturnValue('/home/testuser/.aiden/checkpoints/ws/aiden-sid/checkpoint.json');
    setupJsonl(JSON.stringify({
      checkpoint: { channel_values: { messages: [{ type: 'ai', usage_metadata: { input_tokens: 1, output_tokens: 1 } }] } },
    }));

    getSessionTokenUsage({ cliId: 'aiden', sessionId: 'aiden-sid' });
    getSessionTokenUsage({ cliId: 'aiden', sessionId: 'aiden-sid' });

    expect(findAidenLatestCheckpointBySessionId).toHaveBeenCalledTimes(1);
  });

  it('fresh aiden lookups bypass the positive hit TTL (checkpoints move per turn)', () => {
    vi.mocked(findAidenLatestCheckpointBySessionId).mockReturnValue('/home/testuser/.aiden/checkpoints/ws/aiden-sid/cp-1.json');
    setupJsonl(JSON.stringify({
      checkpoint: { channel_values: { messages: [{ type: 'ai', usage_metadata: { input_tokens: 1, output_tokens: 1 } }] } },
    }));

    getSessionTokenUsage({ cliId: 'aiden', sessionId: 'aiden-sid' });
    expect(findAidenLatestCheckpointBySessionId).toHaveBeenCalledTimes(1);

    // Ledger (fresh) reads must re-resolve: latest.json points at a NEW
    // checkpoint file every turn, and a 15s-stale path misses the last turn.
    getSessionTokenUsage({ cliId: 'aiden', sessionId: 'aiden-sid', fresh: true });
    expect(findAidenLatestCheckpointBySessionId).toHaveBeenCalledTimes(2);

    // The dashboard (non-fresh) path keeps the TTL cache.
    getSessionTokenUsage({ cliId: 'aiden', sessionId: 'aiden-sid' });
    expect(findAidenLatestCheckpointBySessionId).toHaveBeenCalledTimes(2);
  });

  it('counts a multi-block Claude turn (same message.id) once', () => {
    const block = (id: string, input: number, output: number, cacheRead = 0, cacheCreate = 0) =>
      JSON.stringify({
        type: 'assistant',
        message: {
          id,
          model: 'claude-sonnet-4-20250514',
          usage: {
            input_tokens: input,
            output_tokens: output,
            cache_read_input_tokens: cacheRead,
            cache_creation_input_tokens: cacheCreate,
          },
        },
      });
    // A text block and a tool_use block of the same turn are written as two
    // JSONL lines sharing one message.id and one usage snapshot — count once.
    setupJsonl([
      block('msg_a', 100, 50, 10, 5),
      block('msg_a', 100, 50, 10, 5),
      block('msg_b', 200, 80),
    ].join('\n'));

    expect(getSessionTokenUsage({
      cliId: 'claude-code',
      sessionId: 's1',
      cwd: '/tmp',
    })).toEqual({
      in: 315,
      out: 130,
      inputTokens: 300,
      outputTokens: 130,
      cacheReadTokens: 10,
      cacheCreateTokens: 5,
      turns: 2,
      model: 'claude-sonnet-4-20250514',
    });
  });
});

// ── formatNumber ────────────────────────────────────────────────────────

describe('formatNumber', () => {
  it('formats small numbers without commas', () => {
    expect(formatNumber(42)).toBe('42');
  });

  it('formats thousands with commas', () => {
    expect(formatNumber(1_234)).toBe('1,234');
  });

  it('formats millions with commas', () => {
    expect(formatNumber(1_234_567)).toBe('1,234,567');
  });

  it('formats zero', () => {
    expect(formatNumber(0)).toBe('0');
  });
});
