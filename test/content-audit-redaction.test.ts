import { describe, expect, it, vi } from 'vitest';
import {
  ALL_SENSITIVE_CATEGORIES,
  contentAuditRedactionOutcome,
  contentAuditSensitiveTypes,
  redactLarkMessageContent,
  redactSensitiveText,
  sendWithContentAuditRedaction,
} from '../src/im/lark/content-audit-redaction.js';
import { LarkApiError } from '../src/im/lark/lark-errors.js';

/** Axios-shaped rejection exactly as the Lark SDK surfaces a 400 from im/v1/messages. */
function auditError(msg: string, code = 230028) {
  return {
    isAxiosError: true,
    name: 'AxiosError',
    message: 'Request failed with status code 400',
    config: { method: 'post', url: 'https://open.feishu.cn/open-apis/im/v1/messages' },
    response: { status: 400, data: { code, msg } },
  };
}
const EMAIL_REJECT = 'The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS';

/** Append the Luhn check digit so bank-card fixtures are valid by construction. */
function withLuhn(body: string): string {
  for (let check = 0; check <= 9; check++) {
    const digits = body + check;
    let sum = 0;
    let double = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let digit = Number(digits[i]);
      if (double) { digit *= 2; if (digit > 9) digit -= 9; }
      sum += digit;
      double = !double;
    }
    if (sum % 10 === 0) return digits;
  }
  throw new Error('unreachable');
}

/** GB 11643 check character for an 18-digit resident ID. */
function withIdCheck(body17: string): string {
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const sum = [...body17].reduce((acc, ch, i) => acc + Number(ch) * weights[i], 0);
  return body17 + '10X98765432'[sum % 11];
}

const UNIONPAY_19 = withLuhn('622202123456789012');
const VISA_16 = withLuhn('411111111111111');
const ID_CARD = withIdCheck('11010519491231002');
const ID_CARD_2 = withIdCheck('44030420000229123');

describe('contentAuditSensitiveTypes', () => {
  it('maps the type Lark reports to the matching category', () => {
    expect(contentAuditSensitiveTypes(auditError(EMAIL_REJECT))).toEqual({
      types: ['EMAIL_ADDRESS'], categories: ['email'], exact: true,
    });
    expect(contentAuditSensitiveTypes(auditError('contain sensitive data: PHONE_NUMBER, ID_CARD_NUMBER, BANK_CARD')))
      .toMatchObject({ categories: ['phone', 'idCard', 'bankCard'], exact: true });
  });

  it('reads the 2xx-body LarkApiError shape too', () => {
    const err = new LarkApiError('Failed to send message: x (code: 230028)', 230028, 'contain sensitive data: EMAIL_ADDRESS');
    expect(contentAuditSensitiveTypes(err).categories).toEqual(['email']);
  });

  it('falls back to every category when the type is missing or unknown', () => {
    expect(contentAuditSensitiveTypes(auditError('The messages do NOT pass the audit'))).toEqual({
      types: [], categories: [...ALL_SENSITIVE_CATEGORIES], exact: false,
    });
    expect(contentAuditSensitiveTypes(auditError('contain sensitive data: EMAIL_ADDRESS, SOMETHING_NEW')))
      .toMatchObject({ categories: [...ALL_SENSITIVE_CATEGORIES], exact: false });
    expect(contentAuditSensitiveTypes(undefined).categories).toEqual([...ALL_SENSITIVE_CATEGORIES]);
  });
});

