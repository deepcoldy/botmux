import { describe, it, expect } from 'vitest';
import {
  buildReplyCardActionOverflow,
  buildReplyCardChromeRow,
  REPLY_CARD_ACTIONS_ELEMENT_ID,
  REPLY_CARD_MENU_ACTION,
} from '../src/im/lark/reply-card-actions.js';
import { buildReplyCardFooter, buildCanonicalFinalReplyCard, buildContextualReplyCard } from '../src/im/lark/md-card.js';

const binding = {
  larkAppId: 'cli_x',
  chatId: 'oc_x',
  rootId: 'om_root',
  sessionId: 'sess_x',
};

describe('buildReplyCardActionOverflow', () => {
  it('binds session identity and offers terminal/model/close options', () => {
    const el = buildReplyCardActionOverflow(binding, 'zh');
    expect(el.tag).toBe('overflow');
    expect(el.value).toMatchObject({
      action: REPLY_CARD_MENU_ACTION,
      session_id: 'sess_x',
      root_id: 'om_root',
      lark_app_id: 'cli_x',
      chat_id: 'oc_x',
    });
    expect(el.value).not.toHaveProperty('adopt');
    const values = el.options.map((o: any) => o.value);
    expect(values).toEqual(['terminal', 'model', 'close']);
  });

  it('labels close as disconnect for adopt sessions', () => {
    const el = buildReplyCardActionOverflow({ ...binding, adopt: true }, 'zh');
    expect(el.value.adopt).toBe(1);
    const close = el.options.find((o: any) => o.value === 'close');
    expect(close.text.content).toBe('断开连接');
  });
});

describe('buildReplyCardChromeRow', () => {
  const footer = buildReplyCardFooter({ brand: 'botmux', recipientOpenIds: ['ou_x'] })!;

  it('returns null with no footer and no controls', () => {
    expect(buildReplyCardChromeRow({ footer: null, controls: [] })).toBeNull();
  });

  it('returns the bare footer element when there are no controls', () => {
    const row = buildReplyCardChromeRow({ footer, controls: [] })!;
    expect(row.tag).toBe('markdown');
    expect(row.element_id).toBe('botmux_reply_footer');
  });

  it('wraps footer and controls into one stable-id column_set', () => {
    const voice = { tag: 'button', text: { tag: 'plain_text', content: '🔊' } };
    const menu = buildReplyCardActionOverflow(binding, 'zh');
    const row = buildReplyCardChromeRow({ footer, controls: [voice, menu] }) as any;
    expect(row.tag).toBe('column_set');
    expect(row.element_id).toBe(REPLY_CARD_ACTIONS_ELEMENT_ID);
    expect(row.columns).toHaveLength(3);
    expect(row.columns[0].weight).toBe(1);
    expect(row.columns[0].elements[0].element_id).toBe('botmux_reply_footer');
    expect(row.columns[1].elements[0].tag).toBe('button');
    expect(row.columns[2].elements[0].tag).toBe('overflow');
    // controls never shrink the footer column to auto
    for (const [i, col] of row.columns.entries()) {
      expect(col.width).toBe(i === 0 ? 'weighted' : 'auto');
    }
  });

  it('still renders a row when only controls exist', () => {
    const row = buildReplyCardChromeRow({ footer: null, controls: [buildReplyCardActionOverflow(binding)] }) as any;
    expect(row.tag).toBe('column_set');
    expect(row.columns[0].elements[0].content).toBe(' ');
  });
});


describe('reply card builders accept cardActions', () => {
  const cardActions = { larkAppId: 'cli_x', chatId: 'oc_x', rootId: 'om_root', sessionId: 'sess_x' };

  it('omits the menu without a binding and renders it with one', () => {
    const without = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'hi', recipientOpenId: 'ou_a', brand: 'botmux' }));
    const ids = JSON.stringify(without.body.elements);
    expect(ids).not.toContain('botmux_reply_actions');
    expect(ids).not.toContain('reply_card_menu');

    const withMenu = JSON.parse(buildCanonicalFinalReplyCard({
      markdown: 'hi', recipientOpenId: 'ou_a', brand: 'botmux', cardActions,
    }));
    const row = withMenu.body.elements.find((e: any) => e.element_id === 'botmux_reply_actions');
    expect(row.tag).toBe('column_set');
    expect(JSON.stringify(row)).toContain('reply_card_menu');
    // footer stays inside the same row, never duplicated at top level
    expect(withMenu.body.elements.filter((e: any) => e.element_id === 'botmux_reply_footer')).toHaveLength(0);
    expect(JSON.stringify(row)).toContain('botmux_reply_footer');
  });

  it('renders the menu even when footer content is empty', () => {
    const card = JSON.parse(buildCanonicalFinalReplyCard({ markdown: 'hi', cardActions }));
    const row = card.body.elements.find((e: any) => e.element_id === 'botmux_reply_actions');
    expect(row).toBeTruthy();
    expect(JSON.stringify(row)).toContain('"overflow"');
  });

  it('contextual builder binds adopt sessions with the disconnect label', () => {
    const card = JSON.parse(buildContextualReplyCard({
      title: 'T',
      userText: 'q',
      assistantText: 'a',
      assistantLabel: 'Claude',
      cardActions: { ...cardActions, adopt: true },
      locale: 'zh',
    }));
    const row = card.body.elements.find((e: any) => e.element_id === 'botmux_reply_actions');
    expect(JSON.stringify(row)).toContain('断开连接');
  });
});

import { attachOncallGroupButton } from '../src/im/lark/oncall-group.js';

describe('oncall button joins the reply chrome row', () => {
  const cardActions = { larkAppId: 'cli_x', chatId: 'oc_x', rootId: 'om_root', sessionId: 'sess_x' };
  const policy = { enabled: true, chatIds: ['oc_x'] };

  it('places the on-call button inside the menu chrome row, not at card bottom', () => {
    const raw = buildCanonicalFinalReplyCard({
      markdown: 'hi', recipientOpenId: 'ou_a', brand: 'botmux', cardActions,
    });
    const card = JSON.parse(attachOncallGroupButton(raw, policy as any, 'oc_x'));
    const row = card.body.elements.find((e: any) => e.element_id === 'botmux_reply_actions');
    expect(row).toBeTruthy();
    expect(row.flex_mode).toBe('flow');
    // columns: footer + overflow menu + oncall
    expect(row.columns).toHaveLength(3);
    const oncall = row.columns[2].elements[0];
    expect(oncall.text.content).toBe('拉起 Oncall 群');
    // no standalone oncall row leaked at top level
    expect(card.body.elements.some((e: any) => e.element_id === 'botmux_oncall_group')).toBe(false);
  });

  it('is idempotent on the chrome row', () => {
    const raw = buildCanonicalFinalReplyCard({ markdown: 'hi', cardActions });
    const once = attachOncallGroupButton(raw, policy as any, 'oc_x');
    const twice = attachOncallGroupButton(once, policy as any, 'oc_x');
    expect(twice).toBe(once);
  });
});

import { vi, beforeEach } from 'vitest';

describe('durable-primary coordination hides the close menu item', () => {
  beforeEach(() => vi.unstubAllEnvs());
  it('omits close when BOTMUX_COORDINATION_MODE=primary and keeps terminal/model', () => {
    vi.stubEnv('BOTMUX_COORDINATION_MODE', 'primary');
    const el = buildReplyCardActionOverflow(binding, 'zh');
    expect(el.options.map((o: any) => o.value)).toEqual(['terminal', 'model']);
    vi.unstubAllEnvs();
  });
});
