import { describe, expect, it } from 'vitest';

import { assertBytedcliAuditedRelease, parseBytedcliOperation } from '../src/core/bytedcli-operation-policy.js';
import type { BytedcliExecInputs } from '../src/cli/bytedcli-exec-protocol.js';
const parse = (argv: string[], inputs?: unknown) => parseBytedcliOperation(argv, inputs as BytedcliExecInputs);
const repo = ['--repo', 'team/service'];
const create = ['codebase', 'mr', 'create', ...repo, '--head', 'feature/demo', '--base', 'master', '--title', 'Demo'];

describe('audited bytedcli operations', () => {
  it('refuses unknown releases and rebuilds leading-dash text without option injection', () => {
    expect(() => assertBytedcliAuditedRelease('0.199.0')).not.toThrow();
    for (const release of ['0.200.0', '0.199.0-canary', 'v0.199.0', '']) {
      expect(() => assertBytedcliAuditedRelease(release)).toThrow();
    }
    const op = parse(['codebase', 'mr', 'update', '42', ...repo, '--title=--as=app']);
    expect(op.argv).toContain('--title=--as=app');
    expect(parse([...op.argv])).toEqual(op);
    expect(() => parse(['codebase', 'mr', 'update', '42', ...repo, '--title', '--as=app'])).toThrow();
    expect(() => parse(['bits', 'develop', 'get', '--dev-id', '12'])).toThrow();
  });
  it('canonicalizes audited aliases, equals, short flags and options anywhere', () => {
    const op = parse(['-j', 'codebase', '-R', 'team/service', 'pr', 'view', '--mr=42']);
    expect(op).toMatchObject({ id: 'codebase.mr.get', effect: 'read', region: 'cn',
      resources: { repo: 'team/service', mr: '42' }, stagedInputs: [] });
    expect(op.argv).toEqual(['--json', '--site', 'cn', 'codebase', 'mr', 'get', '42', '--repo', 'team/service']);
    expect(parse(op.argv)).toEqual(op);
  });

  it('classifies reviewed reads and actor writes by catalog entry', () => {
    for (const command of ['get', 'diff', 'files', 'status']) {
      expect(parse(['codebase', 'mr', command, '42', ...repo]).effect).toBe('read');
    }
    expect(parse(['codebase', 'repo', 'get', 'team/service']).effect).toBe('read');
    expect(parse(['codebase', 'repo', 'list', '--query', 'service']).effect).toBe('read');
    expect(() => parse(['bits', 'develop', 'get', '--dev-id', '12', '--space-id', '3', '--pipeline-id', '7'])).toThrow();
    expect(parse(['bits', 'develop', 'list', '--space-id', '3']).effect).toBe('read');
    expect(parse(['log', 'search-log-matchers', '--psm', 'team.service.api']).effect).toBe('read');
    expect(parse(create).effect).toBe('write');
    for (const command of ['close', 'reopen']) {
      expect(parse(['codebase', 'mr', command, '42', ...repo]).effect).toBe('write');
    }
    expect(parse(['codebase', 'mr', 'edit', '42', ...repo, '--title', 'Changed']).id).toBe('codebase.mr.update');
  });

  it('supports repeatable list flags while refusing repeated singleton and conflicting selectors', () => {
    const op = parse(['codebase', 'mr', 'list', ...repo, '--label', 'urgent,frontend', '--label', 'review']);
    expect(op.argv.slice(-6)).toEqual(['--label', 'urgent', '--label', 'frontend', '--label', 'review']);
    for (const tail of [['--repo', 'other/service'], ['--repo-id', '10'], ['--page-size', '10', '--limit', '20']]) {
      expect(() => parse(['codebase', 'mr', 'list', ...repo, ...tail])).toThrow();
    }
    expect(() => parse(['codebase', 'mr', 'get', '42', ...repo, '--mr-id', '10'])).toThrow();
  });

  it('enforces reviewed boolean arity, negation, separators and canonical false values', () => {
    expect(parse([...create, '--remove-source-branch']).argv).toContain('--remove-source-branch=true');
    expect(parse([...create, '--remove-source-branch=false']).argv).toContain('--remove-source-branch=false');
    expect(parse([...create, '--remove-source-branch', 'false']).argv).toContain('--remove-source-branch=false');
    expect(parse([...create, '--no-auto-invite-reviewers']).argv).toContain('--no-auto-invite-reviewers');
    expect(parse(['codebase', 'mr', 'get', ...repo, '--', '42']).resources.mr).toBe('42');
    for (const tail of [['--draft=false'], ['--draft', 'false'], ['--remove-source-branch=maybe'], ['--no-draft']]) {
      expect(() => parse([...create, ...tail])).toThrow();
    }
    expect(() => parse(['codebase', 'mr', 'get', ...repo, '--', '--profile', 'evil'])).toThrow();
  });

  it('denies identity, execution and credential overrides in every argv position', () => {
    expect(parse(['codebase', 'repo', 'get', ...repo]).effect).toBe('read');
    const flags = ['--as', '--profile', '--jwt-file', '--auth-site', '--http-proxy', '--socks5-proxy',
      '--http-trace-file', '--http-header', '--jq', '--token', '--ak', '--sk', '--vdc',
      '--bytecloud-user-jwt-file', '--network-profile', '--ai-auth-subject', '--ai-auth-app-key',
      '--http-print', '--http-timeout-ms', '--http-body-limit'];
    for (const flag of flags) for (const index of [0, 1, 3, 5]) {
      const argv = ['codebase', 'repo', 'get', ...repo];
      argv.splice(index, 0, `${flag}=attacker`);
      expect(() => parse(argv), `${flag} at ${index}`).toThrow();
    }
    for (const flag of ['--debug', '-d', '--http-debug', '--no-redact', '--nomask', '--tls1.2', '--color', '--no-color']) {
      expect(() => parse(['codebase', 'repo', 'get', ...repo, flag])).toThrow();
    }
  });

  it('refuses unaudited effects, fields, URLs, local branch workflows and raw business bodies', () => {
    expect(parse(create).effect).toBe('write');
    for (const tail of [['--push'], ['--attach', '/tmp/file'], ['--meego', '123'], ['--auto-link-work-items'],
      ['--body-json', '{}'], ['--yes'], ['--unknown']]) expect(() => parse([...create, ...tail])).toThrow();
    for (const argv of [['codebase', 'mr', 'merge', '42', ...repo], ['codebase', 'mr', 'branch', 'create'],
      ['bits', 'develop', 'create', '--body', '{}'], ['meego', 'workitem', 'list'], ['rpc', 'test'],
      ['auth', 'get-bytecloud-jwt-token'], ['upgrade'], ['--site', 'i18n', 'codebase', 'repo', 'list'],
      ['codebase', 'mr', 'get', 'https://example.com/mr/42', ...repo]]) expect(() => parse(argv)).toThrow();
    expect(() => parse(['codebase', 'mr', 'create', ...repo, '--title', 'Demo'])).toThrow();
    expect(() => parse(['codebase', 'mr', 'update', '42', ...repo])).toThrow();
    expect(() => parse(['codebase', 'mr', 'update', '42', ...repo, '--draft', '--ready'])).toThrow();
    expect(() => parse(['codebase', 'repo', 'list', '--page-size', '101'])).toThrow();
  });

  it('uses immutable bounded UTF-8 snapshots instead of opening caller paths', () => {
    const inputs = { files: [{ id: 'description', dataBase64: Buffer.from('Review\nthis').toString('base64') }] };
    const op = parse([...create, '--body-file', 'description'], inputs);
    expect(op.stagedInputs).toEqual([{ id: 'description', flag: '--body-file', argvIndex: op.argv.indexOf('description'),
      dataBase64: 'UmV2aWV3CnRoaXM=', encoding: 'utf8' }]);
    inputs.files[0].dataBase64 = Buffer.from('Changed').toString('base64');
    expect(op.stagedInputs[0].dataBase64).toBe('UmV2aWV3CnRoaXM=');
    const stdinInputs = { stdinBase64: 'dGV4dA==' };
    const stdinOperation = parse([...create, '--body-file', '-'], stdinInputs);
    expect(stdinOperation.stagedInputs[0].id).toBe('stdin');
    expect(parse([...stdinOperation.argv], stdinInputs)).toEqual(stdinOperation);
    for (const input of [undefined, { files: [{ id: 'description', dataBase64: '/w==' }] },
      { files: [{ id: 'description', dataBase64: Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64') }] }]) {
      expect(() => parse([...create, '--body-file', 'description'], input)).toThrow();
    }
    expect(() => parse([...create, '--body-file', '/etc/passwd'], inputs)).toThrow();
    expect(() => parse(create, { stdinBase64: 'c2VjcmV0' })).toThrow();
    expect(() => parse([...create, '--body', '{}', '--body-file', 'description'], inputs)).toThrow();
    expect(() => parse([...create, '--title', 'x'.repeat(65_536)])).toThrow();
    expect(() => parse(Array(257).fill('x'))).toThrow();
  });

  it('routes safe personal auth and catalog help separately from business execution', () => {
    for (const action of ['status', 'userinfo', 'login', 'logout']) expect(parse(['auth', action]).effect).toBe('auth');
    expect(parse(['--version']).effect).toBe('help');
    expect(parse(['codebase', 'mr', '--help']).effect).toBe('help');
    expect(() => parse(['auth', 'status', '--force-refresh'])).toThrow();
    expect(() => parse(['auth', 'login', '--session'])).toThrow();
    expect(() => parse(['unknown', '--help'])).toThrow();
  });
});
