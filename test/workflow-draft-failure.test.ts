/**
 * What the Dashboard says about a failed orchestrator model call, and the
 * searchable bot picker's filter: error code → closed-set cause → words.
 */
import { describe, expect, it } from 'vitest';

import { classifyFailureCode, extractFailureCode, maskFailureText, normalizeFailureCode } from '../src/workflows/v3/draft-failure.js';
import {
  botModelSettingsHref,
  canSwitchOrchestrator,
  draftFailureFacts,
  draftFailureMessage,
  draftFailureOf,
  recentFailureHint,
} from '../src/dashboard/web/workflow-draft-model.js';
import { botOptionMatches, filterBotOptions, type BotSearchOption } from '../src/dashboard/web/bot-search-model.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { latestModelFailures, type WorkflowDraftFailureSummary as WorkflowDraftFailure } from '../src/workflows/v3/draft-store.js';
import { PROVIDER_ERROR_TEXTS } from './helpers/provider-error-texts.js';

describe('error code → cause', () => {
  it.each([
    // Claude: a 403 "Access denied for model" carries an auth-ish API error code.
    ['provider_authentication_failed', 'permission'],
    ['provider_permission_denied', 'permission'],
    ['codex_auth_failed', 'permission'],
    ['pi_credential_unavailable', 'permission'],
    ['provider_rate_limited', 'quota'],
    ['codex_rate_limited', 'quota'],
    ['traex_usage_limit_exceeded', 'quota'],
    ['codex_capacity_exceeded', 'quota'],
    ['provider_server_error', 'unreachable'],
    ['provider_unexpected_eof', 'unreachable'],
    ['provider_no_model_reply', 'unreachable'],
    ['codex_connection_failed', 'unreachable'],
    ['codex_upstream_error', 'unreachable'],
    ['provider_invalid_request', 'rejected'],
    ['codex_invalid_request', 'rejected'],
    ['provider_unknown_error', 'unknown'],
    ['grok_turn_error', 'unknown'],
  ])('%s → %s', (code, category) => {
    expect(classifyFailureCode(code)).toBe(category);
  });

  it('no code is unknown', () => {
    expect(classifyFailureCode(undefined)).toBe('unknown');
  });

  it('only the code is taken from a failure text, never the text', () => {
    expect(extractFailureCode('worker reported terminal failure: provider_authentication_failed')).toBe('provider_authentication_failed');
    expect(extractFailureCode('worker reported terminal failure: unknown')).toBeUndefined();
    expect(extractFailureCode('relay said: codex_rate_limited (retry later)')).toBe('codex_rate_limited');
    expect(extractFailureCode('403 Access denied for model foo at https://gw.internal token sk-123')).toBeUndefined();
    expect(normalizeFailureCode('registry_unavailable')).toBe('registry_unavailable');
    expect(normalizeFailureCode('创建会话超时')).toBeUndefined();
    expect(normalizeFailureCode('a b')).toBeUndefined();
  });

  it('an env var name or a key that looks like a CLI prefix is not a code', () => {
    expect(extractFailureCode('missing CLAUDE_CODE_OAUTH_TOKEN')).toBeUndefined();
    expect(extractFailureCode('with CLAUDE_CODE_USE_BEDROCK=1 set')).toBeUndefined();
    expect(extractFailureCode('bad key cursor_qwertyzxcv1234567890secretabcdef')).toBeUndefined();
    expect(extractFailureCode('relay: codex_api_key_abcdefgh')).toBeUndefined();
    expect(extractFailureCode('relay: provider_rate_limited')).toBe('provider_rate_limited');
    expect(extractFailureCode('worker reported terminal failure: claude_stop_failure')).toBe('claude_stop_failure');
    expect(normalizeFailureCode('claude_code_oauth_token')).toBeUndefined();
  });
});

