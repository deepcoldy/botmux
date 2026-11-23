import { describe, expect, it } from 'vitest';
import { WebTerminalInputClassifier } from '../src/core/web-terminal-input.js';

const replies = [10, 11, 12].flatMap(code => ['\x1b]', '\x9d'].flatMap(start =>
  ['\x07', '\x1b\\', '\x9c'].map(end => `${start}${code};rgb:1/aB/1234${end}`)))
  .concat(['\x1b[I', '\x1b[O', '\x9bI', '\x9bO']);

const escapeBoundaries = [
  { timing: 'immediate', now: 1 },
  { timing: 'at deadline', now: 10 },
  { timing: 'after deadline', now: 11 },
].flatMap(boundary => [false, true].map(forceUser => ({
  ...boundary, forceUser, escape: forceUser ? 'force-user' : 'buffered',
})));

describe('WebTerminalInputClassifier', () => {
  it.each(replies)('forwards the entire supported reply without user activity: %j', reply => {
    const c = new WebTerminalInputClassifier();
    expect(c.push(reply, {}, 0)).toMatchObject({ data: reply, hasUser: false, maySubmit: false, pending: false });
  });

  it.each(replies)('handles every split of a supported reply: %j', reply => {
    for (let cut = 1; cut < reply.length; cut++) {
      const c = new WebTerminalInputClassifier();
      const a = c.push(reply.slice(0, cut), {}, 0);
      expect(a.data).toBe('');
      expect(a.pending).toBe(true);
      const b = c.push(reply.slice(cut), {}, 1);
      expect(b).toMatchObject({ data: reply, hasUser: false, maySubmit: false, pending: false });
    }
  });

  it('streams one byte at a time and multiple responses without loss or double forwarding', () => {
    const c = new WebTerminalInputClassifier();
    const data = replies.join('');
    let forwarded = '';
    for (const ch of data) {
      const out = c.push(ch, {}, 0);
      forwarded += out.data;
      expect(out.hasUser).toBe(false);
    }
    expect(forwarded).toBe(data);
    expect(c.pending).toBe(false);
  });

  it.each([
    '\x1b[A', '\x1b[B', '\x1b[C', '\x1b[D', '\x1bOA', '\x1b[1;2R',
    '\x1b[<0;2;3M', '\x1b[<32;2;3M', '\x1b[<64;2;3M', '\x1b[<65;2;3m',
    '\x03', '\x7f', '\t', '中文🌱', '\x1b]52;c;YQ==\x07',
    '\x1b]11;rgb:12345/0/0\x07', '\x1b]11;rgb:/0/0\x07',
    '\x1b]11;rgb:0/0/0x\x07', '\x1b[?1;2c',
  ])('keeps user controls and non-whitelisted sequences as user input: %j', input => {
    const c = new WebTerminalInputClassifier();
    expect(c.push(input, {}, 0)).toMatchObject({ data: input, hasUser: true, pending: false });
  });

  it('keeps reply/text mixtures and Unicode in their exact order', () => {
    const c = new WebTerminalInputClassifier();
    const mixed = replies[0] + '草稿🌱' + replies[1] + '\r';
    expect(c.push(mixed, {}, 0)).toMatchObject({ data: mixed, hasUser: true, maySubmit: true, pending: false });
  });

  it('force-user only upgrades and can immediately forward a user Escape', () => {
    const c = new WebTerminalInputClassifier();
    const out = c.push('\x1b', { forceUser: true }, 0);
    expect(out).toMatchObject({ data: '\x1b', hasUser: true, pending: true });
    expect(c.expire(100).data).toBe('');
    expect(c.pending).toBe(false);
    expect(c.push(replies[0]!, { forceUser: true }, 101).hasUser).toBe(true);
    expect(c.push(replies[0]!, { forceUser: 'protocol' }, 102).hasUser).toBe(false);
    expect(c.push('draft', { forceUser: false }, 103).hasUser).toBe(true);
  });

  it.each(escapeBoundaries.flatMap(boundary => [
    { pasteName: 'ESC CSI', start: '\x1b[200~', end: '\x1b[201~' },
    { pasteName: 'C1 CSI', start: '\x9b200~', end: '\x9b201~' },
  ].map(paste => ({ ...boundary, ...paste }))))(
    'tracks a new paste after a separate $escape Escape ($timing, $pasteName)',
    ({ forceUser, now, start, end }) => {
      const c = new WebTerminalInputClassifier({ carryMs: 10 });
      const escape = c.push('\x1b', { forceUser }, 0);
      expect(escape).toMatchObject({
        data: forceUser ? '\x1b' : '', hasUser: forceUser, maySubmit: false,
        pasteRelated: false, pending: true,
      });
      const marker = c.push(start, {}, now);
      expect(marker).toMatchObject({
        data: (forceUser ? '' : '\x1b') + start, hasUser: true,
        maySubmit: false, pasteRelated: true, pending: true, deadline: undefined,
      });
      expect(c.inPaste).toBe(true);
      expect(c.bufferedBytes).toBe(0);

      const payload = replies[0]! + '\r\n草稿🌱';
      const body = c.push(payload, {}, now + 1);
      expect(body).toMatchObject({
        data: payload, hasUser: true, maySubmit: false, pasteRelated: true, pending: true,
      });
      expect(c.inPaste).toBe(true);
      const terminator = c.push(end, {}, now + 2);
      expect(terminator).toMatchObject({
        data: end, hasUser: true, maySubmit: false, pasteRelated: true, pending: false,
      });
      expect(c.inPaste).toBe(false);
      const submit = c.push('\r', {}, now + 3);
      expect(submit).toMatchObject({
        data: '\r', hasUser: true, maySubmit: true, pasteRelated: false, pending: false,
      });
      expect(escape.data + marker.data + body.data + terminator.data + submit.data)
        .toBe('\x1b' + start + payload + end + '\r');
      expect(c.expire(now + 20).data).toBe('');
    },
  );

  it.each(escapeBoundaries.flatMap(boundary => [
    { replyName: 'ESC focus-in', reply: '\x1b[I' },
    { replyName: 'ESC focus-out', reply: '\x1b[O' },
    { replyName: 'C1 focus-in', reply: '\x9bI' },
    { replyName: 'C1 focus-out', reply: '\x9bO' },
    { replyName: 'ESC color', reply: '\x1b]11;rgb:1/aB/1234\x1b\\' },
    { replyName: 'C1 color', reply: '\x9d11;rgb:1/aB/1234\x1b\\' },
  ].flatMap(reply => [false, true].map(split => ({
    ...boundary, ...reply, split, splitName: split ? 'split introducer' : 'whole',
  })))))(
    'recognizes a new neutral reply after a separate $escape Escape ($timing, $replyName, $splitName)',
    ({ forceUser, now, reply, split }) => {
      const c = new WebTerminalInputClassifier({ carryMs: 10 });
      const escape = c.push('\x1b', { forceUser }, 0);
      expect(escape).toMatchObject({
        data: forceUser ? '\x1b' : '', hasUser: forceUser, maySubmit: false,
        pasteRelated: false, pending: true,
      });
      let emitted = escape.data;
      if (split) {
        const prefix = c.push(reply[0]!, {}, now);
        expect(prefix).toMatchObject({
          data: forceUser ? '' : '\x1b', hasUser: !forceUser, maySubmit: false,
          pasteRelated: false, pending: true, deadline: now + 10,
        });
        expect(c.bufferedBytes).toBe(Buffer.byteLength(reply[0]!, 'utf8'));
        emitted += prefix.data;
      }
      const out = c.push(split ? reply.slice(1) : reply, {}, now + (split ? 1 : 0));
      expect(out).toMatchObject({
        data: (!split && !forceUser ? '\x1b' : '') + reply,
        hasUser: !split && !forceUser, maySubmit: false, pasteRelated: false,
        pending: false, deadline: undefined,
      });
      expect(emitted + out.data).toBe('\x1b' + reply);
      expect(c.inPaste).toBe(false);
      expect(c.bufferedBytes).toBe(0);
      expect(c.expire(now + 20).data).toBe('');
    },
  );

  it.each(replies.filter(reply => reply.endsWith('\x1b\\')).flatMap(reply =>
    [false, true].map(forceUser => ({ reply, forceUser }))))(
    'keeps a color reply split inside ST in the same candidate: %j',
    ({ reply, forceUser }) => {
      const c = new WebTerminalInputClassifier({ carryMs: 10 });
      const prefix = reply.slice(0, -1);
      const a = c.push(prefix, { forceUser }, 0);
      expect(a).toMatchObject({
        data: forceUser ? prefix : '', hasUser: forceUser, maySubmit: false,
        pasteRelated: false, pending: true, deadline: 10,
      });
      const b = c.push('\\', {}, 1);
      expect(b).toMatchObject({
        data: forceUser ? '\\' : reply, hasUser: forceUser, maySubmit: false,
        pasteRelated: false, pending: false, deadline: undefined,
      });
      expect(a.data + b.data).toBe(reply);
      expect(c.inPaste).toBe(false);
      expect(c.expire(20).data).toBe('');
    },
  );

  it('upgrades a buffered prefix if its next fragment has a user hint', () => {
    const c = new WebTerminalInputClassifier();
    const reply = replies[0]!;
    expect(c.push(reply.slice(0, 5), {}, 0).data).toBe('');
    const out = c.push(reply.slice(5), { forceUser: true }, 1);
    expect(out).toMatchObject({ data: reply, hasUser: true, maySubmit: false, pending: false });
  });

  it('does not roll the carry deadline when bytes keep arriving', () => {
    const c = new WebTerminalInputClassifier({ carryMs: 10 });
    expect(c.push('\x1b', {}, 0).deadline).toBe(10);
    expect(c.push(']', {}, 5).deadline).toBe(10);
    expect(c.push('11;', {}, 9).deadline).toBe(10);
    expect(c.expire(9).data).toBe('');
    expect(c.expire(10)).toMatchObject({ data: '\x1b]11;', hasUser: true, pending: false, reason: 'timeout' });
    expect(c.expire(100).data).toBe('');
  });

  it('downgrades a carry limit instead of truncating or swallowing it', () => {
    const c = new WebTerminalInputClassifier({ maxCarry: 8 });
    const reply = replies[0]!;
    expect(c.push(reply, {}, 0)).toMatchObject({ data: reply, hasUser: true, pending: false, reason: 'limit' });
    expect(c.bufferedBytes).toBe(0);
  });

  it('counts UTF-8 bytes for C1 prefixes when enforcing the carry bound', () => {
    const c = new WebTerminalInputClassifier({ maxCarry: 4 });
    expect(c.push('\x9d11;', {}, 0)).toMatchObject({
      data: '\x9d11;', hasUser: true, pending: false, reason: 'limit',
    });
    expect(c.bufferedBytes).toBe(0);
  });

  it('streams fragmented paste and treats reply-shaped paste as user data', () => {
    for (const forceUser of [false, true]) {
      const c = new WebTerminalInputClassifier();
      const source = '\x1b[200~' + replies[0] + '\r\n草稿' + '\x1b[201~' + '\r';
      let emitted = '';
      for (let i = 0; i < source.length; i++) {
        const out = c.push(source[i]!, { forceUser }, 0);
        emitted += out.data;
        expect(out.maySubmit).toBe(i === source.length - 1);
        if (out.data) expect(out.hasUser).toBe(true);
        expect(c.bufferedBytes).toBeLessThanOrEqual(6);
      }
      expect(emitted).toBe(source);
      expect(c.pending).toBe(false);
    }
  });

  it('paste state wins even with a complete reply-shaped packet and no force hint', () => {
    const c = new WebTerminalInputClassifier();
    c.push('\x1b[200~', {}, 0);
    expect(c.push(replies[0]!, {}, 1)).toMatchObject({ data: replies[0], hasUser: true, maySubmit: false });
    expect(c.push('\r\n', {}, 2).maySubmit).toBe(false);
    expect(c.push('\x1b[201~\n', {}, 3).maySubmit).toBe(true);
  });

  it('reset drops old pending bytes and paste state without replay', () => {
    const c = new WebTerminalInputClassifier();
    c.push('\x1b]11;rgb:', {}, 0);
    c.reset();
    expect(c.expire(1000).data).toBe('');
    c.push('\x1b[200~', {}, 1000);
    c.reset();
    expect(c.push('\r', {}, 1001).maySubmit).toBe(true);
  });

  it.each([{ carryMs: 0 }, { carryMs: Infinity }, { carryMs: 1001 }, { maxCarry: 0 }, { maxCarry: 1.5 }, { maxCarry: 4097 }])(
    'rejects unusable carry limits %j', limits => expect(() => new WebTerminalInputClassifier(limits)).toThrow(),
  );
});
