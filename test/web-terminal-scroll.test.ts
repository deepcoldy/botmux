import { describe, expect, it } from 'bun:test';
import { parseReadOnlyRemoteScrollPayload } from '../src/utils/web-terminal-scroll.js';

describe('read-only web terminal remote scroll payloads', () => {
  it('parses one SGR wheel-up event', () => {
    expect(parseReadOnlyRemoteScrollPayload('\x1b[<64;12;8M')).toEqual({
      direction: 'up',
      eventCount: 1,
    });
  });

  it('parses a capped same-direction wheel burst', () => {
    const payload = '\x1b[<65;12;8M'.repeat(6);

    expect(parseReadOnlyRemoteScrollPayload(payload)).toEqual({
      direction: 'down',
      eventCount: 6,
    });
  });

  it('rejects unbounded or non-wheel payloads', () => {
    expect(parseReadOnlyRemoteScrollPayload('\x1b[<64;12;8M'.repeat(7))).toBeNull();
    expect(parseReadOnlyRemoteScrollPayload('\x1b[<64;12;8M\x1b[<65;12;8M')).toBeNull();
    expect(parseReadOnlyRemoteScrollPayload('\x1b[<0;12;8M')).toBeNull();
    expect(parseReadOnlyRemoteScrollPayload('x\x1b[<64;12;8M')).toBeNull();
    expect(parseReadOnlyRemoteScrollPayload('\x1b[<64;12;8Mx')).toBeNull();
    expect(parseReadOnlyRemoteScrollPayload('\x1b[<64;0;8M')).toBeNull();
    expect(parseReadOnlyRemoteScrollPayload('\x1b[<64;10000;8M')).toBeNull();
  });
});
