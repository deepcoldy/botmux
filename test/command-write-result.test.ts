import { describe, expect, it } from 'vitest';
import {
  assertCommandWriteIssued,
  commandWriteMayHavePartialInput,
  CommandWriteDroppedError,
} from '../src/services/command-write-result.js';

describe('assertCommandWriteIssued', () => {
  it.each([undefined, true])('accepts an issued/unknown backend result: %s', result => {
    expect(() => assertCommandWriteIssued(result, 'command Enter', true)).not.toThrow();
  });

  it('promotes an explicit dropped Enter into the command failure path', () => {
    expect(() => assertCommandWriteIssued(false, 'command Enter', true))
      .toThrow('command Enter was dropped by the session backend');
  });

  it('distinguishes a fully dropped first text write from a possibly partial command', () => {
    for (const inputMayBePartial of [false, true]) {
      const error = new CommandWriteDroppedError('command text', inputMayBePartial);
      expect(commandWriteMayHavePartialInput(error)).toBe(inputMayBePartial);
    }
    expect(commandWriteMayHavePartialInput(new Error('transport threw'))).toBe(true);
  });
});
