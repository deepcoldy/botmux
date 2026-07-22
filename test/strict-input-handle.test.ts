import { describe, expect, it } from 'vitest';
import { strictInputHandle } from '../src/adapters/cli/strict-input-handle.js';
import type { PtyHandle } from '../src/adapters/cli/types.js';

class FakeHandle implements PtyHandle {
  cliPid = 7;
  readonly writes: string[] = [];
  readonly textAttempts: string[] = [];
  readonly keyAttempts: string[][] = [];

  write(data: string): void {
    this.writes.push(data);
  }

  sendText(text: string): boolean {
    this.textAttempts.push(text);
    return false;
  }

  sendSpecialKeys(...keys: string[]): boolean {
    this.keyAttempts.push(keys);
    return false;
  }

  describe(): string {
    return `pid=${this.cliPid}`;
  }
}

describe('strictInputHandle', () => {
  it('turns explicit sendText and sendSpecialKeys rejection into submission errors', () => {
    const raw = new FakeHandle();
    const strict = strictInputHandle(raw);

    expect(() => strict.sendText!('prompt')).toThrow(/rejected sendText/);
    expect(() => strict.sendSpecialKeys!('Enter')).toThrow(/rejected sendSpecialKeys/);
    expect(raw.textAttempts).toEqual(['prompt']);
    expect(raw.keyAttempts).toEqual([['Enter']]);
  });

  it('forwards ordinary methods and properties to the original handle', () => {
    const raw = new FakeHandle();
    const strict = strictInputHandle(raw);

    strict.write('best-effort navigation');
    expect(raw.writes).toEqual(['best-effort navigation']);
    expect(strict.describe()).toBe('pid=7');

    strict.cliPid = 42;
    expect(raw.cliPid).toBe(42);
    expect(strict.cliPid).toBe(42);
  });

  it('returns one stable strict handle for the same backend instance', () => {
    const raw = new FakeHandle();

    expect(strictInputHandle(raw)).toBe(strictInputHandle(raw));
  });
});
