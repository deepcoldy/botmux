import { describe, expect, it } from 'vitest';
import { unknownFleetArgs } from '../src/cli/fleet-args.js';

describe('root fleet option parser', () => {
  const restart = { boolFlags: ['--with-plugin'], valueFlags: ['--companion-secret-file', '--companion-bot'] };

  it('accepts companion options in the actual restart parser, including equals form', () => {
    expect(unknownFleetArgs([
      '--with-plugin', '--companion-secret-file', '/run/secrets/companion', '--companion-bot', 'local_test_bot',
    ], restart)).toEqual([]);
    expect(unknownFleetArgs([
      '--companion-secret-file=/run/secrets/companion', '--companion-bot=local_test_bot',
    ], restart)).toEqual([]);
  });

  it('rejects missing values and unrelated arguments', () => {
    expect(unknownFleetArgs(['--companion-secret-file'], restart)).toEqual(['--companion-secret-file']);
    expect(unknownFleetArgs(['--companion-bot', '--with-plugin'], restart)).toEqual(['--companion-bot']);
    expect(unknownFleetArgs(['--unknown'], restart)).toEqual(['--unknown']);
  });
});
