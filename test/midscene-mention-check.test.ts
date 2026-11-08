import { describe, expect, it } from 'vitest';
import {
  botDisplayNames,
  buildFocusLoop,
  chatOpenInMain,
  focusBudgets,
  focusTarget,
  focusUntilAccepted,
  holdsOnlyMention,
  inputHolds,
  isTopicReplyComposer,
  normalizeInput,
  openNativeTopicWith,
  openTopicFromList,
  pickChatEntry,
  pickEditorBox,
  pickFilterLabel,
  pickMentionOption,
  pickTopicEntry,
  pickTopicIcon,
  staleViewReason,
  topicOpenInMain,
  topicRootInMain,
  waitForCardButtons,
  waitForTopicIcon,
  type ScreenBox,
  type TagText,
  type TitleBox,
} from './e2e-browser/helpers.js';

describe('Feishu E2E mention check', () => {
  it('accepts only one chip naming the intended bot, never a bare query or a neighbour', () => {
    expect(holdsOnlyMention(['@Claude'], '@Claude ', 'Claude')).toBe(true);
    // Apps still named the old way while they are renamed.
    expect(holdsOnlyMention(['@[Botmux]Claude'], '@[Botmux]Claude ', 'Claude')).toBe(true);
    // The typed filter query reads the same but is not a chip yet.
    expect(holdsOnlyMention([], '@Claude', 'Claude')).toBe(false);
    // CI picked neighbouring bots from the dropdown.
    expect(holdsOnlyMention(['@Aiden'], '@Aiden ', 'Claude')).toBe(false);
    expect(holdsOnlyMention(['@OpenCode'], '@OpenCode ', 'Codex')).toBe(false);
    expect(holdsOnlyMention(['@Claude', '@Codex'], '@Claude @Codex ', 'Claude')).toBe(false);
    // Same-named apps in the test tenant differ only in case or a prefix.
    expect(holdsOnlyMention(['@codex'], '@codex ', 'Codex')).toBe(false);
    expect(holdsOnlyMention(['@Nash_Claude'], '@Nash_Claude ', 'Claude')).toBe(false);
    // A stray literal @ broke `/reply-mode` parsing in CI.
    expect(holdsOnlyMention(['@Claude'], '@@Claude ', 'Claude')).toBe(false);
  });

  it('names the bot by its CLI first and by the old prefixed name second', () => {
    expect(botDisplayNames('Claude')).toEqual(['Claude', '[Botmux]Claude']);
    expect(botDisplayNames('[Botmux]Codex')).toEqual(['Codex', '[Botmux]Codex']);
  });
});

describe('Feishu E2E typed-input check', () => {
  const zw = '​';
  it('ignores the editor padding and catches lost leading keystrokes', () => {
    expect(normalizeInput(`/reply-mode ${zw}\n${zw}\n${zw}`)).toBe('/reply-mode');
    expect(inputHolds(`/reply-mode ${zw}\n${zw}\n${zw}`, '/reply-mode ')).toBe(true);
    const chip = `${zw}\n@[Botmux]Claude\n`;
    expect(inputHolds(`${chip}  /reply-mode ${zw}\n${zw}`, ' /reply-mode ', chip)).toBe(true);
    // Without the chip as lead, the chip is unexpected leading text.
    expect(inputHolds('@[Botmux]Claude /reply-mode', ' /reply-mode ')).toBe(false);
    // CI: the daemon received these.
    expect(inputHolds(`eply-mode new-topic ${zw}`, '/reply-mode new-topic ')).toBe(false);
    expect(inputHolds(
      '2e-sg2-claude-1791992364019 RECALL_FIRST_MARKER 请立刻调用',
      'e2e-sg2-claude-1791992364019 RECALL_FIRST_MARKER 请立刻调用',
    )).toBe(false);
    // Leftovers a clear missed would be sent with the command.
    expect(inputHolds('eply-mode eply-mode /reply-mode', '/reply-mode')).toBe(false);
  });

  it('does not fail a long probe over rendering differences in its middle', () => {
    const probe =
      'e2e-turn1-1792003390393 RECALL_FIRST_MARKER 请立刻调用 botmux send 在本话题里回复一行内容：' +
      '"ACK-e2e-turn1-1792003390393 RECALL <标记>"（尖括号部分替换成那串标记原文，不要加引号）。做完这一步就结束本轮工作。';
    // Probes end in a fixed sentence; any difference sits mid-text.
    const rendered = probe.replace('"ACK', '“ACK').replace('>"', '>”');
    expect(probe.slice(-24)).not.toContain('"');
    expect(inputHolds(`${rendered} ${zw}`, probe)).toBe(true);
  });
});

