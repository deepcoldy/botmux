/**
 * Unit tests for the forwarded message XML renderer.
 *
 * Run:  pnpm vitest run test/forwarded-renderer.test.ts
 */
import { describe, it, expect } from 'vitest';
import { renderForwardedXml, type ForwardedNode } from '../src/im/lark/forwarded-renderer.js';

describe('renderForwardedXml: empty', () => {
  it('returns a self-closing tag for an empty tree', () => {
    expect(renderForwardedXml([])).toBe('<forwarded_messages />');
  });
});

describe('renderForwardedXml: single layer, single sender', () => {
  it('emits one participant and three messages with the same alias', () => {
    const nodes: ForwardedNode[] = [
      { senderOpenId: 'ou_alice', senderType: 'user', content: 'first' },
      { senderOpenId: 'ou_alice', senderType: 'user', content: 'second' },
      { senderOpenId: 'ou_alice', senderType: 'user', content: 'third' },
    ];
    const out = renderForwardedXml(nodes);
    expect(out).toContain('<participants>\n  <p id="A" open_id="ou_alice" type="user" />\n</participants>');
    expect(out).toContain('<msg from="A">first</msg>');
    expect(out).toContain('<msg from="A">second</msg>');
    expect(out).toContain('<msg from="A">third</msg>');
    // Only ONE participant entry despite three messages.
    expect(out.match(/<p id=/g)?.length).toBe(1);
  });
});

describe('renderForwardedXml: single layer, multiple senders', () => {
  it('dedupes participants and assigns A/B aliases in first-seen order', () => {
    const nodes: ForwardedNode[] = [
      { senderOpenId: 'ou_alice', senderType: 'user', content: 'hi' },
      { senderOpenId: 'ou_bob', senderType: 'user', content: 'hey' },
      { senderOpenId: 'ou_alice', senderType: 'user', content: 'sup' },
    ];
    const out = renderForwardedXml(nodes);
    expect(out).toContain('<p id="A" open_id="ou_alice" type="user" />');
    expect(out).toContain('<p id="B" open_id="ou_bob" type="user" />');
    expect(out).toContain('<msg from="A">hi</msg>');
    expect(out).toContain('<msg from="B">hey</msg>');
    expect(out).toContain('<msg from="A">sup</msg>');
  });
});

describe('renderForwardedXml: user + bot mix', () => {
  it('records type="app" for bot senders and keeps their open_id', () => {
    const nodes: ForwardedNode[] = [
      { senderOpenId: 'ou_user_xx', senderType: 'user', content: '@bot help' },
      { senderOpenId: 'cli_bot_yy', senderType: 'app', content: 'Hi! How can I help?' },
    ];
    const out = renderForwardedXml(nodes);
    expect(out).toContain('<p id="A" open_id="ou_user_xx" type="user" />');
    expect(out).toContain('<p id="B" open_id="cli_bot_yy" type="app" />');
  });

  it('uses senderName attribute when provided', () => {
    const nodes: ForwardedNode[] = [
      { senderOpenId: 'cli_bot_yy', senderType: 'app', senderName: 'Codex', content: 'done' },
    ];
    const out = renderForwardedXml(nodes);
    expect(out).toContain('<p id="A" open_id="cli_bot_yy" type="app" name="Codex" />');
  });
});

describe('renderForwardedXml: nested merge_forward', () => {
  it('emits <msg type="merged_forward"> wrapping inner messages and collects participants across all levels', () => {
    const nodes: ForwardedNode[] = [
      { senderOpenId: 'ou_outer', senderType: 'user', content: '看这个' },
      {
        senderOpenId: 'ou_outer',
        senderType: 'user',
        children: [
          { senderOpenId: 'ou_inner1', senderType: 'user', content: 'msg1' },
          { senderOpenId: 'ou_inner2', senderType: 'user', content: 'msg2' },
          { senderOpenId: 'ou_inner1', senderType: 'user', content: 'msg3' },
        ],
      },
    ];
    const out = renderForwardedXml(nodes);
    // Three unique participants — outer + two inner — in first-seen order.
    expect(out).toContain('<p id="A" open_id="ou_outer" type="user" />');
    expect(out).toContain('<p id="B" open_id="ou_inner1" type="user" />');
    expect(out).toContain('<p id="C" open_id="ou_inner2" type="user" />');
    // Outer wrapper carries type="merged_forward" and inner messages indent.
    expect(out).toContain('<msg from="A" type="merged_forward">');
    expect(out).toContain('  <msg from="B">msg1</msg>');
    expect(out).toContain('  <msg from="C">msg2</msg>');
    expect(out).toContain('  <msg from="B">msg3</msg>');
    expect(out).toContain('</msg>'); // closing tag for the merged_forward
  });
});

describe('renderForwardedXml: missing open_id', () => {
  it('still produces a participant entry per occurrence (no collapse)', () => {
    const nodes: ForwardedNode[] = [
      { senderOpenId: '', senderType: 'unknown', content: 'one' },
      { senderOpenId: '', senderType: 'unknown', content: 'two' },
    ];
    const out = renderForwardedXml(nodes);
    // Two anonymous senders → two participants, no shared alias.
    const participantCount = out.match(/<p id=/g)?.length ?? 0;
    expect(participantCount).toBe(2);
    expect(out).toContain('<msg from="A">one</msg>');
    expect(out).toContain('<msg from="B">two</msg>');
    // No open_id attr emitted when we don't have one.
    expect(out).not.toMatch(/open_id="__unknown_/);
  });
});

describe('renderForwardedXml: multiline content', () => {
  it('preserves inner newlines inside <msg> with indentation', () => {
    const nodes: ForwardedNode[] = [
      { senderOpenId: 'ou_a', senderType: 'user', content: 'line1\nline2\nline3' },
    ];
    const out = renderForwardedXml(nodes);
    expect(out).toContain('<msg from="A">\n  line1\n  line2\n  line3\n</msg>');
  });
});

describe('renderForwardedXml: alias rollover beyond Z', () => {
  it('continues with AA after Z', () => {
    const nodes: ForwardedNode[] = Array.from({ length: 28 }, (_, i) => ({
      senderOpenId: `ou_${i}`,
      senderType: 'user' as const,
      content: `m${i}`,
    }));
    const out = renderForwardedXml(nodes);
    expect(out).toContain('<p id="Z" open_id="ou_25" type="user" />');
    expect(out).toContain('<p id="AA" open_id="ou_26" type="user" />');
    expect(out).toContain('<p id="AB" open_id="ou_27" type="user" />');
  });
});
