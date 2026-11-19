import { describe, expect, it } from 'vitest';
import { collectLinkRefCandidates } from '../src/services/link-ref-extractor.js';
import type { LinkRefSourceInput } from '../src/services/link-ref-types.js';

function urlsFrom(value: unknown): string[] {
  const sources: LinkRefSourceInput[] = [{ sourceType: 'tool', kind: 'structured', value }];
  return collectLinkRefCandidates(sources).candidates.map((candidate) => candidate.originalUrl);
}

describe('collectLinkRefCandidates sensitive leaves', () => {
  it('filters exact credential leaves while retaining authorization and documentation links', () => {
    expect(urlsFrom({
      headers: {
        Authorization: 'Bearer https://secret.test/header',
        Cookie: 'sid=https://secret.test/cookie',
        'Proxy_Authorization': 'Basic https://secret.test/proxy',
      },
      password: 'https://should-not-register.test/password',
      access_token: 'https://should-not-register.test/access',
      clientSecret: 'https://should-not-register.test/client-secret',
      authorization: { url: 'https://auth.test/approve' },
      authorization_url: 'https://auth.test/login',
      documentation_url: 'https://docs.test/page',
      token_help_url: 'https://docs.test/token-help',
      nested: {
        _meta: { 'botmux/linkRefPolicy': 'exclude' },
        url: 'https://excluded.test/x',
      },
    })).toEqual([
      'https://auth.test/approve',
      'https://auth.test/login',
      'https://docs.test/page',
      'https://docs.test/token-help',
    ]);
  });

  it('filters every specified exact credential field with hyphen/underscore and case equivalence', () => {
    const value = Object.fromEntries([
      'password', 'passwd', 'secret', 'client_secret', 'clientSecret', 'access-token', 'accessToken',
      'refresh_token', 'refreshToken', 'ID_TOKEN', 'idToken', 'session-token', 'sessionToken',
      'api_key', 'apiKey', 'apikey', 'private-key', 'privateKey',
    ].map((field, index) => [field, `https://secret.test/${index}`]));
    const result = collectLinkRefCandidates([{ sourceType: 'mcp', kind: 'structured', value }]);

    expect(result.candidates).toEqual([]);
    expect(result.stats.filteredCredential).toBe(18);
  });

  it('filters auth-header-shaped scalars but recurses into authorization objects', () => {
    expect(urlsFrom({
      authorization: 'Bearer https://secret.test/bearer',
      another: 'Basic https://secret.test/basic',
      nested: { authorization: { url: 'https://auth.test/approve' } },
    })).toEqual(['https://auth.test/approve']);
  });

  it('scans text blocks and text resources without scanning binary blobs', () => {
    expect(urlsFrom({
      content: [
        { type: 'text', text: 'open https://tool.test/action' },
        { type: 'image', data: 'https://binary.test/image' },
        { type: 'audio', data: 'https://binary.test/audio' },
      ],
      contents: [
        { uri: 'file:///doc', mimeType: 'text/plain', text: 'docs https://resource.test/page' },
        { uri: 'file:///blob', mimeType: 'application/octet-stream', blob: 'https://binary.test/blob' },
      ],
    })).toEqual([
      'https://tool.test/action',
      'https://resource.test/page',
    ]);
  });

  it('deduplicates byte-identical URLs after preserving first-source identity', () => {
    const url = 'https://example.test/p';
    const result = collectLinkRefCandidates([
      { sourceType: 'user_message', kind: 'text', text: `${url} ${url}`, sourceId: 'first' },
      { sourceType: 'tool', kind: 'text', text: url, sourceId: 'later' },
    ]);

    expect(result.candidates).toEqual([{ originalUrl: url, sourceType: 'user_message', sourceId: 'first' }]);
    expect(result.stats.found).toBe(3);
    expect(result.stats.candidateCount).toBe(1);
  });
});