describe('raw failure text masking', () => {
  const SECRET = 'QWERTYzxcv1234567890SECRETabcdef';
  it.each([
    ['json key', `{"api_key":"${SECRET}"}`],
    ['json key with blank', `{"token": "${SECRET}"}`],
    ['header-ish json key', `"x-api-key": "${SECRET}"`],
    ['escaped json', `{\\"token\\":\\"${SECRET}\\"}`],
    ['basic auth', `Authorization: Basic ${Buffer.from(`user:${SECRET}`).toString('base64')}`],
    ['cookie', `Cookie: sessionid=${SECRET}; theme=dark`],
    ['cookie, the secret not first', `Cookie: _ga=1; uid=${SECRET}`],
    ['set-cookie', `set-cookie: sid=${SECRET}; Path=/`],
    ['url sig', `GET https://cdn.example/x?sig=${SECRET}&e=1`],
    ['url key', `https://api.example/v1?key=AIza${SECRET}`],
    ['url t', `/s/abc?t=${SECRET}`],
    ['ansi between key and =', `api_key\x1b[0m=${SECRET}`],
    ['ansi between Bearer and value', `Bearer\x1b[0m ${SECRET}`],
    ['upper-case sk-', `SK-${SECRET}`],
    ['x-auth header', `x-auth: ${SECRET}`],
    ['authorization=', `authorization=${SECRET}`],
    ['access_token query', `?access_token=${SECRET}`],
    ['env assignment', `ANTHROPIC_AUTH_TOKEN="${SECRET}"`],
    ['Api-Key header', `Api-Key: ${SECRET}`],
    ['password', `password: ${SECRET}`],
    ['Bearer on the next row', `Bearer\n${SECRET}`],
    ['sk-ant', `sk-ant-${SECRET}`],
  ])('%s', (_name, raw) => {
    const masked = maskFailureText(raw);
    expect(masked).toContain('‹hidden›');
    expect(masked).not.toContain(SECRET.slice(8));
    expect(masked).not.toContain('\x1b');
  });

  it('a token the terminal wrapped onto the next row is masked there too; ordinary rows stay', () => {
    const masked = maskFailureText(`Authorization: Bearer ${SECRET}\nGHIJKLMNOPQRSTUVWXYZ0123456789zz\nAPI Error: 403 Access denied`);
    expect(masked).not.toContain('GHIJKLMNOPQRSTUVWXYZ');
    expect(masked).toContain('API Error: 403 Access denied');
  });

  it('plain error text passes through', () => {
    const text = 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Access denied for model x"}}';
    expect(maskFailureText(text)).toBe(text);
  });

  // The shapes a terminal and a CLI leave a credential in: wrapped onto the
  // next row (an indent, a TUI box, the rest of a command after it), a quoted
  // value with blanks, a full-width colon or a Chinese label, a flag.
  it.each([
    ['wrapped onto an indented row that closes a paren',
      'ANTHROPIC_API_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n  QWERTYUIOPASDFGHJKLZXCVBNM0123)',
      'ANTHROPIC_API_KEY=‹hidden›\n  ‹hidden›)'],
    ['wrapped inside a TUI box',
      '│ > token=ABCDEFGHIJKLMNOPQRSTUV │\n│ ZXCVBNMASDFGHJKL98765          │',
      '│ > token=‹hidden› │\n│ ‹hidden›          │'],
    ['wrapped twice', 'token=Aa1Bb2Cc3Dd4Ee5Ff6Gg7\nHh8Ii9Jj0KkLlMmNnOoPp\nQq1Rr2Ss3T\nnext row', 'token=‹hidden›\n‹hidden›\n‹hidden›\nnext row'],
    ['wrapped, the command going on after it', 'export TOKEN=abcdefghijkl\nmnop4qrstuv; npm test', 'export TOKEN=‹hidden›\n‹hidden›; npm test'],
    // Review 2026-11-07: shapes the masking let through.
    ['a diff\'s removed row, blanks around =', '-API_KEY = "Wm3Kq8Zr5Vx2Lp9Nt6Hb4Jd7"\n+API_KEY = os.environ["API_KEY"]',
      '-API_KEY = "‹hidden›"\n+API_KEY = os.environ["API_KEY"]'],
    ['a flag, blanks around =', 'botmux setup add --app-secret = Hb4Jd7Fg1Sc0YaWm3Kq8', 'botmux setup add --app-secret = ‹hidden›'],
    ['a flag at a row\'s end, its value word-wrapped onto the next row',
      '⏺ Bash(botmux setup add --app-id cli_x --app-secret\n      Wm3Kq8Zr5Vx2Lp9Nt6Hb4Jd7Fg1Sc0Ya --verbose)',
      '⏺ Bash(botmux setup add --app-id cli_x --app-secret\n      ‹hidden› --verbose)'],
    ['a flag at a row\'s end, its quoted value wrapped onto the next row',
      '⏺ Bash(botmux setup add --app-secret\n      "Wm3Kq8Zr5Vx2Lp9Nt6Hb4Jd7Fg1Sc0Ya" --verbose)',
      '⏺ Bash(botmux setup add --app-secret\n      ‹hidden› --verbose)'],
    ['a flag at a row\'s end, its single-quoted value on the next row', "tool --api-key\n  'Wm3Kq8Zr5Vx2Lp9Nt6Hb4Jd7'", "tool --api-key\n  ‹hidden›"],
    ['a flag at a row\'s end inside a TUI box, its value on the next row',
      '│ $ claude --api-key        │\n│ Wm3Kq8Zr5Vx2Lp9Nt6Hb4Jd7  │', '│ $ claude --api-key        │\n│ ‹hidden›  │'],
    ['a flag at a row\'s end inside a TUI box, its quoted value going on past the border',
      '│ --api-key        │\n│ "Wm3Kq8Zr5Vx2Lp9Nt6  │', '│ --api-key        │\n│ ‹hidden›│'],
    // Two more shapes of the same rule: argv serialization ends the flag with
    // a comma, and a TUI draws a border between a label's separator and its value.
    ['a flag at a row\'s end with a trailing comma (argv serialization), its value on the next row',
      '--app-secret,\n  "Wm3Kq8Zr5Vx2Lp9Nt6Hb4Jd7"', '--app-secret,\n  ‹hidden›'],
    ['a label\'s separator followed by a TUI border, its value on the next row',
      '│ token: │\n│ Wm3Kq8Zr5Vx2Lp9Nt6Hb4Jd7 │', '│ token: │\n│ ‹hidden› │'],
    ['an argv array printed one element a row', "spawnargs: [\n  '--app-secret',\n  'Qz7Xk9PL2mN4wV8rT3yB6hJ5'\n]",
      "spawnargs: [\n  '--app-secret',\n  ‹hidden›\n]"],
    ['a hard wrap, more arguments after the tail', 'docker run -e ANTHROPIC_API_KEY=Hb4Jd7Fg1Sc0YaWm3Kq8\n3Kq8Zr5Vx2Lp9Nt6 -e FOO=bar image',
      'docker run -e ANTHROPIC_API_KEY=‹hidden›\n‹hidden› -e FOO=bar image'],
    ['a PEM private key over rows', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1x2y3\n  z4w5v6u7t8\n-----END RSA PRIVATE KEY-----',
      '-----BEGIN RSA PRIVATE KEY-----\n‹hidden›\n  ‹hidden›\n-----END RSA PRIVATE KEY-----'],
    ['a PEM private key after a label', 'private_key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----',
      'private_key: ‹hidden› PRIVATE KEY-----\n‹hidden›\n-----END PRIVATE KEY-----'],
    // Vendor prefixes are split so a secret scanner never reads these fixtures as live keys.
    ['an STS key id', 'aws key ASIA' + 'QZ7XK9PL2MN4WV8R expired', 'aws key ‹hidden› expired'],
    ['a *_KEY name without a secret word', 'ENCRYPTION_KEY=Hb4Jd7Fg1Sc0YaWm3Kq8', 'ENCRYPTION_KEY=‹hidden›'],
    ["Lark's encryptKey", '"encryptKey": "Hb4Jd7Fg1Sc0YaWm3Kq8"', '"encryptKey": "‹hidden›"'],
    ['a URL with an empty user name', 'REDIS_URL=redis://:Hb4Jd7Fg1Sc0YaWm3Kq8@cache:6379', 'REDIS_URL=redis://:‹hidden›@cache:6379'],
    ['a token as the whole userinfo', 'git clone https://9f8e7d6c5b4a39281706f5e4d3c2b1a098f7e6d5@github.com/o/r.git',
      'git clone https://‹hidden›@github.com/o/r.git'],
    ['a Chinese label, 为', '数据库密码为：Hb4Jd7Fg1Sc0YaWm3Kq8', '数据库密码为：‹hidden›'],
    ['a Chinese label, no separator', 'App Secret 为 Hb4Jd7Fg1Sc0YaWm3Kq8', 'App Secret 为 ‹hidden›'],
    ['a quoted Bearer value', 'Bearer "Qz7Xk9PL2mN4wV8rT3yB6hJ5"', '‹hidden›"'],
    ['a Bearer value starting with a prose word', 'Bearer or/Qz7Xk9PL2mN4wV8rT3yB6hJ5', '‹hidden›'],
    ['Bearer at a TUI row\'s end', '│ Bearer │\n│ Qz7Xk9PL2mN4wV8rT3yB6hJ5 │', '│ Bearer │\n│ ‹hidden› │'],
    ['curl -u', 'curl -u admin:Hb4Jd7Fg1Sc0YaWm3Kq8 https://x.example', 'curl -u admin:‹hidden› https://x.example'],
    ['mysql -p', 'mysql -u root -pHb4Jd7Fg1Sc0YaWm3Kq8 db', 'mysql -u root -p‹hidden› db'],
    ['vendor prefixes', 'gitlab glpat' + '-Hb4Jd7Fg1Sc0YaWm3Kq8 npm npm' + '_Hb4Jd7Fg1Sc0YaWm3Kq8Zr5Vx2 stripe sk_live' + '_Hb4Jd7Fg1Sc0YaWm3Kq8',
      'gitlab ‹hidden› npm ‹hidden› stripe ‹hidden›'],
    ['a quoted value with blanks', '{"password": "correct horse battery staple"}', '{"password": "‹hidden›"}'],
    ['single-quoted, with blanks', "{'password': 'correct horse battery staple'}", "{'password': '‹hidden›'}"],
    ['escaped JSON, with blanks', '{\\"password\\":\\"correct horse battery staple\\"}', '{\\"password\\":\\"‹hidden›\\"}'],
    ['a quoted value wrapped onto the next row',
      '"password": "correct horse\n  battery staple", "user": "u"', '"password": "‹hidden›\n  ‹hidden›", "user": "u"'],
    ['a quoted value wrapped right after its quote', '"password": "\ncorrect horse battery staple"', '"password": "‹hidden›\n‹hidden›"'],
    ['a quoted value wrapped inside a TUI box',
      '│ "password": "correct horse  │\n│ battery staple"         │', '│ "password": "‹hidden›│\n│ ‹hidden›"         │'],
    ['a full-width colon', 'App Secret：a1b2c3d4e5f6g7h8i9j0', 'App Secret：‹hidden›'],
    ['a full-width colon between blanks', 'App Secret ： a1b2c3d4e5f6g7h8i9j0', 'App Secret ： ‹hidden›'],
    ['a Chinese label', '数据库密码：hunter2hunter2 已过期', '数据库密码：‹hidden› 已过期'],
    ['a flag and the next word', 'run --app-secret f00dfacecafebabe1234 --verbose', 'run --app-secret ‹hidden› --verbose'],
    ['a flag and a quoted value', '--token "two words" --verbose', '--token ‹hidden› --verbose'],
    ['a flag with =', '--app-secret=f00dfacecafebabe1234', '--app-secret=‹hidden›'],
    ['an argv array', '["--app-secret","f00dfacecafebabe1234"]', '["--app-secret",‹hidden›]'],
    ['an escaped argv array', '[\\"--api-key\\",\\"f00dfacecafebabe1234\\"]', '[\\"--api-key\\",‹hidden›]'],
    ['a dash-joined -key name', 'x-key: zzzzyyyy1234', 'x-key: ‹hidden›'],
    // Review 2026-11-07 (second round): shapes a narrower rule let through.
    ['a quoted value with a ( and other symbols', "SECRET_KEY = 'k3$a9xq7(zq!m2v@8w#h4^r&t*y-u=p+o)i0e_l5n6c1b'", "SECRET_KEY = '‹hidden›'"],
    ['an unquoted value with a (', 'DB_PASSWORD=Xk9mP2(qL!vR7z', 'DB_PASSWORD=‹hidden›'],
    ['an assignment in an exception\'s message', 'CredentialsError: password=Hunter2Hunter2xyz', 'CredentialsError: password=‹hidden›'],
    ['a camel-case token name', 'tokenString=Q7w8e9r0t1y2u3i4o5p6', 'tokenString=‹hidden›'],
    ['a plural tokens name with =', 'SLACK_BOT_TOKENS=Q7w8e9r0t1y2u3i4o5p6', 'SLACK_BOT_TOKENS=‹hidden›'],
    ['Basic without a digit', 'curl -v ... > Basic dXNlcjpwYXNz', 'curl -v ... > ‹hidden›'],
    ['a PGP private key block', '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBF7abc123DEFghiJKLmnoPQRstuVWXyz0123456789\n=AbCd\n-----END PGP PRIVATE KEY BLOCK-----',
      '-----BEGIN PGP PRIVATE KEY BLOCK-----\n‹hidden›\n‹hidden›\n‹hidden›\n-----END PGP PRIVATE KEY BLOCK-----'],
    ['a PEM body printed with line numbers', '     1\t-----BEGIN PRIVATE KEY-----\n     2\tMIIEvQIBADANBgkqhkiG9w0B\n     3\t-----END PRIVATE KEY-----',
      '     1\t-----BEGIN PRIVATE KEY-----\n     ‹hidden›\n     3\t-----END PRIVATE KEY-----'],
    ['a PEM body whose BEGIN row is not in the text', 'Qz7Xk9PL2mN4wV8rT3yB6hJ5aZQz7Xk9PL2mN4wV8rT3yB6hJ5aZQz7Xk9PL2mN4\nwV8rT3yB6hJ5aZ=\n-----END RSA PRIVATE KEY-----\nnext',
      '‹hidden›\n‹hidden›\n-----END RSA PRIVATE KEY-----\nnext'],
    // Review 2026-11-07 (mutation round): rules no case held to their job.
    ['a bare-word name, a credential-shaped value', 'token: Hb4Jd7Fg1Sc0YaWm3Kq8', 'token: ‹hidden›'],
    ['a bare key name', 'key: Hb4Jd7Fg1Sc0YaWm3Kq8', 'key: ‹hidden›'],
    ['a bare session name', 'session: Hb4Jd7Fg1Sc0YaWm3Kq8', 'session: ‹hidden›'],
    ['a bare-word name, a short value with a digit', 'token: Hb4Jd7Fg1Sc0', 'token: ‹hidden›'],
    ['a bare-word name, a long value of letters', 'token: AbCdEfGhIjKlMnOpQrStUv', 'token: ‹hidden›'],
    ['a compound name ending in secret', 'session_secret: correcthorsebattery', 'session_secret: ‹hidden›'],
    ['a compound name ending in password', 'auth_password: correcthorse', 'auth_password: ‹hidden›'],
    ['a name that starts with ERROR', 'ERROR_REPORTING_API_KEY=Hb4Jd7Fg1Sc0YaWm3Kq8', 'ERROR_REPORTING_API_KEY=‹hidden›'],
    ['a name that starts with failed', '"failed_login_token": "Hb4Jd7Fg1Sc0YaWm3Kq8"', '"failed_login_token": "‹hidden›"'],
    ['a value that starts with $ but is no variable', 'password=$Hb4Jd7Fg1Sc0YaWm3Kq8', 'password=‹hidden›'],
    ['curl -u with a ( in the password', 'curl -u deploy:Tr0ub4dor(x) https://x.example', 'curl -u deploy:‹hidden› https://x.example'],
    ['a Chinese label, 是', '数据库密码是：Hb4Jd7Fg1Sc0YaWm3Kq8', '数据库密码是：‹hidden›'],
    ['an English name, 是', 'your token 是 Hb4Jd7Fg1Sc0YaWm3Kq8', 'your token 是 ‹hidden›'],
    ['an English name, 为', 'the password 为 Hb4Jd7Fg1Sc0YaWm3Kq8', 'the password 为 ‹hidden›'],
    ['a Chinese name, 是 without a colon', '密钥是 Hb4Jd7Fg1Sc0YaWm3Kq8', '密钥是 ‹hidden›'],
    ['Basic with base64 padding, no digit', 'Basic AbCdEfGhIjKlMnOpQr==', '‹hidden›'],
    ['Basic in capitals with only padding', 'Basic QUFBQUFBQUE=', '‹hidden›'],
    ['a PEM key in one row with escaped newlines',
      'error: invalid PEM "-----BEGIN RSA PRIVATE KEY-----\\nMIIEowIBAAKCAQEA1x2y3z4w5v6u7t8\\n-----END RSA PRIVATE KEY-----"',
      'error: invalid PEM "-----BEGIN RSA PRIVATE KEY-----‹hidden›-----END RSA PRIVATE KEY-----"'],
    ['mysqldump -p', 'mysqldump -u root -pHb4Jd7Fg1Sc0YaWm3Kq8 db', 'mysqldump -u root -p‹hidden› db'],
    ['more vendor prefixes',
      'slack xapp' + '-1-A0123456789-1234567890123-abcdef0123456789 hf hf' + '_AbCdEfGhIjKlMnOpQrStUvWxYz012345 stripe rk_live' + '_Hb4Jd7Fg1Sc0YaWm3Kq8 sk_test' + '_Hb4Jd7Fg1Sc0YaWm3Kq8',
      'slack ‹hidden› hf ‹hidden› stripe ‹hidden› ‹hidden›'],
    ['a long vendor token of letters only', 'using hf' + '_AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh', 'using ‹hidden›'],
    ['bare vendor tokens and a JWT',
      'github ghp' + '_AbCdEf1234567890GhIjKl pat github_pat' + '_11ABCDEFG0123456789_abcdefghijkl google AIza' + 'SyA1b2C3d4E5f6G7h8I9j0KlMnOpQr slack xoxb' + '-1234567890-0987654321-AbCdEfGh jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpM',
      'github ‹hidden› pat ‹hidden› google ‹hidden› slack ‹hidden› jwt ‹hidden›'],
    ['a wrapped tail in mixed case', 'token=Hb4Jd7Fg1Sc0YaWm3Kq8\nabcDEFghij', 'token=‹hidden›\n‹hidden›'],
    ['a wrapped tail with a dot', 'token=Hb4Jd7Fg1Sc0YaWm3Kq8\nabcde.fghij', 'token=‹hidden›\n‹hidden›'],
    ['a wrapped tail with base64 symbols', 'token=Hb4Jd7Fg1Sc0YaWm3Kq8\nabcd+efg/h==', 'token=‹hidden›\n‹hidden›'],
    ['a wrapped base64 tail ending in ==, no assignment', 'token=Hb4Jd7Fg1Sc0YaWm3Kq8\nQWxhZGRpbjpvcGVuIHNlc2FtZQ==', 'token=‹hidden›\n‹hidden›'],
    ['a short hard-wrapped tail', 'docker run -e API_KEY=Hb4Jd7Fg1Sc0YaWm3Kq8\nZr5Vx2Lp9N -e FOO=bar image',
      'docker run -e API_KEY=‹hidden›\n‹hidden› -e FOO=bar image'],
    ['a four-character wrapped tail', 'token=Hb4Jd7Fg1Sc0YaWm3Kq8\nab12)', 'token=‹hidden›\n‹hidden›)'],
    ['a short Bearer value in its row', 'Bearer Qz7Xk9PL2m', '‹hidden›'],
    // Review 2026-11-07 (mutation round 2).
    ['a PGP key block in one row',
      'error: invalid armor "-----BEGIN PGP PRIVATE KEY BLOCK-----\\n\\nlQOYBGVkZXN0AQgAx1y2z3w4v5u6t7s8\\n-----END PGP PRIVATE KEY BLOCK-----"',
      'error: invalid armor "-----BEGIN PGP PRIVATE KEY BLOCK-----‹hidden›-----END PGP PRIVATE KEY BLOCK-----"'],
    ['a PEM key in one row, its newlines flattened to blanks',
      'parse failed: -----BEGIN PRIVATE KEY----- MIIEvQIBADANBgkqhkiG9w0BAQEFAASC -----END PRIVATE KEY-----',
      'parse failed: -----BEGIN PRIVATE KEY-----‹hidden›-----END PRIVATE KEY-----'],
    ['an encrypted PEM key with headers, its END row not printed yet',
      '-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nDEK-Info: AES-128-CBC,0123456789ABCDEF\n\nMIIEowIBAAKCAQEA1x2y3z4w5v6u7t8s9r0q1p2o3n4m5l6k7j8i9h0g1f2e3d4c\nQ2xhdWRlIGlzIGEgZmFtaWx5IG9mIGxhcmdlIGxhbmd1YWdlIG1vZGVscw',
      '-----BEGIN RSA PRIVATE KEY-----\n‹hidden›\n‹hidden›\n‹hidden›\n‹hidden›\n‹hidden›'],
    ['curl --user', 'curl --user deploy:Hb4Jd7Fg1Sc0YaWm3Kq8 https://api.example.com', 'curl --user deploy:‹hidden› https://api.example.com'],
    ['a password with a call-shaped start', 'password=Summer(2024)Fun!', 'password=‹hidden›'],
    ['a flag\'s call-shaped value', '--password pass(word)', '--password ‹hidden›'],
    ['a hard-wrapped tail of hex', 'docker run -e API_KEY=Hb4Jd7Fg1Sc0YaWm3Kq8\n3f9a1c7e5b2d8f4a6c0e9b1d7f3a5c8e -e FOO=bar image',
      'docker run -e API_KEY=‹hidden›\n‹hidden› -e FOO=bar image'],
    ['a signature header', 'X-Hub-Signature-256: sha256=3f9a1c7e5b2d8f4a6c0e9b1d7f3a5c8e', 'X-Hub-Signature-256: ‹hidden›'],
    ['a name ending in CREDENTIAL', 'AZURE_CLIENT_CREDENTIAL=Hb4Jd7Fg1Sc0YaWm3Kq8', 'AZURE_CLIENT_CREDENTIAL=‹hidden›'],
    ['a name ending in cookie', '{"remember_cookie": "Hb4Jd7Fg1Sc0YaWm3Kq8"}', '{"remember_cookie": "‹hidden›"}'],
  ])('%s', (_name, raw, masked) => {
    expect(maskFailureText(raw)).toBe(masked);
  });

  it.each([
    ['an empty value', '"password": ""', '"password": ""'],
    ['an author', 'git log --author "Jane Doe"', 'git log --author "Jane Doe"'],
    ['a name without a secret word', 'monkey: banana', 'monkey: banana'],
    ['the row after a value its quote closed', 'token: "abcdefgh"\nRetrying in 5s', 'token: "‹hidden›"\nRetrying in 5s'],
    // Below a masked value: a row of words, a stack frame, the next key.
    ['a TUI box row of words', '│ > token=ABCDEFGH │\n│ Retrying in 5s   │', '│ > token=‹hidden› │\n│ Retrying in 5s   │'],
    ['an indented stack frame', 'ANTHROPIC_API_KEY=ABCDEFGH\n  at Object.<anonymous> (index.js:1:1)',
      'ANTHROPIC_API_KEY=‹hidden›\n  at Object.<anonymous> (index.js:1:1)'],
    ['the next key of a pretty-printed object', '{\n  "api_key": "abc",\n  "model": "claude-3-5"\n}',
      '{\n  "api_key": "‹hidden›",\n  "model": "claude-3-5"\n}'],
    // Review 2026-11-07: what the masking hid that a reader needs.
    ['the next assignment of an env dump', 'ANTHROPIC_AUTH_TOKEN=Hb4Jd7Fg1Sc0YaWm3Kq8\nANTHROPIC_MODEL=claude-opus-4-1',
      'ANTHROPIC_AUTH_TOKEN=‹hidden›\nANTHROPIC_MODEL=claude-opus-4-1'],
    ['a word below a masked header', 'x-api-key: Hb4Jd7Fg1Sc0YaWm3Kq8\nUnauthorized', 'x-api-key: ‹hidden›\nUnauthorized'],
    ['a token count', 'max_tokens: 64000 > 32000, which is the maximum allowed', 'max_tokens: 64000 > 32000, which is the maximum allowed'],
    ['prose after a bare word and a colon', 'oauth2: cannot fetch token: 400 Bad Request', 'oauth2: cannot fetch token: 400 Bad Request'],
    ['an exception class name', 'ExpiredTokenException: The security token included in the request is expired',
      'ExpiredTokenException: The security token included in the request is expired'],
    ['Basic and Bearer in prose', 'Basic configuration failed; the bearer of this message', 'Basic configuration failed; the bearer of this message'],
    ['a reference to where the secret comes from', 'const apiKey = process.env.ANTHROPIC_API_KEY; const token = getToken();',
      'const apiKey = process.env.ANTHROPIC_API_KEY; const token = getToken();'],
    ['a model in a docs link', 'See https://docs.anthropic.com/en/api/errors?model=claude-opus-4-1 for details',
      'See https://docs.anthropic.com/en/api/errors?model=claude-opus-4-1 for details'],
    // Review 2026-11-07 (second round): what the masking hid that a reader needs.
    ['a BEGIN marker quoted in code, no body after it',
      "src/auth.ts:12:const HEADER = '-----BEGIN PRIVATE KEY-----';\n⏺ API Error: 403 Access denied for model claude-opus-4-1",
      "src/auth.ts:12:const HEADER = '-----BEGIN PRIVATE KEY-----';\n⏺ API Error: 403 Access denied for model claude-opus-4-1"],
    ['an END marker quoted in code', "src/x.ts:12:const FOOTER = '-----END PRIVATE KEY-----';\nok", "src/x.ts:12:const FOOTER = '-----END PRIVATE KEY-----';\nok"],
    ['an END marker after prose', 'The key ends with\n-----END PRIVATE KEY-----', 'The key ends with\n-----END PRIVATE KEY-----'],
    ['a BEGIN marker in an error message',
      'The private key must start with "-----BEGIN PRIVATE KEY-----"\n    at createPrivateKey (node:internal/crypto/keys:620:12)',
      'The private key must start with "-----BEGIN PRIVATE KEY-----"\n    at createPrivateKey (node:internal/crypto/keys:620:12)'],
    ['counts in JSON', '{"promptTokenCount":1048577,"totalTokenCount":1048577}', '{"promptTokenCount":1048577,"totalTokenCount":1048577}'],
    ['a count after a flag', 'claude --max-tokens 4096 --print', 'claude --max-tokens 4096 --print'],
    ['the name of the variable holding a key', 'model_providers.azure: env_key = "AZURE_OPENAI_API_KEY" is not set',
      'model_providers.azure: env_key = "AZURE_OPENAI_API_KEY" is not set'],
    ['a data key', '{"idempotency_key":"9f1c2d","partition_key":"tenant-42"}', '{"idempotency_key":"9f1c2d","partition_key":"tenant-42"}'],
    ['a uid:gid after docker -u', 'docker run -u 1000:1000 ghcr.io/acme/agent:2.3.1', 'docker run -u 1000:1000 ghcr.io/acme/agent:2.3.1'],
    ['Bearer followed by prose', 'Error: Bearer credential(s) missing for upstream', 'Error: Bearer credential(s) missing for upstream'],
    ['a query flag', 'POST https://gw.example/v1/messages?beta=true 529 Overloaded', 'POST https://gw.example/v1/messages?beta=true 529 Overloaded'],
    ['a timestamp below a masked value', '[auth] ANTHROPIC_AUTH_TOKEN=Hb4Jd7Fg1Sc0YaWm3Kq8\n2026-11-07T05:00:01.456Z ERROR 403',
      '[auth] ANTHROPIC_AUTH_TOKEN=‹hidden›\n2026-11-07T05:00:01.456Z ERROR 403'],
    ['a model name below a masked value', 'export ANTHROPIC_API_KEY=Hb4Jd7Fg1Sc0YaWm3Kq8\nclaude-opus-4-1 returned 403 permission_error',
      'export ANTHROPIC_API_KEY=‹hidden›\nclaude-opus-4-1 returned 403 permission_error'],
    ['a diff\'s added row below its removed one', '-ANTHROPIC_API_KEY=Hb4Jd7Fg1Sc0YaWm3Kq8\n+ANTHROPIC_MODEL=claude-opus-4-1',
      '-ANTHROPIC_API_KEY=‹hidden›\n+ANTHROPIC_MODEL=claude-opus-4-1'],
    // Review 2026-11-07 (mutation round): exemptions no case held to their job.
    ['Bearer at a row\'s end, prose below', 'expected scheme Bearer\nRetrying in 5s', 'expected scheme Bearer\nRetrying in 5s'],
    ['Bearer at a TUI row\'s end, an error name below', '│ expected scheme Bearer │\n│ UnauthenticatedRequestError │',
      '│ expected scheme Bearer │\n│ UnauthenticatedRequestError │'],
    ['Bearer before a prose word at the end', 'the endpoint requires Bearer authentication', 'the endpoint requires Bearer authentication'],
    ['Bearer before authentication', 'Expected Bearer authentication in header', 'Expected Bearer authentication in header'],
    ['authenticated and Authentication', '{"authenticated": false, "reason": "expired"}\nAuthentication: required',
      '{"authenticated": false, "reason": "expired"}\nAuthentication: required'],
    ['an env name with a vendor prefix', 'env npm_config_user_agent is set', 'env npm_config_user_agent is set'],
    ['a user name in a URL', 'git clone ssh://deployment_user_account@git.example.com/repo', 'git clone ssh://deployment_user_account@git.example.com/repo'],
    ['a help text row below a flag', '  --api-key\n      Credentials used to call the model', '  --api-key\n      Credentials used to call the model'],
    ['a help text row below a flag in a TUI box', '│ --api-key   │\n│ Use this key for requests │', '│ --api-key   │\n│ Use this key for requests │'],
    ['a quoted help text below a flag', '--api-key\n  "the key to send" (string)', '--api-key\n  "the key to send" (string)'],
    ['a quoted variable reference', 'token = "${GITHUB_TOKEN}"', 'token = "${GITHUB_TOKEN}"'],
    ['an error name as a quoted key', '{"InvalidTokenError": "token expired"}', '{"InvalidTokenError": "token expired"}'],
    ['bare-word names before prose', 'missing required key: model\nsession: expired\ncredentials: missing\nsig: invalid\nsession：expired',
      'missing required key: model\nsession: expired\ncredentials: missing\nsig: invalid\nsession：expired'],
    ['an error class before its message', 'CredentialsProviderError: Could not load credentials from any providers',
      'CredentialsProviderError: Could not load credentials from any providers'],
    ['an error code ending in failed', 'token_refresh_failed: invalid_grant', 'token_refresh_failed: invalid_grant'],
    ['variable references', 'api_key: ${ANTHROPIC_API_KEY}\nGITHUB_TOKEN=$GH_TOKEN', 'api_key: ${ANTHROPIC_API_KEY}\nGITHUB_TOKEN=$GH_TOKEN'],
    ['a count below a masked value', 'token=Hb4Jd7Fg1Sc0YaWm3Kq8\n12345678 retries left', 'token=‹hidden›\n12345678 retries left'],
    ['the error after a PEM key in one row', 'key="-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADAN\\n-----END PRIVATE KEY-----"\nAPI Error: 403 Access denied for model x',
      'key="‹hidden›"\nAPI Error: 403 Access denied for model x'],
    // Review 2026-11-07 (mutation round 2).
    ['a word above a key\'s body whose BEGIN row is cut',
      'Done\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\nZx9Q==\n-----END PRIVATE KEY-----',
      'Done\n‹hidden›\n‹hidden›\n-----END PRIVATE KEY-----'],
    ['an error name above a quoted END marker', 'InvalidPemError\nexpected "-----END PRIVATE KEY-----" at the end of the key',
      'InvalidPemError\nexpected "-----END PRIVATE KEY-----" at the end of the key'],
    ['a token count name before prose', 'max_tokens: Field required', 'max_tokens: Field required'],
    ['max / min counts', 'max_session_age: 3600\n--session-max-age 3600', 'max_session_age: 3600\n--session-max-age 3600'],
  ])('what holds no credential stays: %s', (_name, raw, masked) => {
    expect(maskFailureText(raw)).toBe(masked);
  });
});

