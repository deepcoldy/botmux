/**
 * E2E test: writeInput behavior across ALL CLI adapters.
 *
 * Tests each adapter with a mock PTY recorder to verify the exact write
 * sequences for various input scenarios:
 * - Single-line text (no newlines)
 * - Multi-line text (with newlines)
 * - Content with image paths (may need extra delay)
 * - Multi-line with image paths (combined)
 *
 * Bug context: Aiden multi-line messages get stuck in the input box because
 * the adapter writes raw \n without bracketed paste mode — the TUI
 * interprets \n as Enter keystrokes instead of pasted content.
 *
 * Run:  pnpm vitest run test/write-input-all-cli.e2e.ts
 */
import { describe, it, expect } from 'vitest';
import type { PtyHandle } from '../src/adapters/cli/types.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createAidenAdapter } from '../src/adapters/cli/aiden.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import { createMtrAdapter } from '../src/adapters/cli/mtr.js';
import { createHermesAdapter } from '../src/adapters/cli/hermes.js';
import { createMiraAdapter } from '../src/adapters/cli/mira.js';
import { createCopilotAdapter } from '../src/adapters/cli/copilot.js';
import { createOhMyPiAdapter } from '../src/adapters/cli/oh-my-pi.js';

// ─── Mock PTY recorder ──────────────────────────────────────────────────────

interface WriteRecord {
  data: string;
  timestamp: number;
}

function createMockPty(): PtyHandle & { writes: WriteRecord[]; dump(): string } {
  const writes: WriteRecord[] = [];
  return {
    writes,
    write(data: string) {
      writes.push({ data, timestamp: Date.now() });
    },
    /** Human-readable dump of all writes with timing */
    dump() {
      if (writes.length === 0) return '(no writes)';
      const t0 = writes[0].timestamp;
      return writes.map((w, i) => {
        const delta = i === 0 ? 0 : w.timestamp - writes[i - 1].timestamp;
        const repr = JSON.stringify(w.data)
          .replace(/\\u001b/g, '\\x1b');  // nicer ESC display
        return `  [${i}] +${delta}ms ${repr}`;
      }).join('\n');
    },
  };
}

// ─── Bracketed paste helpers ─────────────────────────────────────────────────

const BRACKET_OPEN = '\x1b[200~';
const BRACKET_CLOSE = '\x1b[201~';

function hasBracketedPaste(writes: WriteRecord[]): boolean {
  const all = writes.map(w => w.data).join('');
  return all.includes(BRACKET_OPEN) && all.includes(BRACKET_CLOSE);
}

function endsWithCR(writes: WriteRecord[]): boolean {
  if (writes.length === 0) return false;
  const last = writes[writes.length - 1].data;
  return last === '\r' || last.endsWith('\r');
}

function hasDelayBetween(writes: WriteRecord[], minMs: number): boolean {
  for (let i = 1; i < writes.length; i++) {
    const delta = writes[i].timestamp - writes[i - 1].timestamp;
    if (delta >= minMs) return true;
  }
  return false;
}

// ─── Test fixtures ──────────────────────────────────────────────────────────

const SINGLE_LINE = 'hello world';
const MULTI_LINE = 'hello\n你好';
const SINGLE_LINE_WITH_IMAGE = '看这个 /tmp/test.png';
const MULTI_LINE_WITH_IMAGE = '看这个\n\n附件（使用 Read 工具查看）：\n- /tmp/attachments/img_v3_abc.jpg';
const LONG_MULTI_LINE = `用户发送了：
---
hello
你好
---

Session ID: df5a8828-c99d-4ff5-b4cb-8886b4555f9e`;

const SCENARIOS = [
  { name: 'single-line', content: SINGLE_LINE, hasNewline: false, hasImage: false },
  { name: 'multi-line', content: MULTI_LINE, hasNewline: true, hasImage: false },
  { name: 'single-line + image', content: SINGLE_LINE_WITH_IMAGE, hasNewline: false, hasImage: true },
  { name: 'multi-line + image', content: MULTI_LINE_WITH_IMAGE, hasNewline: true, hasImage: true },
  { name: 'long multi-line (prompt)', content: LONG_MULTI_LINE, hasNewline: true, hasImage: false },
] as const;

// ─── Adapter factories ──────────────────────────────────────────────────────

// Use try/catch for resolveCommand — CLIs may not be installed
function safeCreate<T>(fn: () => T): T | null {
  try { return fn(); } catch { return null; }
}

