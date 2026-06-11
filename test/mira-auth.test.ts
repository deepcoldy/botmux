import { describe, expect, it } from 'vitest';
import { cookieHeaderFromMiraConfig } from '../src/mira-auth.js';

describe('cookieHeaderFromMiraConfig', () => {
  it('reads devbox-style top-level cookie strings', () => {
    expect(cookieHeaderFromMiraConfig({ cookie: 'mira_session=s1; other=o1' }))
      .toBe('mira_session=s1; other=o1');
  });

  it('reads nested Mira cookie header keys', () => {
    expect(cookieHeaderFromMiraConfig({ mira: { cookie_header: 'mira_session=s2' } }))
      .toBe('mira_session=s2');
  });

  it('converts mira_session values to a cookie header', () => {
    expect(cookieHeaderFromMiraConfig({ auth: { mira_session: 'session-token' } }))
      .toBe('mira_session=session-token');
  });

  it('builds a cookie header from cookie arrays', () => {
    const header = cookieHeaderFromMiraConfig({
      cookies: [
        { name: 'mira_session', value: 's3' },
        { name: 'other', value: 'o3' },
        { name: '', value: 'ignored' },
      ],
    });
    expect(header).toBe('mira_session=s3; other=o3');
  });

  it('returns undefined when no Mira cookie material exists', () => {
    expect(cookieHeaderFromMiraConfig({ foo: 'bar' })).toBeUndefined();
  });
});