describe('a provider\'s error stays readable', () => {
  // What the failure panel is for: the provider's own words, as written.
  it.each(PROVIDER_ERROR_TEXTS)('%s', (_name, text) => {
    expect(maskFailureText(text)).toBe(text);
  });

  it('a credential beside the reason goes; the reason stays', () => {
    const masked = maskFailureText('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Access denied for model model_hub/es1_orange_o50"}}\n'
      + 'request: curl -H "x-api-key: sk-ant' + '-api03-ABCDEFGHIJKLMNOP" --app-secret f00dfacecafebabe1234');
    expect(masked).toContain('API Error: 403 {"type":"error","error":{"type":"permission_error","message":"Access denied for model model_hub/es1_orange_o50"}}');
    expect(masked).not.toMatch(/ABCDEFGHIJKLMNOP|f00dfacecafebabe1234/);
  });
});

const zh = createDashboardTranslator('zh');
const en = createDashboardTranslator('en');

describe('the words on the draft page', () => {
  it('the cause names the bot with its CLI, in both languages; causes differ', () => {
    const message = draftFailureMessage({ category: 'permission', cliId: 'claude-code' }, '编排一号');
    for (const tr of [zh, en]) {
      const text = tr(message.key, message.params);
      expect(text).toContain('编排一号（claude-code）');
      expect(text).not.toMatch(/\{\w+\}|undefined/);
    }
    const quota = draftFailureMessage({ category: 'quota', cliId: 'claude-code' }, '编排一号');
    expect(zh(quota.key, quota.params)).not.toBe(zh(message.key, message.params));
  });

  it('the model row only when the bot config has one', () => {
    expect(draftFailureFacts({ cliId: 'claude-code', model: 'demo-model-x' }, '编排一号')).toEqual([
      { key: 'bot', value: '编排一号（claude-code）' },
      { key: 'model', value: 'demo-model-x' },
    ]);
    expect(draftFailureFacts({ cliId: 'claude-code' }, '编排一号')).toEqual([{ key: 'bot', value: '编排一号（claude-code）' }]);
    for (const tr of [zh, en]) {
      for (const key of ['bot', 'model']) expect(tr(`workflow.draft.failure.fact.${key}`)).not.toBe(`workflow.draft.failure.fact.${key}`);
    }
  });

  it('every cause and step has words in both languages', () => {
    for (const category of ['permission', 'quota', 'unreachable', 'rejected', 'timeout', 'session', 'unknown'] as const) {
      const message = draftFailureMessage({ category }, 'b');
      for (const tr of [zh, en]) {
        expect(tr(message.key, message.params)).not.toBe(message.key);
        expect(tr(`workflow.draft.failure.short.${category}`)).not.toBe(`workflow.draft.failure.short.${category}`);
      }
    }
    for (const step of ['clarify_start', 'clarify_turn', 'architect']) {
      for (const tr of [zh, en]) expect(tr(`workflow.draft.failure.step.${step}`)).not.toBe(`workflow.draft.failure.step.${step}`);
    }
  });

  const base = {
    phase: 'clarifying' as const,
    orchestratorAppId: 'cli_main',
    clarify: { state: 'active' as const, pending: false, turns: [] },
  };

  it('a structured failure is shown as recorded; an older string-only one as unknown with its code', () => {
    const failure: WorkflowDraftFailure = { category: 'quota', code: 'provider_rate_limited', step: 'clarify_turn', larkAppId: 'cli_main', at: '2026-11-06T01:00:00.000Z' };
    expect(draftFailureOf({ ...base, failure })).toEqual({ ...failure, legacy: false });
    expect(draftFailureOf({ ...base, clarify: { ...base.clarify, error: 'worker reported terminal failure: provider_authentication_failed' } }))
      .toEqual({
        category: 'unknown', code: 'provider_authentication_failed', step: 'clarify_turn', larkAppId: 'cli_main', legacy: true,
        detail: 'worker reported terminal failure: provider_authentication_failed',
      });
    // An older string is masked and clipped on the page too.
    const legacy = draftFailureOf({ ...base, clarify: { ...base.clarify, error: `api_key=abcdefgh1234 ${'y'.repeat(3000)}` } })!;
    expect(legacy.detail).not.toContain('abcdefgh1234');
    expect(legacy.detail!.length).toBeLessThanOrEqual(2000);
    // A disconnected session has its own 「继续」 line, not a failure.
    expect(draftFailureOf({ ...base, clarify: { ...base.clarify, state: 'disconnected', error: '会话已断开' } })).toBeUndefined();
    // Past the requirement stage there is nothing to retry.
    expect(draftFailureOf({ ...base, phase: 'dag_ready', failure })).toBeUndefined();
    // A clarify failure is not shown once the draft is waiting for the Architect.
    expect(draftFailureOf({ ...base, phase: 'awaiting_architect', failure })).toBeUndefined();
  });

  it('an Architect run from before a switch is not shown as the new bot\'s failure; the new bot\'s own is', () => {
    const architect = {
      state: 'failed' as const, attempt: 1, startedAt: '2026-11-07T05:20:00.000Z', finishedAt: '2026-11-07T05:21:00.000Z',
      problems: ['worker reported terminal failure: provider_rate_limited'], elapsedMs: 60_000,
    };
    const moved = {
      ...base, phase: 'awaiting_architect' as const, orchestratorAppId: 'cli_new', architect,
      handoffs: [{ fromAppId: 'cli_main', toAppId: 'cli_new', at: '2026-11-07T05:30:00.000Z' }],
    } as Parameters<typeof draftFailureOf>[0];
    expect(draftFailureOf(moved)).toBeUndefined();
    const ranAgain = { ...moved, architect: { ...architect, startedAt: '2026-11-07T05:31:00.000Z', finishedAt: '2026-11-07T05:32:00.000Z' } };
    expect(draftFailureOf(ranAgain)).toMatchObject({ larkAppId: 'cli_new', step: 'architect', code: 'provider_rate_limited' });
    // Without a switch an older draft's failed run is shown as before.
    expect(draftFailureOf({ ...moved, handoffs: undefined })).toMatchObject({ step: 'architect', legacy: true });
  });

  it('the model settings link opens the bot\'s model field on the Bot config page', () => {
    const href = botModelSettingsHref('cli_main');
    expect(href.startsWith('#/bot-defaults?')).toBe(true);
    const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    expect(params.get('bot')).toBe('cli_main');
    expect(params.get('section')).toBe('agent');
    expect(params.get('field')).toBe('botDefaults.agentModel');
  });

  it('switching is offered before 拉群 only — to a platform and a local-token login alike', () => {
    const platform = { openId: 'ou_a', unionId: 'on_a', source: 'dashboard-platform' as const };
    const view = { ...base, initiator: platform } as Parameters<typeof canSwitchOrchestrator>[0];
    expect(canSwitchOrchestrator(view)).toBe(true);
    expect(canSwitchOrchestrator({ ...view, phase: 'spec_ready' })).toBe(true);
    expect(canSwitchOrchestrator({ ...view, phase: 'awaiting_architect', architect: { state: 'failed' } as never })).toBe(true);
    expect(canSwitchOrchestrator({ ...view, phase: 'awaiting_architect' })).toBe(false);
    expect(canSwitchOrchestrator({ ...view, phase: 'dag_ready' })).toBe(false);
    expect(canSwitchOrchestrator({ ...view, launch: {} as never })).toBe(false);
    expect(canSwitchOrchestrator({ ...view, initiator: { openId: 'ou_o', source: 'dashboard-local' } } as typeof view)).toBe(true);
  });

  it('the picker hint: the short cause and when', () => {
    const hint = recentFailureHint({ category: 'permission', step: 'clarify_turn', larkAppId: 'b', at: '2026-11-06T01:02:00.000Z' })!;
    const text = zh('workflow.draft.recentFailure', { reason: zh(hint.key), at: hint.at });
    expect(text).toContain(zh('workflow.draft.failure.short.permission'));
    expect(text).toContain(hint.at);
    expect(recentFailureHint(undefined)).toBeUndefined();
  });

  it('latest failure per bot, cleared by a later success of that bot only', () => {
    const fail = (appId: string, at: string): WorkflowDraftFailure => ({ category: 'permission', step: 'clarify_turn', larkAppId: appId, at });
    const out = latestModelFailures([
      { modelCalls: { a: { failure: fail('a', '2026-11-06T01:00:00.000Z') }, b: { failure: fail('b', '2026-11-06T01:00:00.000Z') } } },
      { modelCalls: { a: { okAt: '2026-11-06T02:00:00.000Z' }, b: { okAt: '2026-11-06T00:00:00.000Z' } } },
    ]);
    expect([...out.keys()]).toEqual(['b']);
  });
});

