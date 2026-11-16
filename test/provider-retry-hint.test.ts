import { describe, expect, it } from 'vitest';
import { parseProviderRetryAtMs, PROVIDER_RETRY_HINT_MAX_AHEAD_MS } from '../src/services/provider-retry-hint.js';

const OBSERVED = Date.parse('2026-11-13T11:08:18.238Z');

describe('parseProviderRetryAtMs', () => {
  it('reads the gateway\'s "earliest account is expected to be available at" (11-13 record text)', () => {
    const text = 'API Error: 503 no eligible upstream account is currently available; the earliest account is '
      + 'expected to be available at 2026-11-13T11:10:16Z. This is a server-side issue, usually temporary — '
      + 'try again in a moment. If it persists, check your inference gateway (gw.example:8080).';
    expect(parseProviderRetryAtMs(text, OBSERVED)).toBe(Date.parse('2026-11-13T11:10:16Z'));
  });

  it.each([
    ['available after 2026-11-13 11:12:00 UTC', '2026-11-13T11:12:00Z'],
    ['quota resets at 2026-11-13T19:10:16+08:00', '2026-11-13T11:10:16Z'],
    ['retry at 2026-11-13T11:09:30.500Z please', '2026-11-13T11:09:30.500Z'],
  ])('reads an absolute time that names its zone: %s', (text, iso) => {
    expect(parseProviderRetryAtMs(text, OBSERVED)).toBe(Date.parse(iso));
  });

  it.each([
    ['Retry-After: 30', 30_000],
    ['{"error":{"retry_after": 12.5}}', 12_500],
    ['please try again in 2 minutes', 120_000],
    ['retry after 45s', 45_000],
    ['retrying in 1500ms', 1_500],
  ])('anchors a relative hint at the failure record: %s', (text, offset) => {
    expect(parseProviderRetryAtMs(text, OBSERVED)).toBe(OBSERVED + offset);
  });

  it('reads an HTTP-date Retry-After', () => {
    expect(parseProviderRetryAtMs('Retry-After: Fri, 13 Nov 2026 11:10:16 GMT', OBSERVED))
      .toBe(Date.parse('2026-11-13T11:10:16Z'));
  });

  it.each([
    ['try again in a moment'],
    ['available at 2026-11-13T11:10:16'],
    ['connection reset by peer'],
    ['HTTP 503 at 2026-11-13T11:10:16Z'],
  ])('names no usable time: %s', text => {
    expect(parseProviderRetryAtMs(text, OBSERVED)).toBeUndefined();
  });

  it('drops a time beyond the hint horizon and keeps the latest of several', () => {
    const far = new Date(OBSERVED + PROVIDER_RETRY_HINT_MAX_AHEAD_MS + 60_000).toISOString();
    expect(parseProviderRetryAtMs(`available at ${far}`, OBSERVED)).toBeUndefined();
    expect(parseProviderRetryAtMs('Retry-After: 20; the earliest account is available at 2026-11-13T11:10:16Z', OBSERVED))
      .toBe(Date.parse('2026-11-13T11:10:16Z'));
  });

  it('ignores anything that is not text', () => {
    expect(parseProviderRetryAtMs(undefined, OBSERVED)).toBeUndefined();
    expect(parseProviderRetryAtMs({ retry_after: 3 }, OBSERVED)).toBeUndefined();
    expect(parseProviderRetryAtMs('Retry-After: 30', Number.NaN)).toBeUndefined();
  });
});