describe('Feishu E2E member-list pick', () => {
  // Boxes from a CI screenshot at 1920×1080: the list opens above the input.
  const editor = { x: 631, y: 1015, width: 1260, height: 37 };
  const inChatHeader = { x: 649, y: 799, width: 64, height: 16 };
  const outsideHeader = { x: 649, y: 875, width: 210, height: 16 };
  const inChatRow = { x: 679, y: 834, width: 100, height: 17, fresh: true };
  const outsideRow = { x: 679, y: 910, width: 100, height: 17, fresh: true };
  // The sender label of a reply just above the list, and the chat-list entry.
  const senderLabel = { x: 672, y: 680, width: 86, height: 14, fresh: false };
  const chatListEntry = { x: 380, y: 197, width: 100, height: 17, fresh: false };

  it('clicks the member under 「会话内成员」, never the same-named bot outside the chat', () => {
    const list = {
      editor,
      options: [chatListEntry, senderLabel, outsideRow, inChatRow],
      inChat: [inChatHeader],
      outside: [outsideHeader],
    };
    expect(pickMentionOption(list)).toEqual(inChatRow);
    expect(pickMentionOption({ ...list, options: [senderLabel, outsideRow] })).toBeNull();
  });

  it('only takes rows in the band right above the input', () => {
    // Fresh same-named rows on every side of the band: the chat list redrawn
    // at the list's height (left), beyond the input's right edge, below the
    // input, and far above it.
    const outside = {
      left: { x: 200, y: 850, width: 100, height: 17, fresh: true },
      right: { x: editor.x + editor.width + 10, y: 850, width: 100, height: 17, fresh: true },
      below: { x: 679, y: editor.y + editor.height + 4, width: 100, height: 17, fresh: true },
      farAbove: { x: 679, y: editor.y - 600, width: 100, height: 17, fresh: true },
    };
    for (const [where, row] of Object.entries(outside)) {
      const headed = { editor, inChat: [inChatHeader], outside: [outsideHeader] };
      const bare = { editor, inChat: [], outside: [] };
      expect(pickMentionOption({ ...headed, options: [row] }), `${where}, with headers`).toBeNull();
      expect(pickMentionOption({ ...bare, options: [row] }), `${where}, without headers`).toBeNull();
      expect(pickMentionOption({ ...headed, options: [row, inChatRow] }), `${where}, with headers`).toEqual(inChatRow);
      expect(pickMentionOption({ ...bare, options: [row, inChatRow] }), `${where}, without headers`).toEqual(inChatRow);
    }
  });

  it('bounds the in-chat section only by the 「会话外的人」 header below it in the list', () => {
    // The same words elsewhere at the rows' height (a profile card right of
    // the list), or above the in-chat header, must not cut the section off.
    const beside = { ...outsideHeader, x: editor.x + editor.width + 20, y: inChatRow.y - 4 };
    const above = { ...outsideHeader, y: inChatHeader.y - 60 };
    for (const header of [beside, above]) {
      expect(pickMentionOption({ editor, options: [inChatRow], inChat: [inChatHeader], outside: [header] })).toEqual(inChatRow);
    }
  });

  it('waits while the list is still a skeleton row', () => {
    expect(pickMentionOption({ editor, options: [chatListEntry, senderLabel], inChat: [], outside: [] })).toBeNull();
  });

  it('without section headers takes the topmost row that appeared after typing @', () => {
    const list = { editor, options: [senderLabel, outsideRow, inChatRow], inChat: [], outside: [] };
    expect(pickMentionOption(list)).toEqual(inChatRow);
    // A header elsewhere on the page (not above the input) does not count.
    const farHeader = { x: 1300, y: 40, width: 64, height: 16 };
    expect(pickMentionOption({ ...list, inChat: [farHeader] })).toEqual(inChatRow);
  });
});