const ADAPTERS = [
  { name: 'claude-code', create: () => safeCreate(() => createClaudeCodeAdapter()) },
  { name: 'aiden', create: () => safeCreate(() => createAidenAdapter()) },
  { name: 'coco', create: () => safeCreate(() => createCocoAdapter()) },
  { name: 'codex', create: () => safeCreate(() => createCodexAdapter()) },
  { name: 'gemini', create: () => safeCreate(() => createGeminiAdapter()) },
  { name: 'opencode', create: () => safeCreate(() => createOpenCodeAdapter()) },
  { name: 'mtr', create: () => safeCreate(() => createMtrAdapter()) },
  { name: 'hermes', create: () => safeCreate(() => createHermesAdapter()) },
  { name: 'mira', create: () => safeCreate(() => createMiraAdapter()) },
  { name: 'copilot', create: () => safeCreate(() => createCopilotAdapter()) },
  { name: 'oh-my-pi', create: () => safeCreate(() => createOhMyPiAdapter()) },
];

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('writeInput: write sequence verification (all CLIs × all scenarios)', () => {
  for (const adapterDef of ADAPTERS) {
    describe(adapterDef.name, () => {
      const adapter = adapterDef.create();
      if (!adapter) {
        it.skip(`${adapterDef.name} not installed`, () => {});
        return;
      }

      for (const scenario of SCENARIOS) {
        it(`${scenario.name}: ends with CR (Enter) to submit`, async () => {
          const pty = createMockPty();
          await adapter.writeInput(pty, scenario.content);

          console.log(`\n[${adapterDef.name}] ${scenario.name}:\n${pty.dump()}`);

          expect(
            endsWithCR(pty.writes),
            `${adapterDef.name} ${scenario.name}: last write must end with \\r`,
          ).toBe(true);
        });

        if (scenario.hasNewline) {
          it(`${scenario.name}: multi-line uses bracketed paste OR delay+CR`, async () => {
            const pty = createMockPty();
            await adapter.writeInput(pty, scenario.content);

            const usesBracket = hasBracketedPaste(pty.writes);
            const usesDelay = hasDelayBetween(pty.writes, 100);

            console.log(`\n[${adapterDef.name}] ${scenario.name} multi-line strategy:`);
            console.log(`  bracketed paste: ${usesBracket}`);
            console.log(`  has delay (>=100ms): ${usesDelay}`);
            console.log(pty.dump());

            // Multi-line MUST use some strategy to avoid \n being treated as Enter
            expect(
              usesBracket || usesDelay,
              `${adapterDef.name}: multi-line needs bracketed paste or delay before CR`,
            ).toBe(true);
          });
        }
      }
    });
  }
});

describe('writeInput: multi-line raw \\n safety', () => {
  /**
   * Core issue: if multi-line content is written as-is (with literal \n),
   * TUI frameworks may interpret each \n as an Enter keystroke, causing:
   * - Partial submission of the first line
   * - Content stuck in multi-line edit mode without submitting
   *
   * The safest strategy is bracketed paste (\x1b[200~...\x1b[201~) which
   * tells the terminal to treat the entire block as a paste (no Enter).
   */
  for (const adapterDef of ADAPTERS) {
    const adapter = adapterDef.create();
    if (!adapter) continue;

    it(`${adapterDef.name}: multi-line content is NOT written as raw text + immediate CR`, async () => {
      const pty = createMockPty();
      await adapter.writeInput(pty, MULTI_LINE);

      // Bad pattern: write("hello\n你好\r") — \n triggers premature Enter
      const firstWrite = pty.writes[0]?.data ?? '';
      const rawMultiLineWithCR = firstWrite.includes('\n') && firstWrite.endsWith('\r');

      if (rawMultiLineWithCR && !firstWrite.startsWith(BRACKET_OPEN)) {
        console.warn(
          `⚠️  [${adapterDef.name}] BAD: writes raw multi-line + \\r in one call. ` +
          `\\n in content will be interpreted as Enter by the TUI.`,
        );
      }

      console.log(`[${adapterDef.name}] multi-line first write: ${JSON.stringify(firstWrite).slice(0, 120)}`);

      // Either use bracketed paste, or split content from CR
      const usesProtection = hasBracketedPaste(pty.writes)
        || !rawMultiLineWithCR;

      expect(
        usesProtection,
        `${adapterDef.name}: multi-line must not write raw \\n + \\r without bracketed paste`,
      ).toBe(true);
    });
  }
});

describe('writeInput: image path delay', () => {
  /**
   * Claude Code needs extra delay (800ms) for image paths in content,
   * because it triggers async image attachment detection. Other CLIs
   * may not need this, but it shouldn't break them.
   */
  for (const adapterDef of ADAPTERS) {
    const adapter = adapterDef.create();
    if (!adapter) continue;

    it(`${adapterDef.name}: image path content is handled without error`, async () => {
      const pty = createMockPty();
      // Should not throw
      await adapter.writeInput(pty, MULTI_LINE_WITH_IMAGE);

      console.log(`[${adapterDef.name}] image content writes: ${pty.writes.length}`);
      console.log(pty.dump());

      expect(endsWithCR(pty.writes)).toBe(true);
    });
  }
});

describe('writeInput: timing analysis', () => {
  /**
   * Documents the exact timing of writes for each adapter.
   * This is not a pass/fail test — it's a diagnostic to compare behaviors.
   */
  for (const adapterDef of ADAPTERS) {
    const adapter = adapterDef.create();
    if (!adapter) continue;

    it(`${adapterDef.name}: timing report`, async () => {
      const results: Array<{ scenario: string; writes: number; totalMs: number; strategy: string }> = [];

      for (const scenario of SCENARIOS) {
        const pty = createMockPty();
        await adapter.writeInput(pty, scenario.content);

        const totalMs = pty.writes.length > 1
          ? pty.writes[pty.writes.length - 1].timestamp - pty.writes[0].timestamp
          : 0;

        const strategy = hasBracketedPaste(pty.writes) ? 'bracketed-paste'
          : pty.writes.length === 1 ? 'single-write'
          : 'split-write+delay';

        results.push({
          scenario: scenario.name,
          writes: pty.writes.length,
          totalMs,
          strategy,
        });
      }

      console.log(`\n=== ${adapterDef.name} timing report ===`);
      for (const r of results) {
        console.log(`  ${r.scenario.padEnd(28)} writes=${r.writes} total=${r.totalMs}ms strategy=${r.strategy}`);
      }
    });
  }
});