describe('redactSensitiveText', () => {
  it.each([
    ['git author line', 'Author: Alice Liu <alice.liu@example.com>', 'Author: Alice Liu <**********example.com>'],
    ['committer noreply', 'Committer: GitHub <noreply@github.com>', 'Committer: GitHub <********github.com>'],
    ['GitHub noreply in a code span', '`12345678+bob@users.noreply.github.com`', '`*************users.noreply.github.com`'],
    ['co-author trailer', 'Co-Authored-By: Claude <noreply@anthropic.com>', 'Co-Authored-By: Claude <********anthropic.com>'],
    ['SSH remote (Lark flags it as an email)', 'remote git@github.com:owner/repo.git', 'remote ****github.com:owner/repo.git'],
    ['ssh:// URL', 'clone "ssh://git@ssh.example.com/owner/repo"', 'clone "ssh://****ssh.example.com/owner/repo"'],
    ['truncated with a leading ellipsis', 'Author <...7f3a@example.com>', 'Author <...*****example.com>'],
    ['fediverse handle', 'follow @alice@social.example.org', 'follow @******social.example.org'],
    ['adjacent CJK and full-width punctuation', '邮箱zhangsan@example.net，', '邮箱*********example.net，'],
    ['subdomain + sentence period', 'x@sub.mail.example.org.', '**sub.mail.example.org.'],
    ['uppercase, multi-label TLD', 'A.B-C_d%e@Foo-Bar.CO.UK', '**********Foo-Bar.CO.UK'],
    ['mailto link text', '[mail](mailto:ops@corp.example.org)', '[mail](mailto:****corp.example.org)'],
  ])('masks emails: %s', (_name, input, expected) => {
    const out = redactSensitiveText(input, ['email']);
    expect(out.text).toBe(expected);
    expect(out.text).toHaveLength(input.length);
    expect(out.hits.email).toBe(1);
  });

  it('masks mainland phone numbers in common spellings and landlines', () => {
    const input = '手机 13812345678、+86 138 1234 5678、0086-13912345678、152-0000-1111，座机 010-12345678';
    const out = redactSensitiveText(input, ['phone']);
    expect(out.text).toBe('手机 ***********、+** *** **** ****、****-***********、***-****-****，座机 ***-********');
    expect(out.hits.phone).toBe(5);
  });

  it('masks numbers written right after a colon or hash label', () => {
    const input = `手机:13812345678 Phone:13812345678 Tel:+86-13812345678 #13812345678 身份证:${ID_CARD} 卡号:${UNIONPAY_19}`;
    const out = redactSensitiveText(input, ALL_SENSITIVE_CATEGORIES);
    expect(out.text).toBe(`手机:*********** Phone:*********** Tel:+**-*********** #*********** 身份证:${'*'.repeat(18)} 卡号:${'*'.repeat(19)}`);
    expect(out.hits).toMatchObject({ phone: 4, idCard: 1, bankCard: 1 });
  });

  it('escapes masks in markdown outside code so they render as literal stars, not emphasis', () => {
    const input = 'a@example.com and b@example.org, `c@example.net`\n```\nd@example.com\n```';
    const out = redactSensitiveText(input, ['email'], undefined, { markdown: true });
    expect(out.text).toBe('\\*\\*example.com and \\*\\*example.org, `**example.net`\n```\n**example.com\n```');
    expect(out.hits.email).toBe(4);
    // Plain text (text messages, plain_text nodes) keeps the bare stars.
    expect(redactSensitiveText('a@example.com', ['email']).text).toBe('**example.com');
  });

  it('masks resident ID numbers (checksum-valid) and bank cards (prefix + Luhn)', () => {
    const grouped = VISA_16.replace(/(\d{4})(?=\d)/g, '$1 ');
    const input = `身份证 ${ID_CARD} / ${ID_CARD_2.toLowerCase()}，卡号 ${UNIONPAY_19}，${grouped}`;
    const out = redactSensitiveText(input, ['idCard', 'bankCard']);
    expect(out.text).toBe(`身份证 ${'*'.repeat(18)} / ${'*'.repeat(18)}，卡号 ${'*'.repeat(19)}，**** **** **** ****`);
    expect(out.hits).toMatchObject({ idCard: 2, bankCard: 2 });
  });

  it.each([
    ['decorators and scoped packages', '@Component @Injectable() @types/node @scope/pkg @scope/pkg@1.2.3'],
    ['versions', 'bun@1.4.3 react@^18.2.0 node@22.13 pkg@2.0.0-rc.1 v3.57.1'],
    ['git reflog refs', 'HEAD@{1} stash@{0} main@{2.days.ago} @{u}'],
    ['mention markup', '<at id=ou_abc></at> <at email=foo@example.com></at> <at user_id="ou_x">Tom</at> <at id=all></at>'],
    ['commit sha / PR / timestamps', 'sha 42066737e a731b8b65cafe1234567890abcdef PR #2849 2026-11-05T15:16:02.775Z 1793809346783 1793809346'],
    ['long numeric ids', 'feed 7704631496199457811 msg 7704684887944514490 run 40140035496 user 1793809346783'],
    ['digits inside URLs', 'https://github.com/o/r/actions/runs/13812345678 https://x.com/u/622202123456789012'],
    ['line ranges and decimals', '文件:6448-6728 1.13812345678 13812345678.5'],
    ['code-file "domains"', 'x@y.ts import x from "a@b.js" foo@bar.md'],
    ['retina asset names', 'added icon@2x.png and logo@3x.webp'],
    ['Kotlin labels', 'val root = this@MainActivity.window; super@Outer.run()'],
    ['checksum-invalid 18-digit and non-Luhn 19-digit', `110105194912310021 ${UNIONPAY_19.slice(0, -1)}${(Number(UNIONPAY_19.slice(-1)) + 1) % 10}`],
  ])('leaves %s untouched', (_name, input) => {
    const out = redactSensitiveText(input, ALL_SENSITIVE_CATEGORIES);
    expect(out.text).toBe(input);
    expect(Object.values(out.hits).every(count => count === 0)).toBe(true);
  });

  it('only touches the requested categories', () => {
    const input = 'a@example.com 13812345678';
    expect(redactSensitiveText(input, ['email']).text).toBe('**example.com 13812345678');
    expect(redactSensitiveText(input, ['phone']).text).toBe('a@example.com ***********');
  });
});