describe('Feishu E2E topic icon pick', () => {
  // A CI screenshot at 1920×1080: the seed's text, and its hover toolbar
  // 👍 💬 ↪ topic ⋯ (each a button wrapping an svg), plus the read tick below.
  const text = { x: 684, y: 956, width: 290, height: 18 };
  const button = (cx: number) => ({ x: cx - 11, y: 947, width: 22, height: 22 });
  const svg = (cx: number) => ({ x: cx - 7, y: 951, width: 14, height: 14 });
  const centres = [1004, 1028, 1052, 1076, 1101];
  const toolbar = centres.flatMap((cx) => [button(cx), svg(cx)]);
  const tick = { x: 993, y: 971, width: 13, height: 13 };

  it('takes the icon left of 「⋯」, once per nested button and svg', () => {
    expect(pickTopicIcon(text, [...toolbar, tick])).toEqual(button(1076));
    expect(pickTopicIcon(text, [...toolbar].reverse())).toEqual(button(1076));
    // A larger element right after 「⋯」 (a reaction panel) is not an icon.
    const panel = { x: 1118, y: 930, width: 60, height: 60 };
    expect(pickTopicIcon(text, [...toolbar, panel])).toEqual(button(1076));
  });

  it('rejects every shape that is not an icon, whichever bound it breaks', () => {
    // The probe collects every element up to 40×40 near the message: corner
    // dots, 1px dividers, hover panels. Between the topic icon and 「⋯」:
    const sliverV = { x: 1087, y: 947, width: 2, height: 22 }; // width < 10
    const sliverH = { x: 1078, y: 960, width: 22, height: 6 }; // height < 10
    // Right after 「⋯」:
    const barW = { x: 1118, y: 947, width: 60, height: 22 }; // only width > 40
    const barH = { x: 1118, y: 930, width: 22, height: 60 }; // only height > 40
    const upper = { x: 1118, y: 920, width: 22, height: 22 }; // centre above the row
    for (const extra of [sliverV, sliverH, barW, barH, upper]) {
      expect(pickTopicIcon(text, [...toolbar, extra])).toEqual(button(1076));
    }
  });

  it('finds nothing without a toolbar right next to the message', () => {
    expect(pickTopicIcon(text, [tick])).toBeNull();
    // Icon-sized emoji inside the message text are not a toolbar.
    expect(pickTopicIcon(text, [700, 730, 760, 790].map((x) => ({ x, y: 957, width: 16, height: 16 })))).toBeNull();
    // The vision agent's target: icons far right of the message.
    expect(pickTopicIcon(text, centres.map((cx) => button(cx + 500)))).toBeNull();
    // Three icons are not a toolbar; nor are icons on another message's row.
    expect(pickTopicIcon(text, centres.slice(0, 3).map(button))).toBeNull();
    expect(pickTopicIcon(text, centres.map((cx) => ({ ...button(cx), y: 1010 })))).toBeNull();
  });
});

describe('Feishu E2E editor pick', () => {
  // A CI screenshot at 1920×1080: the group's input and, with a topic panel
  // open on the right (title 「话题」 at x 1590), the panel's reply box.
  const viewport = { width: 1920, height: 1080 };
  const chatInput = { x: 632, y: 1010, width: 908, height: 40 };
  const topicInput = { x: 1590, y: 956, width: 300, height: 30 };
  const panelLeft = 1590;

  it('types topic replies into the open panel, never into the group input', () => {
    expect(pickEditorBox([chatInput, topicInput], 'topic', viewport, panelLeft)).toEqual(topicInput);
    // CI: the panel's box had not mounted yet; the probe went to the group.
    expect(pickEditorBox([chatInput], 'topic', viewport, panelLeft)).toBeNull();
    // Panel title not found: the right-most box is still the panel's.
    expect(pickEditorBox([chatInput, topicInput], 'topic', viewport, null)).toEqual(topicInput);
    expect(pickEditorBox([chatInput, topicInput], 'chat', viewport, null)).toEqual(chatInput);
  });

  it('keeps to the panel, and to its bottom-most box', () => {
    // The reply box starts a little left of the panel title (its padding).
    const padded = { x: 1574, y: 956, width: 300, height: 30 };
    expect(pickEditorBox([chatInput, padded], 'topic', viewport, panelLeft)).toEqual(padded);
    // An editable card field higher in the panel is not the reply box.
    const field = { x: 1590, y: 600, width: 300, height: 30 };
    expect(pickEditorBox([chatInput, field, topicInput], 'topic', viewport, panelLeft)).toEqual(topicInput);
    // Panel title up, reply box not yet mounted: a field mid-page is no target.
    expect(pickEditorBox([chatInput, { x: 1300, y: 700, width: 200, height: 30 }], 'topic', viewport, panelLeft)).toBeNull();
  });

  it('ignores boxes that are not a conversation input', () => {
    const search = { x: 20, y: 600, width: 200, height: 30 }; // left of the conversation
    const high = { x: 700, y: 300, width: 600, height: 30 }; // an editable card field up top
    const narrow = { x: 1700, y: 1000, width: 60, height: 30 };
    const flat = { x: 1600, y: 1040, width: 280, height: 4 };
    for (const other of [search, high, narrow, flat]) {
      expect(pickEditorBox([chatInput, other], 'topic', viewport, null)).toEqual(chatInput);
      expect(pickEditorBox([other], 'chat', viewport, null)).toBeNull();
    }
  });
});

describe('Feishu E2E topic reply box identity', () => {
  it('tells a topic reply box from the chat input by its own composer', () => {
    // Side panel in a group, and a DM topic over the main area (CI screenshots).
    expect(isTopicReplyComposer({ labels: [], texts: ['', '回复话题\n同时发送到群'] })).toBe(true);
    expect(isTopicReplyComposer({ labels: [], texts: ['', '回复话题', '回复话题\n同时发送到会话'] })).toBe(true);
    // With text typed the placeholder is gone; the checkbox stays.
    expect(isTopicReplyComposer({ labels: [], texts: ['/close', '/close\n同时发送到群'] })).toBe(true);
    expect(isTopicReplyComposer({ labels: ['', '回复话题', '', ''], texts: [''] })).toBe(true);
    // The group's own input, empty or quoting a message.
    expect(isTopicReplyComposer({ labels: ['', '', '', ''], texts: ['', '发送给 普通群聊'] })).toBe(false);
    expect(isTopicReplyComposer({ labels: [], texts: ['e2e-…', '回复 申晗：e2e-…\ne2e-…'] })).toBe(false);
    expect(isTopicReplyComposer({ labels: [], texts: [] })).toBe(false);
  });
});

