import { describe, expect, it } from 'vitest';
import xtermHeadless from '@xterm/headless';
import {
  mergeHerdrWebSnapshot,
  renderHerdrWebHistory,
  type HerdrWebHistoryState,
} from '../src/utils/herdr-web-history.js';

const { Terminal } = xtermHeadless;

function write(term: InstanceType<typeof Terminal>, data: string): Promise<void> {
  return new Promise(resolve => term.write(data, resolve));
}

function snapshot(lines: string[]): string {
  return lines.map((line, index) => `\x1b[3${index % 8}m${line}\x1b[0m`).join('\r\n') + '\r\n';
}

describe('Herdr web snapshot history', () => {
  it('prepends only newly revealed rows when an upward page overlaps the old frame', () => {
    const initial = mergeHerdrWebSnapshot(null, snapshot(['A', 'B', 'C', 'D', 'E', 'FOOTER']), null);
    const next = mergeHerdrWebSnapshot(
      initial.state,
      snapshot(['X', 'Y', 'A', 'B', 'C', 'FOOTER']),
      'up',
    );

    expect(next.addedLines).toBe(2);
    expect(next.state.history.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')))
      .toEqual(['X', 'Y', 'A', 'B', 'C', 'D', 'E', 'FOOTER']);
  });

  it('keeps fixed TUI chrome while inserting newly revealed rows into the scroll region', () => {
    const initial = mergeHerdrWebSnapshot(
      null,
      snapshot(['HEADER', 'A', 'B', 'C', 'FOOTER']),
      null,
    );
    const next = mergeHerdrWebSnapshot(
      initial.state,
      snapshot(['HEADER', 'X', 'A', 'B', 'FOOTER']),
      'up',
    );

    expect(next.addedLines).toBe(1);
    expect(next.state.history.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')))
      .toEqual(['HEADER', 'X', 'A', 'B', 'C', 'FOOTER']);
  });

  it('handles repeated rows without choosing an ambiguous quadratic overlap', () => {
    const initial = mergeHerdrWebSnapshot(
      null,
      snapshot(['HEADER', 'ROW', 'ROW', 'A', 'B', 'FOOTER']),
      null,
    );
    const next = mergeHerdrWebSnapshot(
      initial.state,
      snapshot(['HEADER', 'X', 'ROW', 'ROW', 'A', 'FOOTER']),
      'up',
    );

    expect(next.addedLines).toBe(1);
    expect(next.state.history.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')))
      .toEqual(['HEADER', 'X', 'ROW', 'ROW', 'A', 'B', 'FOOTER']);
  });

  it('merges a 10k-line snapshot in bounded linear time', () => {
    const previous = Array.from({ length: 10_000 }, (_, index) => `LINE-${index}`);
    const initial = mergeHerdrWebSnapshot(null, snapshot(previous), null);
    const started = performance.now();
    const next = mergeHerdrWebSnapshot(
      initial.state,
      snapshot(['OLDER', ...previous.slice(0, -1)]),
      'up',
    );

    expect(performance.now() - started).toBeLessThan(500);
    expect(next.addedLines).toBe(1);
    expect(next.state.history).toHaveLength(10_001);
  });

  it('replaces rather than appends when a live frame has no paging direction', () => {
    const initial = mergeHerdrWebSnapshot(null, snapshot(['A', 'B', 'STATUS old']), null);
    const live = mergeHerdrWebSnapshot(initial.state, snapshot(['A', 'B', 'STATUS new']), null);

    expect(live.addedLines).toBe(0);
    expect(live.state.history.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')))
      .toEqual(['A', 'B', 'STATUS new']);
  });

  it('falls back to the new frame when overlap is too weak to merge safely', () => {
    const state: HerdrWebHistoryState = {
      history: ['A', 'B', 'C'],
      frame: ['A', 'B', 'C'],
    };
    const next = mergeHerdrWebSnapshot(state, snapshot(['UNRELATED', 'SCREEN']), 'up');

    expect(next.addedLines).toBe(0);
    expect(next.state.history.map(line => line.replace(/\x1b\[[0-9;]*m/g, '')))
      .toEqual(['UNRELATED', 'SCREEN']);
  });

  it('bounds accumulated history and reports only prepended rows that remain', () => {
    const initial = mergeHerdrWebSnapshot(null, 'A\r\nB\r\nC', null, 10);
    const next = mergeHerdrWebSnapshot(initial.state, 'X\r\nY\r\nA\r\nB', 'up', 10);

    expect(renderHerdrWebHistory(next.state)).toBe('Y\r\nA\r\nB\r\nC');
    expect(next.addedLines).toBe(1);
  });

  it('rebuilds xterm scrollback instead of appending the merged history to the old frame', async () => {
    const initial = mergeHerdrWebSnapshot(null, snapshot(['A', 'B', 'C', 'D', 'E', 'FOOTER']), null);
    const merged = mergeHerdrWebSnapshot(
      initial.state,
      snapshot(['X', 'Y', 'A', 'B', 'C', 'FOOTER']),
      'up',
    );
    const term = new Terminal({ cols: 40, rows: 6, scrollback: 100, allowProposedApi: true });
    await write(term, renderHerdrWebHistory(initial.state));

    term.reset();
    term.clear();
    await write(term, `\x1b[2J\x1b[H${renderHerdrWebHistory(merged.state)}`);

    expect(term.buffer.normal.length).toBe(8);
    expect(term.buffer.normal.baseY).toBe(2);
    term.dispose();
  });
});