describe('redactLarkMessageContent', () => {
  const NOTE = '部分内容已自动打码';

  it('changes only text nodes of a schema 2.0 card and adds one note before the footer', () => {
    const card = {
      schema: '2.0',
      config: { update_multi: true },
      header: { title: { tag: 'plain_text', content: 'Review for a@example.com' } },
      body: {
        elements: [
          { tag: 'markdown', element_id: 'answer', content: 'Author `X <x@example.org>` <at id=ou_owner></at>' },
          {
            tag: 'table', columns: [{ name: 'c0', display_name: 'owner@example.net', data_type: 'lark_md' }],
            rows: [{ c0: 'y@example.org' }],
          },
          { tag: 'button', text: { tag: 'plain_text', content: '打开' }, behaviors: [{ type: 'callback', value: { k: 'cb@example.com' } }] },
          { tag: 'markdown', content: '[mail](mailto:m@example.org)', href: 'mailto:m@example.org' },
          { tag: 'hr' },
          { tag: 'markdown', element_id: 'botmux_reply_footer', text_size: 'notation', content: "<font color='grey'>botmux · 发送给：<at id=ou_x></at></font>" },
        ],
      },
    };
    const out = redactLarkMessageContent(JSON.stringify(card), 'interactive', ['email'], NOTE)!;
    expect(out.hits.email).toBe(6);
    const parsed = JSON.parse(out.content);
    expect(parsed.header.title.content).toBe('Review for **example.com');
    const els = parsed.body.elements;
    expect(els[0]).toEqual({ tag: 'markdown', element_id: 'answer', content: 'Author `X <**example.org>` <at id=ou_owner></at>' });
    expect(els[1].columns[0]).toEqual({ name: 'c0', display_name: '******example.net', data_type: 'lark_md' });
    expect(els[1].rows[0].c0).toBe('\\*\\*example.org');
    // Callback payloads are not text: changing them would break the button.
    expect(els[2].behaviors).toEqual(card.body.elements[2].behaviors);
    expect(els[3].href).toBe('mailto:**example.org');
    // Note sits between the answer and the signature row (hr + footer).
    expect(els.map((el: any) => el.element_id ?? el.tag))
      .toEqual(['answer', 'table', 'button', 'markdown', 'botmux_audit_redacted', 'hr', 'botmux_reply_footer']);
    expect(els[4].content).toContain(NOTE);
    expect(els[6]).toEqual(card.body.elements[5]);
    expect(parsed.config).toEqual(card.config);
  });

  it('appends a note element to a legacy (schema 1.0) card', () => {
    const card = { config: { wide_screen_mode: true }, elements: [{ tag: 'div', text: { tag: 'lark_md', content: 'mail a@example.com' } }] };
    const parsed = JSON.parse(redactLarkMessageContent(JSON.stringify(card), 'interactive', ['email'], NOTE)!.content);
    expect(parsed.elements[0].text).toEqual({ tag: 'lark_md', content: 'mail \\*\\*example.com' });
    expect(parsed.elements[1]).toEqual({ tag: 'note', elements: [{ tag: 'plain_text', content: NOTE }] });
  });

  it.each([
    ['locale-keyed', (body: unknown) => ({ zh_cn: body }), (parsed: any) => parsed.zh_cn],
    ['flat', (body: unknown) => body, (parsed: any) => parsed],
  ])('redacts post rich text (%s) node by node', (_name, wrap, unwrap) => {
    const body = {
      title: '联系 a@example.com',
      content: [[
        { tag: 'text', text: '作者 x@example.org 电话 13812345678', style: ['bold'] },
        { tag: 'at', user_id: 'ou_123', user_name: 'Tom' },
        { tag: 'a', text: '主页', href: 'https://example.com/u/13812345678' },
        { tag: 'code_block', language: 'GO', text: 'git log --format="%an <%ae>"  # me@example.org' },
      ]],
    };
    const out = redactLarkMessageContent(JSON.stringify(wrap(body)), 'post', ALL_SENSITIVE_CATEGORIES, NOTE)!;
    expect(out.hits).toMatchObject({ email: 3, phone: 1 });
    const post = unwrap(JSON.parse(out.content));
    expect(post.title).toBe('联系 **example.com');
    expect(post.content[0][0]).toEqual({ tag: 'text', text: '作者 **example.org 电话 ***********', style: ['bold'] });
    expect(post.content[0][1]).toEqual(body.content[0][1]);
    expect(post.content[0][2]).toEqual(body.content[0][2]);
    expect(post.content[0][3].text).toBe('git log --format="%an <%ae>"  # ***example.org');
    expect(post.content[1]).toEqual([{ tag: 'text', text: NOTE }]);
  });

  it('escapes masks only in markdown-rendered nodes (post md, lark_md table columns)', () => {
    const post = { zh_cn: { title: 't', content: [[{ tag: 'md', text: 'x a@example.com' }, { tag: 'text', text: 'y a@example.com' }]] } };
    const outPost = JSON.parse(redactLarkMessageContent(JSON.stringify(post), 'post', ['email'])!.content);
    expect(outPost.zh_cn.content[0]).toEqual([{ tag: 'md', text: 'x \\*\\*example.com' }, { tag: 'text', text: 'y **example.com' }]);
    const card = { schema: '2.0', body: { elements: [{ tag: 'table',
      columns: [{ name: 'md', data_type: 'lark_md' }, { name: 'plain', data_type: 'text' }],
      rows: [{ md: 'a@example.com', plain: 'a@example.com' }] }] } };
    const outCard = JSON.parse(redactLarkMessageContent(JSON.stringify(card), 'interactive', ['email'])!.content);
    expect(outCard.body.elements[0].rows[0]).toEqual({ md: '\\*\\*example.com', plain: '**example.com' });
  });

  it('treats text messages as plain text and appends the note on its own line', () => {
    expect(redactLarkMessageContent('ping a@example.com', 'text', ['email'], NOTE))
      .toMatchObject({ content: `ping **example.com\n${NOTE}`, total: 1 });
    expect(redactLarkMessageContent('nothing here', 'text', ['email'], NOTE))
      .toMatchObject({ content: 'nothing here', total: 0 });
  });

  it('refuses payloads it cannot edit structurally', () => {
    expect(redactLarkMessageContent('{"file_key":"x"}', 'file', ['email'], NOTE)).toBeUndefined();
    expect(redactLarkMessageContent('not json a@example.com', 'interactive', ['email'], NOTE)).toBeUndefined();
  });
});