describe('Feishu E2E focus loop', () => {
  function clock() {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => { t += ms; }, at: () => t };
  }

  it('never takes the chat input for a topic reply box, however long it waits', async () => {
    const c = clock();
    let focuses = 0;
    const ok = await focusUntilAccepted(
      {
        // It must pause between tries rather than spin on the page.
        focus: async () => {
          if (++focuses > 100) throw new Error('focus retried without pausing');
          return true;
        },
        accepted: async () => false,
        now: c.now,
        sleep: c.sleep,
      },
      10_000,
    );
    expect(ok).toBe(false);
    expect(c.at()).toBeGreaterThanOrEqual(10_000);
    expect(focuses).toBeGreaterThan(1);
  });

  it('takes the reply box as soon as it mounts', async () => {
    const c = clock();
    let tries = 0;
    const ok = await focusUntilAccepted(
      { focus: async () => true, accepted: async () => ++tries >= 3, now: c.now, sleep: c.sleep },
      10_000,
    );
    expect(ok).toBe(true);
    expect(c.at()).toBeLessThan(10_000);
  });

  it('tries once without a wait, and needs a focused editor', async () => {
    const c = clock();
    let accepted = 0;
    const ok = await focusUntilAccepted(
      { focus: async () => false, accepted: async () => (accepted++, true), now: c.now, sleep: c.sleep },
      0,
    );
    expect(ok).toBe(false);
    expect(c.at()).toBe(0);
    expect(accepted).toBe(0);
  });

  it('gives one send the full wait once, then short ones', () => {
    const budget = focusBudgets(10_000, 2_000);
    expect([budget(), budget(), budget()]).toEqual([10_000, 2_000, 2_000]);
  });
});

describe('Feishu E2E focus target', () => {
  /** Fake page: what the click lands on, and whether vision moves the caret. */
  function page(opts: { clicks?: boolean; caret?: boolean; topicBox?: boolean; visionFindsTopic?: boolean }) {
    let t = 0;
    const calls = { vision: 0, identity: 0 };
    let topicBox = opts.topicBox ?? false;
    return {
      calls,
      deps: {
        clickEditor: async () => opts.clicks ?? true,
        hasCaret: async () => opts.caret ?? true,
        isTopicReply: async () => (calls.identity++, topicBox),
        askVision: async () => {
          calls.vision++;
          if (opts.visionFindsTopic) topicBox = true;
        },
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      },
    };
  }

  it('never settles a topic reply on the chat input', async () => {
    // Only the chat input mounted, and vision cannot find the reply box either.
    const p = page({ topicBox: false });
    await expect(focusTarget(p.deps, 'topic', 10_000)).rejects.toThrow(/topic reply box/);
    expect(p.calls.vision).toBe(1);
  });

  it('lets vision find the reply box, and skips it when the box is already there', async () => {
    const late = page({ topicBox: false, visionFindsTopic: true });
    await expect(focusTarget(late.deps, 'topic', 2_000)).resolves.toBeUndefined();
    expect(late.calls.vision).toBe(1);
    const ready = page({ topicBox: true });
    await expect(focusTarget(ready.deps, 'topic', 10_000)).resolves.toBeUndefined();
    expect(ready.calls.vision).toBe(0);
  });

  it('asks the chat input no identity, but needs the caret in an editor', async () => {
    const chat = page({});
    await expect(focusTarget(chat.deps, 'chat', 0)).resolves.toBeUndefined();
    expect(chat.calls).toEqual({ vision: 0, identity: 0 });
    // A click that left the caret nowhere is not a focus: vision is asked.
    const nowhere = page({ caret: false });
    await focusTarget(nowhere.deps, 'chat', 0);
    expect(nowhere.calls.vision).toBe(1);
  });

  it('builds a topic loop that accepts only a topic reply box', async () => {
    const chatInput = page({ topicBox: false });
    expect(await buildFocusLoop(chatInput.deps, 'topic').accepted()).toBe(false);
    expect(await buildFocusLoop(chatInput.deps, 'chat').accepted()).toBe(true);
    expect(await buildFocusLoop(page({ caret: false }).deps, 'chat').focus()).toBe(false);
    expect(await buildFocusLoop(page({ clicks: false }).deps, 'chat').focus()).toBe(false);
  });
});

