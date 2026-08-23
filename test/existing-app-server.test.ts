import { describe, expect, it } from 'vitest';
import {
  normalizeExistingAppServerConfig,
  normalizeExistingAppServerEndpoint,
} from '../src/core/existing-app-server.js';

describe('existing Codex App Server endpoint validation', () => {
  it.each([
    'unix:///home/testuser/.codex/app-server-control/app-server-control.sock',
    'unix:///tmp/codex.sock',
    'ws://127.0.0.1:9931',
  ])('accepts local endpoint %s', (endpoint) => {
    expect(normalizeExistingAppServerEndpoint(endpoint)).toBe(endpoint);
  });

  it.each([
    'unix://localhost/tmp/codex.sock',
    'unix:///tmp/codex.sock?token=secret',
    'ws://localhost:9931',
    'ws://127.0.0.1:9931/anything',
    'ws://127.0.0.1:9931?token=secret',
    'wss://127.0.0.1:9931',
    'https://127.0.0.1:9931',
    'ws://10.0.0.8:9931',
    'not-a-url',
  ])('rejects non-local or ambiguous endpoint %s', (endpoint) => {
    expect(() => normalizeExistingAppServerEndpoint(endpoint)).toThrow();
  });

  it('requires exactly an endpoint object when the feature is configured', () => {
    expect(normalizeExistingAppServerConfig(undefined)).toBeUndefined();
    expect(normalizeExistingAppServerConfig({
      endpoint: 'unix:///tmp/codex.sock',
    })).toEqual({
      endpoint: 'unix:///tmp/codex.sock',
    });
    expect(() => normalizeExistingAppServerConfig({})).toThrow(/endpoint/);
    expect(() => normalizeExistingAppServerConfig('unix:///tmp/codex.sock')).toThrow(/object/);
  });
});
