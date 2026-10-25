import { describe, expect, it } from 'vitest';
import { readOrcaTerminalTurn, type OrcaTranscript } from '../src/services/orca-terminal-turn.js';
import type { OrcaTerminalTurn } from '../src/services/orca-runner-store.js';

const pending: OrcaTerminalTurn = { turnId: 'bot-turn', operationId: 'operation', startedAtMs: 100,
  content: 'hello', baselineMessageId: 'old-answer', baselineTurnId: 'old-turn' };
const row = (id: string, role: string, text: string, timestamp = 110) => ({
  id, role, source: 'transcript', timestamp, blocks: [{ type: 'text', text }],
});
const page = (): OrcaTranscript => ({ messages: [row('old-answer', 'assistant', 'old reply', 50),
  row('input', 'user', 'hello'), row('reply', 'assistant', 'new reply')], hasMore: false,
  lifecycle: { state: 'completed', turnId: 'new-turn', timestamp: 120 } });

describe('Orca terminal reply attribution', () => {
  it('requires a matching new input and a newer provider completion', () => {
    expect(readOrcaTerminalTurn(page(), pending)).toMatchObject({ done: true, text: 'new reply' });
    const p = page(); p.lifecycle!.turnId = 'old-turn';
    expect(readOrcaTerminalTurn(p, pending).done).toBe(false);
    delete p.lifecycle;
    expect(readOrcaTerminalTurn(p, pending).done).toBe(false);
  });
  it('does not treat an assistant preamble as completion', () => {
    const p = page(); p.lifecycle!.state = 'working';
    expect(readOrcaTerminalTurn(p, pending)).toMatchObject({ done: false, progress: 'new reply' });
  });
  it('reports a provider interruption without claiming a completed answer', () => {
    const p = page(); p.lifecycle!.state = 'interrupted';
    expect(readOrcaTerminalTurn(p, pending)).toMatchObject({ done: true, failed: expect.any(String) });
  });
  it.each(['different', 'duplicate'])('refuses competing %s input', kind => {
    const p = page(); p.messages.push(row('other', 'user', kind === 'duplicate' ? 'hello' : 'desktop question'));
    expect(() => readOrcaTerminalTurn(p, pending)).toThrow('Concurrent');
  });
  it('refuses an unrelated desktop turn', () => {
    const p = page(); p.messages[1].blocks[0].text = 'desktop';
    expect(() => readOrcaTerminalTurn(p, pending)).toThrow('Concurrent');
  });
  it('refuses lost history boundaries, clipped initial history and scraped replies', () => {
    const p = page(); p.messages.shift();
    expect(() => readOrcaTerminalTurn(p, pending)).toThrow('boundary');
    p.hasMore = true;
    expect(() => readOrcaTerminalTurn(p, { ...pending, baselineMessageId: undefined })).toThrow('boundary');
    const scraped = page(); scraped.messages[2].source = 'scrape';
    expect(() => readOrcaTerminalTurn(scraped, pending)).toThrow('authoritative');
  });
  it('does not mistake old answers or undated lifecycle signals for this submission', () => {
    const p = page(); p.messages.splice(1);
    expect(readOrcaTerminalTurn(p, pending).done).toBe(false);
    const undated = page(); undated.lifecycle!.timestamp = null;
    expect(readOrcaTerminalTurn(undated, pending).done).toBe(false);
  });
});