describe('Feishu E2E stale view', () => {
  const base = { now: 0, started: 0, pillSince: null, anchorGoneSince: null, cardVisible: false, reopened: 0, anchor: 'e2e-x' };

  it('re-opens a view that shows nothing new for 100s, once', () => {
    // CI: the probe stayed on screen; the repo card and reply never rendered.
    expect(staleViewReason({ ...base, now: 99_000 })).toBe('');
    expect(staleViewReason({ ...base, now: 101_000 })).toMatch(/100s/);
    expect(staleViewReason({ ...base, now: 101_000, reopened: 1 })).toBe('');
    // A repo card on screen is being clicked, not stale.
    expect(staleViewReason({ ...base, now: 101_000, cardVisible: true })).toBe('');
  });

  it('keeps the pill and missing-probe triggers', () => {
    expect(staleViewReason({ ...base, now: 30_000, pillSince: 4_000 })).toMatch(/pill/);
    expect(staleViewReason({ ...base, now: 30_000, pillSince: 6_000 })).toBe('');
    expect(staleViewReason({ ...base, now: 50_000, anchorGoneSince: 4_000 })).toMatch(/not on the page/);
    expect(staleViewReason({ ...base, now: 50_000, anchorGoneSince: 6_000 })).toBe('');
  });
});

describe('Feishu E2E filter column pick', () => {
  // CI screenshots at 1920×1080: the app bar, the filter column, the chat
  // list's title and an open topic panel all carry the same words.
  const viewport = { width: 1920, height: 1080 };
  const appBar = { x: 43, y: 107, width: 28, height: 18 };
  const filterMessages = { x: 197, y: 63, width: 28, height: 18 };
  const filterTopics = { x: 197, y: 351, width: 28, height: 18 };
  const chatListTitle = { x: 329, y: 20, width: 30, height: 20 };
  const topicPanelTitle = { x: 1590, y: 90, width: 30, height: 20 };

  it('clicks the filter column entry, not the same word elsewhere', () => {
    expect(pickFilterLabel([appBar, chatListTitle, filterMessages], viewport)).toEqual(filterMessages);
    expect(pickFilterLabel([topicPanelTitle, filterTopics], viewport)).toEqual(filterTopics);
    expect(pickFilterLabel([appBar, chatListTitle, topicPanelTitle], viewport)).toBeNull();
  });
});

describe('Feishu E2E bot chat pick', () => {
  // CI screenshots at 1920×1080 (run 40257129089): the chat list titles the
  // bot DM `[Botmux]Claude`; once open, the main area's title bar reads the
  // same name (bar ends at y ≈ 72). In 「普通群聊」 the name is the bot's
  // sender line instead (run 40280910196).
  const viewport = { width: 1920, height: 1080 };
  const listEntry: TitleBox = { x: 220, y: 198, width: 96, height: 18, onTop: true };
  const title: TitleBox = { x: 670, y: 30, width: 124, height: 20, onTop: true };
  const senderLine: TitleBox = { x: 668, y: 96, width: 104, height: 18, onTop: true };
  // A sender line scrolled under the title bar keeps its box.
  const underBar: TitleBox = { ...senderLine, y: 30, onTop: false };

  it('clicks the chat-list entry, not the name in the main area', () => {
    expect(pickChatEntry([title, senderLine, listEntry], viewport)).toEqual(listEntry);
    expect(pickChatEntry([title, senderLine], viewport)).toBeNull();
    // Scrolled out of the list.
    expect(pickChatEntry([{ ...listEntry, onTop: false }], viewport)).toBeNull();
  });

  it('confirms the DM by its title bar, not by the bot posting in another chat', () => {
    expect(chatOpenInMain([listEntry, title, senderLine], viewport)).toBe(true);
    expect(chatOpenInMain([listEntry, senderLine, underBar], viewport)).toBe(false);
    // The list's own entry, even at the top of the list.
    expect(chatOpenInMain([{ ...listEntry, y: 30 }], viewport)).toBe(false);
    // Right below the title bar.
    expect(chatOpenInMain([{ ...senderLine, y: 74 }], viewport)).toBe(false);
  });
});

