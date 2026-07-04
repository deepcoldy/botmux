import { describe, it, expect } from 'vitest';
import { scrubSecrets, safeScrubAndTruncate } from '../src/services/insight/scrub.js';

describe('insight scrub', () => {
  it('redacts key=value and spaced KEY = value', () => {
    expect(scrubSecrets('run deploy with token=abc123 done')).toBe('run deploy with token=<redacted> done');
    expect(scrubSecrets('API_KEY = supersecret')).toBe('API_KEY=<redacted>');
    expect(scrubSecrets('password: hunter2')).toBe('password:<redacted>');
  });

  it('redacts --flag value and url query', () => {
    expect(scrubSecrets('pnpm test --token SECRETVAL')).toBe('pnpm test --token <redacted>');
    expect(scrubSecrets('curl https://x.test?sig=abc')).toBe('curl https://x.test?<redacted>');
  });

  it('redacts whole-token secret shapes (sk-, gh*_, github_pat_, JWT)', () => {
    expect(scrubSecrets('here sk-abcdefghijklmnop tail')).toBe('here <redacted> tail');
    expect(scrubSecrets('ghp_0123456789abcdefghij0123456789')).toBe('<redacted>');
    expect(scrubSecrets('gho_0123456789abcdefghij0123456789')).toBe('<redacted>');
    expect(scrubSecrets('github_pat_0123456789abcdefghij_ABCDEFG')).toBe('<redacted>');
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJ';
    expect(scrubSecrets(`auth ${jwt}`)).toBe('auth <redacted>');
  });

  it('redacts the WHOLE value/flag/query even when very long (no tail leak)', () => {
    // Regression: bounding the value capture ({1,256}) left the secret tail in
    // the output. Trailing captures stay unbounded so the whole value is consumed.
    const longVal = 'a'.repeat(300);
    expect(scrubSecrets(`TOKEN=${longVal}`)).toBe('TOKEN=<redacted>');
    expect(scrubSecrets(`api_key=${longVal} trailing`)).toBe('api_key=<redacted> trailing');
    expect(scrubSecrets(`--token ${'b'.repeat(300)}`)).toBe('--token <redacted>');
    expect(scrubSecrets(`https://x.test?${'c'.repeat(600)}`)).toBe('https://x.test?<redacted>');
    // Even through the display-truncation path the tail must never surface.
    const out = safeScrubAndTruncate(`TOKEN=${longVal}`, 40);
    expect(out.text).not.toMatch(/a{3,}/);
    expect(out.text.startsWith('TOKEN=<redacted>')).toBe(true);
  });

  it('is linear (no ReDoS) on keyword-dense input without a separator', () => {
    // Pre-fix this backtracked quadratically (~2.4s on 80KB) and blocked the
    // single-threaded daemon. Bounded quantifiers make it linear; a generous
    // budget here still catches any quadratic regression (which would be seconds).
    const hostile = 'key'.repeat(80_000); // 240KB of pure keyword runs, no '='/':'
    const t0 = Date.now();
    const out = scrubSecrets(hostile);
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(500);
    expect(out.length).toBe(hostile.length); // nothing matched (no separator)
  });

  it('bounds scrubbed/displayed length and flags truncation', () => {
    const long = `${'a'.repeat(50)} token=abc ${'b'.repeat(50)}`;
    const out = safeScrubAndTruncate(long, 20);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(20);
    expect(out.text.endsWith('…')).toBe(true);
  });

  it('still redacts a secret that sits just past the display max (overscan)', () => {
    // max=10 but the secret is at offset ~12; overscan must scrub it before the
    // tail is dropped so it can never surface even within the truncation buffer.
    const raw = `${'x'.repeat(10)} token=topsecret`;
    const out = safeScrubAndTruncate(raw, 4096); // show enough to see the redaction
    expect(out.text).toContain('token=<redacted>');
    expect(out.text).not.toContain('topsecret');
  });
});