describe('bot picker filter', () => {
  const options: BotSearchOption[] = [
    { larkAppId: 'cli_aa01', name: '编排一号', cliId: 'claude-code' },
    { larkAppId: 'cli_bb02', name: 'DocWriter', cliId: 'codex' },
    { larkAppId: 'cli_cc03', name: '管家', cliId: 'claude-code', disabledWhy: '管家 Bot 不能当编排 Bot' },
  ];
  it('matches name, appId and CLI, case-insensitively; Chinese by substring', () => {
    expect(filterBotOptions(options, 'docw').map((option) => option.larkAppId)).toEqual(['cli_bb02']);
    expect(filterBotOptions(options, 'CLI_AA').map((option) => option.larkAppId)).toEqual(['cli_aa01']);
    expect(filterBotOptions(options, 'CODEX').map((option) => option.larkAppId)).toEqual(['cli_bb02']);
    expect(filterBotOptions(options, '一号').map((option) => option.larkAppId)).toEqual(['cli_aa01']);
    expect(filterBotOptions(options, '  ').length).toBe(3);
  });
  it('unusable bots are filtered like the others (still listed, with their reason)', () => {
    expect(filterBotOptions(options, 'claude').map((option) => option.larkAppId)).toEqual(['cli_aa01', 'cli_cc03']);
    expect(botOptionMatches(options[2]!, '管家')).toBe(true);
  });
});