describe('Feishu E2E topic entry pick', () => {
  // CI screenshot at 1920×1080 (run 40114756911): the chat list lists the
  // topic as an entry titled with its root message, and the group the topic
  // lives in shows the same tag in its preview line; the open topic's root
  // message carries it in the main area.
  const viewport = { width: 1920, height: 1080 };
  const topicTitle: TagText = {
    box: { x: 220, y: 134, width: 330, height: 20 },
    row: { x: 210, y: 128, width: 380, height: 48 },
  };
  // The reply ACK quotes the tag in the topic entry's own preview line.
  const topicPreview: TagText = { box: { x: 220, y: 158, width: 330, height: 18 }, row: topicTitle.row };
  const groupPreview: TagText = {
    box: { x: 220, y: 220, width: 360, height: 18 },
    row: { x: 210, y: 190, width: 380, height: 50 },
  };
  const mainRoot: TagText = {
    box: { x: 668, y: 112, width: 1190, height: 20 },
    row: { x: 640, y: 90, width: 1240, height: 60 },
  };

  it('opens the topic entry, not the chat whose preview shows the same tag', () => {
    expect(pickTopicEntry([groupPreview, topicPreview, mainRoot, topicTitle], viewport)).toEqual(topicTitle.box);
    // The group entry listed above the topic entry.
    const groupAbove: TagText = { box: { ...groupPreview.box, y: 100 }, row: { ...groupPreview.row!, y: 70 } };
    expect(pickTopicEntry([groupAbove, topicTitle], viewport)).toEqual(topicTitle.box);
    expect(pickTopicEntry([groupPreview, topicPreview], viewport)).toBeNull();
  });

  it('reads only the chat list, on screen, inside an entry', () => {
    expect(pickTopicEntry([mainRoot], viewport)).toBeNull();
    expect(pickTopicEntry([{ ...topicTitle, box: { ...topicTitle.box, x: 580 } }], viewport)).toBeNull();
    expect(pickTopicEntry([{ ...topicTitle, box: { ...topicTitle.box, x: 40 } }], viewport)).toBeNull();
    expect(pickTopicEntry([{ ...topicTitle, row: null }], viewport)).toBeNull();
    const below = { box: { ...topicTitle.box, y: 1090 }, row: { ...topicTitle.row!, y: 1084 } };
    expect(pickTopicEntry([below], viewport)).toBeNull();
    const above = { box: { ...topicTitle.box, y: -30 }, row: { ...topicTitle.row!, y: -36 } };
    expect(pickTopicEntry([above], viewport)).toBeNull();
  });

  it('takes the topmost titled entry', () => {
    const lower: TagText = { box: { ...topicTitle.box, y: 400 }, row: { ...topicTitle.row!, y: 394 } };
    expect(pickTopicEntry([lower, topicTitle], viewport)).toEqual(topicTitle.box);
  });

  it('sees the topic open in the main area only under its 「话题」 header', () => {
    const mainHeader = { x: 680, y: 18, width: 34, height: 20 };
    const sidePanelTitle = { x: 1590, y: 90, width: 30, height: 20 };
    expect(topicOpenInMain([mainHeader], [topicTitle, mainRoot], viewport)).toBe(true);
    // A topic in the narrow side panel, or the word lower down, is not the main area.
    expect(topicOpenInMain([sidePanelTitle], [topicTitle, mainRoot], viewport)).toBe(false);
    expect(topicOpenInMain([{ ...mainHeader, y: 500 }], [mainRoot], viewport)).toBe(false);
    expect(topicOpenInMain([{ ...mainHeader, x: 400 }], [mainRoot], viewport)).toBe(false);
    // The header of another topic that does not carry the tag.
    expect(topicOpenInMain([mainHeader], [topicTitle], viewport)).toBe(false);
  });

  it('recognizes the open topic by its root message right under the header', () => {
    const mainHeader = { x: 680, y: 18, width: 34, height: 20 };
    expect(topicRootInMain([mainHeader], [mainRoot], viewport)).toBe(true);
    // Another topic whose reply quotes the tag, below its root and divider.
    const quotingReply: TagText = { box: { ...mainRoot.box, y: 420 }, row: mainRoot.row };
    expect(topicRootInMain([mainHeader], [quotingReply], viewport)).toBe(false);
    // The tag only in the list, or no topic header in the main area.
    expect(topicRootInMain([mainHeader], [topicTitle], viewport)).toBe(false);
    expect(topicRootInMain([{ ...mainHeader, x: 1590 }], [mainRoot], viewport)).toBe(false);
    expect(topicRootInMain([{ ...mainHeader, y: 300 }], [{ ...mainRoot, box: { ...mainRoot.box, y: 340 } }], viewport)).toBe(false);
    // A 「话题」 word in the left band, and a tag above the header.
    expect(topicRootInMain([{ ...mainHeader, x: 100 }], [mainRoot], viewport)).toBe(false);
    const above: TagText = { box: { ...mainRoot.box, y: 20 }, row: mainRoot.row };
    expect(topicRootInMain([{ ...mainHeader, y: 90 }], [above], viewport)).toBe(false);
  });

  /**
   * Fake page: the entry is listed after `listedAt` ms (or only after a reload
   * when `staleList`); clicks open the topic from the `opensOnClick`-th on.
   */
  function page(opts: { listedAt?: number; opensOnClick?: number; openBefore?: boolean; staleList?: boolean }) {
    let t = 0;
    const clicks: ScreenBox[] = [];
    const reloads: number[] = [];
    const open = () =>
      opts.openBefore === true || (opts.opensOnClick !== undefined && clicks.length >= opts.opensOnClick);
    return {
      clicks,
      reloads,
      deps: {
        tagTexts: async () => {
          if (t < (opts.listedAt ?? 0) || (opts.staleList && reloads.length === 0)) return [];
          return open() ? [topicTitle, groupPreview, mainRoot] : [topicTitle, groupPreview];
        },
        headers: async () => (open() ? [{ x: 680, y: 18, width: 34, height: 20 }] : []),
        click: async (box: ScreenBox) => {
          clicks.push(box);
        },
        reload: async () => {
          reloads.push(t);
          t += 5_000;
        },
        viewport,
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      },
    };
  }

  it('waits for the entry, then clicks it until the main area shows the topic', async () => {
    const late = page({ listedAt: 10_000, opensOnClick: 1 });
    await expect(openTopicFromList(late.deps, 30_000)).resolves.toBe(true);
    expect(late.clicks).toEqual([topicTitle.box]);
    const slow = page({ opensOnClick: 2 });
    await expect(openTopicFromList(slow.deps, 30_000)).resolves.toBe(true);
    expect(slow.clicks).toHaveLength(2);
  });

  it('reloads a chat list that stopped updating, and only then', async () => {
    const stale = page({ staleList: true, opensOnClick: 1 });
    await expect(openTopicFromList(stale.deps, 90_000)).resolves.toBe(true);
    expect(stale.reloads).toHaveLength(1);
    expect(stale.clicks).toEqual([topicTitle.box]);
    // Listed in time: no reload.
    const fresh = page({ listedAt: 20_000, opensOnClick: 1 });
    await expect(openTopicFromList(fresh.deps, 90_000)).resolves.toBe(true);
    expect(fresh.reloads).toEqual([]);
    // An entry whose clicks never open the topic is a stale view too — but
    // reloaded only once: every reload draws the list blank again.
    const stuck = page({});
    await expect(openTopicFromList(stuck.deps, 150_000)).resolves.toBe(false);
    expect(stuck.reloads).toHaveLength(1);
    expect(stuck.reloads[0]).toBeGreaterThanOrEqual(20_000);
  });

  it('accepts the topic already open in the main area while the list draws blank rows', async () => {
    // CI (run 40257129089): no listed entry for over a minute, the topic itself open.
    const header = { x: 680, y: 18, width: 34, height: 20 };
    let t = 0;
    const clicks: ScreenBox[] = [];
    const blank = {
      tagTexts: async () => [mainRoot],
      headers: async () => [header],
      click: async (box: ScreenBox) => { clicks.push(box); },
      reload: async () => {},
      viewport,
      now: () => t,
      sleep: async (ms: number) => { t += ms; },
    };
    await expect(openTopicFromList(blank, 90_000)).resolves.toBe(true);
    expect(clicks).toEqual([]);
    expect(t).toBeLessThan(5_000);
    // A topic that only quotes the tag in a reply is not this one.
    const quoting = { ...blank, tagTexts: async () => [{ ...mainRoot, box: { ...mainRoot.box, y: 420 } }] };
    t = 0;
    await expect(openTopicFromList(quoting, 10_000)).resolves.toBe(false);
  });

  it('clicks the entry even when a topic carrying the tag is already open', async () => {
    // A later topic quotes the tag in its reply; only the click shows ours.
    const shown = page({ openBefore: true });
    await expect(openTopicFromList(shown.deps, 10_000)).resolves.toBe(true);
    expect(shown.clicks).toEqual([topicTitle.box]);
  });

  it('gives up within its budget', async () => {
    const never = page({});
    await expect(openTopicFromList(never.deps, 10_000)).resolves.toBe(false);
    expect(never.clicks.length).toBeGreaterThan(0);
    const unlisted = page({ listedAt: Infinity });
    await expect(openTopicFromList(unlisted.deps, 10_000)).resolves.toBe(false);
    expect(unlisted.clicks).toEqual([]);
  });
});