describe('sendWithContentAuditRedaction', () => {
  const NOTE = 'masked';

  it('resends a masked copy once after an audit rejection', async () => {
    const send = vi.fn().mockRejectedValueOnce(auditError(EMAIL_REJECT)).mockResolvedValueOnce('om_ok');
    const log = vi.fn();
    await expect(sendWithContentAuditRedaction({ content: 'hi a@example.com', msgType: 'text', send, note: NOTE, log }))
      .resolves.toBe('om_ok');
    expect(send.mock.calls.map(call => call[0])).toEqual(['hi a@example.com', `hi **example.com\n${NOTE}`]);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/types=EMAIL_ADDRESS .*hits=email:1 result=delivered/));
    expect(log.mock.calls.flat().join('\n')).not.toContain('a@example.com');
  });

  it('widens to every category when the reported type finds nothing', async () => {
    const send = vi.fn().mockRejectedValueOnce(auditError(EMAIL_REJECT)).mockResolvedValueOnce('om_ok');
    await sendWithContentAuditRedaction({ content: 'call 13812345678', msgType: 'text', send, note: NOTE });
    expect(send.mock.calls[1][0]).toBe(`call ***********\n${NOTE}`);
  });

  it('does not resend when nothing can be masked, and records that on the error', async () => {
    const rejection = auditError(EMAIL_REJECT);
    const send = vi.fn().mockRejectedValue(rejection);
    await expect(sendWithContentAuditRedaction({ content: 'plain words', msgType: 'text', send, note: NOTE }))
      .rejects.toBe(rejection);
    expect(send).toHaveBeenCalledTimes(1);
    expect(contentAuditRedactionOutcome(rejection)).toMatchObject({ retried: false, types: ['EMAIL_ADDRESS'] });
  });

  it('retries at most once and surfaces the second rejection', async () => {
    const second = auditError(EMAIL_REJECT);
    const send = vi.fn().mockRejectedValueOnce(auditError(EMAIL_REJECT)).mockRejectedValueOnce(second);
    await expect(sendWithContentAuditRedaction({ content: 'a@example.com', msgType: 'text', send, note: NOTE }))
      .rejects.toBe(second);
    expect(send).toHaveBeenCalledTimes(2);
    expect(contentAuditRedactionOutcome(second)).toMatchObject({ retried: true, hits: { email: 1 } });
  });

  it('passes non-audit failures through untouched', async () => {
    const transient = new Error('socket hang up');
    const send = vi.fn().mockRejectedValue(transient);
    await expect(sendWithContentAuditRedaction({ content: 'a@example.com', msgType: 'text', send, note: NOTE }))
      .rejects.toBe(transient);
    expect(send).toHaveBeenCalledTimes(1);
    expect(contentAuditRedactionOutcome(transient)).toBeUndefined();
  });
});
