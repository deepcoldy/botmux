import { describe, expect, it } from 'vitest';
import {
  localJumpTargets, prepareLocalAddressContent, sanitizeLocalAddressNode, sanitizeLocalAddressText,
} from '../src/im/lark/local-address-policy.js';
import { isHostCapabilityLink } from '../src/core/host-capability-link.js';

describe('local address presentation policy', () => {
  it.each([
    '/home/alice/private.txt', '/Users/alice/private.txt', '/data00/home/alice/private.txt',
    '/tmp/result.txt', '/etc/botmux/private.json', '/usr/local/share/secret.txt', '/dev/shm/private.txt',
    '~/.agents/skills/a/SKILL.md', '$HOME/.config/a',
    '$' + '{HOME}/.config/a', '%USERPROFILE%\\private.txt', 'C:\\Users\\alice\\private.txt',
    'C:/Users/alice/private.txt', '\\\\devbox\\share\\private.txt',
    'file:///tmp/report.md', 'vscode://file/home/alice/main.ts',
    'http://localhost:3000/report', 'http://127.0.0.2/report', 'http://[::1]/report',
    'http://[::ffff:127.0.0.1]/report', 'http://2130706433/report',
    'http://alice@localhost:3000/report', '127.0.0.1:3000/report', 'localhost:3000/report',
    'http:/localhost:3000/report', 'http:\\localhost:3000/report', 'http:localhost:3000/report',
    'https:/127.0.0.1:3000/report', '0.0.0.0:3000/report', '[::1]:3000/report', '::1',
  ])('does not emit the concrete local address %s', address => {
    expect(sanitizeLocalAddressText('结果：' + address)).not.toContain(address);
  });

  it.each([
    '[技能](</home/alice/My Skills/SKILL.md>)',
    '[技能](%2Fhome%2Falice%2FSKILL.md)',
    '[技能](%252Fhome%252Falice%252FSKILL.md)',
    '[技能](home/alice/SKILL.md)',
    '[技能](./SKILL.md)',
    '[技能](</data00/home/alice/My Skills/SKILL.md',
  ])('preserves only the name of a skill link: %s', text => {
    expect(sanitizeLocalAddressText(text)).toBe('技能');
  });

  it('converts workspace paths and line numbers to relative references', () => {
    const context = { workspaceRoots: ['/srv/project', '/custom/project'] };
    expect(sanitizeLocalAddressText('[入口](/srv/project/src/index.ts:12)', context)).toBe('入口 (src/index.ts:12)');
    expect(sanitizeLocalAddressText('修改 /custom/project/src/index.ts:12', context)).toBe('修改 src/index.ts:12');
    expect(sanitizeLocalAddressText('修改 /srv/project/../../home/alice/secret', context)).not.toContain('/home/alice');
  });

  it('handles reference-style links and removes the local definition', () => {
    const text = '[技能][ref]\n\n[ref]: /home/alice/SKILL.md "说明"\n\n[活动][remote]\n\n[remote]: https://example.com/path?x=1';
    const output = sanitizeLocalAddressText(text);
    expect(output).toContain('技能');
    expect(output).not.toContain('[技能][ref]');
    expect(output).not.toContain('[ref]:');
    expect(output).not.toContain('/home/');
    expect(output).toContain('[活动][remote]');
    expect(output).toContain('[remote]: https://example.com/path?x=1');
  });

  it('keeps remote URLs, API paths, relative source text and mentions unchanged', () => {
    const text = '[业务](https://example.com/home/page?file=/tmp/x&v=%2FUsers%2Falice)\n'
      + '[外部](//example.com/path)\nGET /api/items\nsrc/index.ts:12\n<at id=ou_user></at>';
    expect(sanitizeLocalAddressText(text)).toBe(text);
  });

  it('preserves native Feishu image keys in Markdown while removing local image sources', () => {
    const safe = '![预览](img_v3_uploaded_preview)';
    expect(sanitizeLocalAddressText(safe)).toBe(safe);
    expect(sanitizeLocalAddressText('![预览](/tmp/receipt.png)')).not.toContain('/tmp/');
  });

  it.each(['[::ffff:127.0.0.1]:3000/report', '[::ffff:7f00:1]:3000/report', '::ffff:127.0.0.1'])(
    'does not leave an IPv4-mapped loopback behind after Markdown parsing: %s', address => {
      const output = sanitizeLocalAddressText(address);
      expect(output).not.toContain('127.0.0.1');
      expect(output).not.toContain('::ffff:');
    });

  it('handles local service addresses after ASCII punctuation and across network protocols', () => {
    expect(sanitizeLocalAddressText('地址:localhost:3000/report')).not.toContain('localhost');
    expect(sanitizeLocalAddressText('ws://[::1]:3000/report')).not.toContain('::1');
    expect(() => sanitizeLocalAddressNode({ url: 'ws://localhost:3000/report' })).toThrow();
    const remote = '[业务](wss://example.com/home/page?file=/tmp/report)';
    expect(sanitizeLocalAddressText(remote)).toBe(remote);
  });

  it.each(['git+https://github.com/org/repo.git', 'seehttps://example.com/a ok', 'svn+http://example.com/trunk'])(
    'writes a URL behind a scheme prefix once: %s', text => {
      expect(sanitizeLocalAddressText(text)).toBe(text);
    });

  it('replaces a local URL behind a scheme prefix once', () => {
    expect(sanitizeLocalAddressText('git+http://127.0.0.1:3000/x ok', { internalFileLabel: '[F]' })).toBe('[F] ok');
  });

  it('uses explicit local host identity without rejecting other private-network services', () => {
    const context = { localHosts: ['devbox.example.internal', '10.20.30.40'] };
    const local = 'http://devbox.example.internal:3000/report';
    expect(sanitizeLocalAddressText(local, context)).not.toContain(local);
    expect(sanitizeLocalAddressText('http://10.20.30.40:3000/report', context)).not.toContain('10.20.30.40');
    expect(sanitizeLocalAddressText('http://[::ffff:10.20.30.40]:3000/report', context)).not.toContain('::ffff:');
    expect(sanitizeLocalAddressText('http://10.20.30.41/api', context)).toBe('http://10.20.30.41/api');
  });

  it.each(['ubuntu', 'master', 'devbox'])('keeps ordinary words that happen to be the machine name: %s', name => {
    const context = { localHosts: [name] };
    const prose = `On Ubuntu 22.04, merge into master or origin/master; the devbox image ships node 22.`;
    expect(sanitizeLocalAddressText(prose, context)).toBe(prose);
    expect(sanitizeLocalAddressText(`dev server ${name}:3000/report`, context)).not.toContain(`${name}:3000`);
    expect(sanitizeLocalAddressText(`http://${name}:3000/report`, context)).not.toContain(`${name}:3000`);
  });

  it.each([
    'ls 2>/dev/null', 'cmd >/dev/null 2>&1', 'cat /dev/stdin', 'echo x > /dev/stderr', 'echo x >/dev/stdout',
    'diff <(a) /dev/fd/63', 'cat /proc/cpuinfo', 'cat /proc/1234/status', 'ls -l /proc/self/fd/3',
    'cat /sys/class/net/eth0/address', 'mount | grep /proc',
  ])('keeps a system path that names no user file: %s', text => {
    expect(sanitizeLocalAddressText(text)).toBe(text);
  });

  it.each([
    '/dev/tty', '/dev/null.d/x', '/dev/fd/3/secret', '/proc/self/cwd/src/main.ts', '/proc/1/root/home/alice/x',
    '/proc/self/task/12/cwd/x', '/proc/../home/alice/x', '/sys/../root/.ssh/id_rsa',
  ])('still covers a user file reached through a system path: %s', address => {
    const out = sanitizeLocalAddressText('结果：' + address);
    expect(out).toContain('【内部文件】');
    expect(out).not.toMatch(/tty|null\.d|secret|main\.ts|alice|id_rsa|\/x$/);
  });

  it('exempts system paths in prose only', () => {
    expect(sanitizeLocalAddressText('ls 2>/dev/null && cat /home/alice/secret.txt')).toBe('ls 2>/dev/null && cat 【内部文件】');
    expect(sanitizeLocalAddressText('/dev/null:/home/alice/secret')).toBe('/dev/null:【内部文件】');
    expect(sanitizeLocalAddressText('[日志](/dev/null)')).toBe('日志（未提供可访问链接）');
    expect(() => sanitizeLocalAddressNode({ url: '/proc/cpuinfo' })).toThrow();
  });

  it('checks only card link fields in link-field mode', () => {
    const context = { linkFieldsOnly: true };
    const prose = '恢复：cd /root/iserver/repo && claude --resume 1 · http://127.0.0.1:3000/ · [技能](/home/alice/SKILL.md)';
    expect(prepareLocalAddressContent(prose, 'text', context)).toBe(prose);
    const card = JSON.stringify({ body: { elements: [{ tag: 'markdown', content: prose }] } });
    expect(prepareLocalAddressContent(card, 'interactive', context)).toBe(card);
    const malformed = '{"text": "' + prose;
    expect(() => prepareLocalAddressContent(malformed, 'interactive')).toThrow();
    expect(prepareLocalAddressContent(malformed, 'interactive', context)).toBe(malformed);
    expect(() => prepareLocalAddressContent(JSON.stringify({ body: { elements: [{ tag: 'button', url: 'http://127.0.0.1:3000/' }] } }),
      'interactive', context)).toThrow();
    expect(() => prepareLocalAddressContent(JSON.stringify({ zh_cn: { content: [[{ tag: 'a', text: 'x', href: 'file:///tmp/a' }]] } }),
      'post', context)).toThrow();
  });

  describe('host capability links', () => {
    const scope = { hosts: ['10.20.30.40'], dashboardPorts: ['7891'] };
    const context = { localHosts: ['10.20.30.40'], hostIssuedLink: (url: string) => isHostCapabilityLink(url, scope) };
    const cap = 'view_Token-abcdefghijklmnopqrstuvwxyz012345';
    const sid = '3f2b6c1e-8d4a-4f6b-9c2d-1a2b3c4d5e6f';
    const wrap = (url: string) => 'https://applink.feishu.cn/client/web_url/open?'
      + new URLSearchParams({ mode: 'sidebar-semi', width: '800', url }).toString();
    const rejected = expect.objectContaining({ code: 'LOCAL_ADDRESS_OUTBOUND_REJECTED' });

    it.each([
      `http://10.20.30.40:8800/s/${sid}`, `http://10.20.30.40:8800/s/${sid}?viewToken=${cap}`,
      `http://10.20.30.40:45678/?viewToken=${cap}`, 'http://10.20.30.40:45678/?token=0123456789abcdef0123456789abcdef',
      'http://10.20.30.40:7891/', `http://10.20.30.40:7891/?t=${cap}`, 'http://10.20.30.40:7891/#/v3/run-1',
      'http://10.20.30.40:7891/#/workflows/run-1', `http://10.20.30.40:7891/#/sessions?session=${sid}`,
      `http://10.20.30.40:7891/?t=${cap}#/agent-workbench?botmuxWorkbenchShell=immersive`,
      'http://10.20.30.40:7891/workbench', `http://10.20.30.40:7891/workbench?t=${cap}`, `http://10.20.30.40:7891/plugin-result-access/${cap}`,
      'http://10.20.30.40:7891/board/cli_a1/12', 'http://10.20.30.40:7891/workflow/cli_a1/run-1',
      wrap(`http://10.20.30.40:8800/s/${sid}?viewToken=${cap}`),
      'https://applink.larksuite.com/client/web_url/open?mode=appCenter&url=' + encodeURIComponent('http://10.20.30.40:7891/board/cli_a1/12'),
    ])('sends the host link shape %s', url => {
      expect(() => sanitizeLocalAddressNode({ url }, { localHosts: scope.hosts })).toThrowError(rejected);
      expect(sanitizeLocalAddressNode({ url }, context)).toEqual({ url });
    });

    it.each([
      'http://10.20.30.40:3000/', 'http://10.20.30.40:45678/', 'http://10.20.30.40:45678/anything',
      'http://10.20.30.40:45678/?viewToken=GUESS', `http://10.20.30.40:45678/?viewToken=${cap}&next=x`,
      'http://10.20.30.40:8800/s/victim?token=x', `http://10.20.30.40:8800/s/${sid}/../../etc`, `http://10.20.30.40:8800/s/${sid}/x`,
      `http://10.20.30.40:8800/s/${sid}#/x`, 'http://10.20.30.40:3000/#/v3/run-1',
      'http://10.20.30.40:7891/?t=GUESSED', `http://10.20.30.40:7891/?token=${cap}`, `http://10.20.30.40:7891/?viewToken=${cap}`,
      'http://10.20.30.40:7891/#/settings', 'http://10.20.30.40:7891/admin',
      'http://10.20.30.40:7891/__daemon/shutdown', 'http://10.20.30.40:7891/plugin-result-access/short',
      `http://10.20.30.40:7891/plugin-result-access/${cap}?t=${cap}`, `http://10.20.30.40:7891/?t=${cap}&x=1`,
      'http://alice@10.20.30.40:7891/', 'https://10.20.30.40:7891/', 'http://127.0.0.1:7891/', 'file:///tmp/report.md',
      wrap('http://10.20.30.40:5173/'), wrap('http://10.20.30.40:7891/') + '&next=' + encodeURIComponent('http://10.20.30.40:3000/'),
      wrap('http://10.20.30.40:7891/') + '&url=x', wrap(wrap('http://10.20.30.40:7891/')),
      'https://example.com/client/web_url/open?url=' + encodeURIComponent('http://10.20.30.40:7891/'),
      'https://example.com/login?next=' + encodeURIComponent('http://10.20.30.40:3000/'),
      'https://example.com/r/' + encodeURIComponent(encodeURIComponent('http://10.20.30.40:3000/x')),
    ])('rejects %s', url => {
      expect(() => sanitizeLocalAddressNode({ url }, context)).toThrowError(rejected);
    });

    it('scrubs local pages nested in a remote link from prose, host link or not', () => {
      for (const url of [wrap(`http://10.20.30.40:8800/s/${sid}?viewToken=${cap}`),
        'https://example.com/login?next=' + encodeURIComponent('http://10.20.30.40:3000/')]) {
        expect(sanitizeLocalAddressText(`[打开](${url}) 或 ${url}`, context)).not.toContain('10.20.30.40');
      }
      const remote = 'https://example.com/login?next=' + encodeURIComponent('https://docs.example.com/a');
      expect(sanitizeLocalAddressText(`[登录](${remote}) ${remote}`, context)).toBe(`[登录](${remote}) ${remote}`);
      expect(sanitizeLocalAddressNode({ url: remote }, context)).toEqual({ url: remote });
    });
  });

  it('lists only the local jump targets of a card body', () => {
    const wrapped = 'https://applink.feishu.cn/client/web_url/open?url=' + encodeURIComponent('http://10.20.30.40:7891/s/b');
    const body = JSON.stringify({ body: { elements: [
      { tag: 'button', multi_url: { url: 'https://applink.feishu.cn/x', android_url: 'http://10.20.30.40:7891/s/a' } },
      { tag: 'button', url: wrapped },
      { tag: 'button', behaviors: [{ type: 'callback', value: { url: 'http://10.20.30.40:7891/opaque' } }] },
      { tag: 'markdown', content: '[x](http://10.20.30.40:7891/text)' },
    ] } });
    expect(localJumpTargets(body, 'interactive', { localHosts: ['10.20.30.40'] })).toEqual(['http://10.20.30.40:7891/s/a', wrapped]);
    expect(localJumpTargets(body, 'text', { localHosts: ['10.20.30.40'] })).toEqual([]);
  });

  it.each(['https://127.example.com/home/page', 'https://127.0.0.1.example.com/tmp/report'])(
    'preserves a remote domain starting with 127: %s', url => {
      const link = '[业务](' + url + ')';
      expect(sanitizeLocalAddressText(link)).toBe(link);
      expect(sanitizeLocalAddressNode({ url })).toEqual({ url });
    });

  it('processes nested card fields while preserving opaque callback values', () => {
    const value = { action: 'open', path: '/tmp/state.json' };
    const raw = { body: { elements: [{ tag: 'table', rows: [{ a: '/home/alice/result.md' }] },
      { tag: 'button', text: { content: '看 /tmp/result' }, behaviors: [{ type: 'callback', value }] }] } };
    const clean = sanitizeLocalAddressNode(raw);
    expect(clean.body.elements[0]).not.toEqual(raw.body.elements[0]);
    expect(clean.body.elements[1].behaviors?.[0].value).toBe(value);
    expect(raw.body.elements[0].rows?.[0].a).toBe('/home/alice/result.md');
  });

  it('rejects a local URL in any platform-specific jump field without echoing it', () => {
    const target = 'file:///home/alice/private.md';
    try {
      sanitizeLocalAddressNode({ behaviors: [{ type: 'open_url', ios_url: target }] });
      expect.fail('a local jump URL must be refused');
    } catch (error: any) {
      expect(error.code).toBe('LOCAL_ADDRESS_OUTBOUND_REJECTED');
      expect(error.message).not.toContain(target);
    }
  });

  it.each(['http:/localhost:3000/report', 'http:\\localhost:3000/report', 'http:localhost:3000/report',
    'https:/127.0.0.1:3000/report'])(
    'rejects a local jump normalized by WHATWG URL parsing: %s', target => {
      expect(() => sanitizeLocalAddressNode({ behaviors: [{ type: 'open_url', default_url: target }] }))
        .toThrowError(expect.objectContaining({ code: 'LOCAL_ADDRESS_OUTBOUND_REJECTED' }));
    });

  it('refuses malformed local JSON but preserves safe malformed input for provider validation', () => {
    expect(() => prepareLocalAddressContent('{"content":"/tmp/result', 'interactive')).toThrow();
    expect(prepareLocalAddressContent('{"content":"safe', 'interactive')).toBe('{"content":"safe');
  });

  it('is idempotent and does not invent a remote link for an undelivered artifact', () => {
    const output = sanitizeLocalAddressText('[完整报告](file:///tmp/report.md)');
    expect(output).toContain('完整报告');
    expect(output).not.toMatch(/\]\(|https?:/);
    expect(sanitizeLocalAddressText(output)).toBe(output);
  });
});