describe('Feishu E2E native topic opener', () => {
  const icon = { x: 1034, y: 946, width: 24, height: 24 };

  /**
   * Fake page. The message is still sending until `deliveredAt`: until then a
   * hover shows only 「⋯」, so findIcon sees no full toolbar, and the toolbar
   * is drawn for the state under the pointer at the last hover.
   */
  function page(opts: {
    deliveredAt?: number;
    hoverFails?: number;
    visionOpens?: boolean;
    visionThrows?: boolean;
    forwardOnClick?: number;
    panelAfterClicks?: number;
  }) {
    let t = 0;
    let hoveredAt = -1;
    let hoverFails = opts.hoverFails ?? 0;
    const calls = { hovers: 0, clicks: 0, visions: 0, dismisses: 0, panelChecks: 0, logs: [] as string[] };
    let opened = false;
    return {
      calls,
      deps: {
        hover: async () => {
          calls.hovers += 1;
          if (hoverFails > 0) {
            hoverFails -= 1;
            return false;
          }
          hoveredAt = t;
          return true;
        },
        findIcon: async () => (hoveredAt >= 0 && hoveredAt >= (opts.deliveredAt ?? 0) ? icon : null),
        click: async () => {
          calls.clicks += 1;
          if (calls.clicks >= (opts.panelAfterClicks ?? 1) && calls.clicks !== opts.forwardOnClick) opened = true;
        },
        askVision: async () => {
          calls.visions += 1;
          if (opts.visionThrows) throw new Error('Replanned 20 times, exceeding the limit.');
          if (opts.visionOpens) opened = true;
        },
        forwardDialogOpen: async () => calls.clicks === opts.forwardOnClick && !opened,
        dismiss: async () => {
          calls.dismisses += 1;
        },
        topicPanelOpen: async () => {
          calls.panelChecks += 1;
          return opened;
        },
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
        log: (message: string) => {
          calls.logs.push(message);
        },
      },
    };
  }

  it('waits for a just-sent message to offer its full toolbar, hovering again each time', async () => {
    const sending = page({ deliveredAt: 4_000 });
    await sending.deps.hover();
    await expect(waitForTopicIcon(sending.deps, 15_000)).resolves.toEqual(icon);
    expect(sending.calls.hovers).toBeGreaterThan(1);
    const stuck = page({ deliveredAt: Infinity });
    await stuck.deps.hover();
    await expect(waitForTopicIcon(stuck.deps, 5_000)).resolves.toBeNull();
  });

  it('clicks the topic icon itself once the message is delivered, without the vision agent', async () => {
    const p = page({ deliveredAt: 6_000 });
    await expect(openNativeTopicWith(p.deps, 'e2e-seed')).resolves.toBeUndefined();
    expect(p.calls.clicks).toBe(1);
    expect(p.calls.visions).toBe(0);
  });

  it('asks the vision agent only on the last attempt, and survives its failure until then', async () => {
    const opens = page({ deliveredAt: Infinity, visionOpens: true });
    await expect(openNativeTopicWith(opens.deps, 'e2e-seed')).resolves.toBeUndefined();
    expect(opens.calls.visions).toBe(1);
    const fails = page({ deliveredAt: Infinity, visionThrows: true });
    await expect(openNativeTopicWith(fails.deps, 'e2e-seed')).rejects.toThrow(/after 3 attempts/);
    expect(fails.calls.visions).toBe(1);
  });

  it('backs out of Forward or a click that opened nothing, then tries again', async () => {
    const forward = page({ forwardOnClick: 1 });
    await expect(openNativeTopicWith(forward.deps, 'e2e-seed')).resolves.toBeUndefined();
    expect(forward.calls.clicks).toBe(2);
    expect(forward.calls.dismisses).toBe(1);
    // The Forward dialog is closed before anyone looks for a topic panel behind it.
    expect(forward.calls.panelChecks).toBe(1);
    const late = page({ panelAfterClicks: 2 });
    await expect(openNativeTopicWith(late.deps, 'e2e-seed')).resolves.toBeUndefined();
    expect(late.calls.dismisses).toBe(1);
    const unhoverable = page({ hoverFails: 3 });
    await expect(openNativeTopicWith(unhoverable.deps, 'e2e-seed')).rejects.toThrow(/after 3 attempts/);
    expect(unhoverable.calls.clicks).toBe(0);
  });
});

