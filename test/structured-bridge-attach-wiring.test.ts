/**
 * Cursor attach baselines in worker.ts (codexBridgeAttach / cursorBridgeAttach).
 *
 * The worker cannot be imported without starting its IPC loop, and the attach
 * flow lives in its module closure. The baseline algorithm itself is covered
 * behaviourally in cursor-transcript.test.ts; per-CLI bridge parameters are
 * covered in structured-bridge-spec.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');

/** Body of a top-level `function name(` up to the next top-level declaration. */
function topLevelFunction(name: string): string {
  const start = source.indexOf(`\nfunction ${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  const next = /\n(?:export )?(?:async )?(?:function|type|interface|class|const|let) /g;
  next.lastIndex = start + 1;
  const end = next.exec(source)?.index ?? source.length;
  return source.slice(start, end);
}

describe('cursor attach baseline is footer-aware', () => {
  // 源码结构护栏(K3)：cursor-agent 每轮在 transcript 尾部追加 turn_ended footer，下一轮先截掉它再从
  // 原位置重写。attach 基线若停在 footer 之后（EOF / stat size / baselineJsonlCursor），attach 后第一轮
  // 的 user 行会被切成残片、指纹归因失败，这一轮的回复就发不出去（#2009，7b4c83ed47）。
  // codexBridgeAttach 在 worker 闭包里没有 seam，只能在源码里核对 cursor 的两条基线
  // （adopt 的 skip-tail、零注入 resume 的 baseline-existing）都取自 baselineCursorTranscript 快照。
  it('both cursor baselines (adopt skip-tail and zero-prompt resume) come from the footer-aware snapshot', () => {
    const attach = topLevelFunction('codexBridgeAttach');
    expect(attach).toMatch(/baselineCursorTranscript\([^)]*skipTail:\s*true/);
    expect(attach.match(/baselineCursorTranscript\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    // Adopt reaches the skip-tail branch only through cursorBridgeAttach's mode mapping.
    expect(topLevelFunction('cursorBridgeAttach')).toContain("'baseline-existing-skip-tail'");
  });
});
