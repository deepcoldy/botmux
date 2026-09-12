import { describe, expect, it } from 'vitest';
import {
  formatStoreHoldMessage,
  formatUnmigratedMessage,
  SESSION_STORE_WRITE_BLOCKED,
  UNMIGRATED_OPERATOR_HINT,
} from '../src/services/session-store-copy.js';

describe('session-store-copy', () => {
  it('gives operators a restart instruction and session processes only a status', () => {
    expect(formatUnmigratedMessage()).toBe(UNMIGRATED_OPERATOR_HINT);
    expect(formatUnmigratedMessage({ sessionScoped: true })).not.toContain('botmux restart');
    expect(formatStoreHoldMessage('legacy_daemon')).toContain('botmux restart');
    expect(formatStoreHoldMessage('legacy_daemon', { sessionScoped: true })).toBe(SESSION_STORE_WRITE_BLOCKED);
    expect(formatStoreHoldMessage('lease', { sessionScoped: true })).not.toMatch(/pid|port|v\d+\.\d+/);
  });
});