describe('Feishu E2E session card wait', () => {
  function page(opts: { shownAt?: number; shownAfterReopen?: boolean; reopenMs?: number }) {
    let t = 0;
    const calls = { reopens: 0, nudges: 0 };
    return {
      calls,
      deps: {
        cardShown: async () =>
          (opts.shownAt !== undefined && t >= opts.shownAt) || (opts.shownAfterReopen === true && calls.reopens > 0),
        nudge: async () => {
          calls.nudges += 1;
        },
        reopen: async () => {
          calls.reopens += 1;
          t += opts.reopenMs ?? 10_000;
        },
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
      },
    };
  }

  it('waits for the card without reopening while it is on its way', async () => {
    const soon = page({ shownAt: 20_000 });
    await expect(waitForCardButtons(soon.deps, 90_000)).resolves.toBe(true);
    expect(soon.calls.reopens).toBe(0);
    expect(soon.calls.nudges).toBeGreaterThan(0);
  });

  it('reopens a topic that stopped updating, once', async () => {
    // CI: the view stayed at the recalled repo card while the session had answered.
    const stale = page({ shownAfterReopen: true });
    await expect(waitForCardButtons(stale.deps, 90_000)).resolves.toBe(true);
    expect(stale.calls.reopens).toBe(1);
    const never = page({});
    await expect(waitForCardButtons(never.deps, 90_000)).resolves.toBe(false);
    expect(never.calls.reopens).toBe(1);
  });

  it('still sees the card after a reopen that used up the budget', async () => {
    // Reopening loads Messenger and the topic again; it can outlast the 90s.
    const slow = page({ shownAfterReopen: true, reopenMs: 50_000 });
    await expect(waitForCardButtons(slow.deps, 90_000)).resolves.toBe(true);
    expect(slow.calls.reopens).toBe(1);
  });

  it('keeps the whole wait within its budget after a slow reopen', async () => {
    const never = page({ reopenMs: 50_000 });
    await expect(waitForCardButtons(never.deps, 90_000)).resolves.toBe(false);
    // 45s to the reopen, 50s inside it, then nothing more beyond the budget.
    expect(never.deps.now()).toBeLessThanOrEqual(90_000 + 50_000);
  });
});
