/**
 * Suites open and close their Feishu session through feishu-session.ts. A
 * beforeAll that fails half-way must leave no browser, and no chat lease its
 * page took, behind (run 40170880120: a leaked `dm:Claude` holder starved six
 * cases and kept the runner alive until the step timeout), and must never
 * press 关闭会话 on a screen that is not its chat. A session that was built is
 * closed bot session first. Runs the real suite registration,
 * beforeAll/afterAll and chat leases; only Chromium and Feishu are faked.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  browsers: [] as Array<{ closed: boolean }>,
  closeSessionCalls: 0,
  failOpenChat: false,
  failMessenger: false,
  failSend: false,
}));

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  const existsSync = (p: import('node:fs').PathLike) =>
    String(p).endsWith('storageState.json') || fs.existsSync(p);
  return { ...fs, existsSync, default: { ...fs, existsSync } };
});

vi.mock('./e2e-browser/e2e-video.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./e2e-browser/e2e-video.js')>()),
  publishLabeledPageVideo: async () => {},
}));

vi.mock('./e2e-browser/helpers.js', async (importOriginal) => {
  const helpers = await importOriginal<typeof import('./e2e-browser/helpers.js')>();
  const { holdLeaseForPage, dmLeaseKey } = await import('./e2e-browser/chat-lease.js');
  return {
    ...helpers,
    checkPrerequisites: () => {},
    createBrowser: async () => {
      const browser = { closed: false, close: async () => { browser.closed = true; } };
      fake.browsers.push(browser);
      return browser;
    },
    createPage: async () => {
      const onClose: Array<() => void> = [];
      let closed = false;
      const page = {
        isClosed: () => closed,
        once: (event: string, cb: () => void) => { if (event === 'close') onClose.push(cb); },
      };
      const context = {
        close: async () => {
          if (closed) return;
          closed = true;
          for (const cb of onClose) cb();
        },
      };
      return { context, page };
    },
    createAgent: () => ({ destroy: async () => {} }),
    navigateToMessenger: async () => {
      if (fake.failMessenger) throw new Error('Feishu Messenger chat list not loaded');
    },
    // The real openChat takes the shared DM lease before it checks the title bar.
    openChat: async (page: never, _agent: unknown, bot: string) => {
      await holdLeaseForPage(page, dmLeaseKey(bot), 'shared');
      if (fake.failOpenChat) throw new Error('the title bar shows a topic, not [Botmux]Claude');
    },
    closeSession: async () => { fake.closeSessionCalls += 1; },
    sendMessage: async () => {
      if (fake.failSend) throw new Error('send failed');
    },
  };
});

const { runFeishuScenario } = await import('./e2e-browser/midscene-suite.js');
const { acquireLease } = await import('./e2e-browser/chat-lease.js');

afterEach(() => {
  fake.browsers.length = 0;
  fake.closeSessionCalls = 0;
  fake.failOpenChat = false;
  fake.failMessenger = false;
  fake.failSend = false;
});

/** A leaked shared holder would make this exclusive wait time out. */
async function dmLeaseIsFree(bot: string): Promise<void> {
  const release = await acquireLease(`dm:${bot}`, 'exclusive', 200);
  release();
}

describe('Feishu E2E half-built sessions', () => {
  it.each(['conversation-follow-up', 'consecutive-messages'] as const)(
    '%s: closes the browser and frees the DM lease when openChat fails in beforeAll',
    async (scenario) => {
      fake.failOpenChat = true;
      await expect(runFeishuScenario(scenario)).rejects.toThrow(/title bar/);
      expect(fake.browsers.map(b => b.closed)).toEqual([true]);
      await dmLeaseIsFree('Claude');
      // Its screen is not this case's chat: 关闭会话 there could end another lane's session.
      expect(fake.closeSessionCalls).toBe(0);
    },
  );

  it('closes the browser when Messenger never loads for a chat-mode case', async () => {
    fake.failMessenger = true;
    await expect(runFeishuScenario('dm-chat-claude')).rejects.toThrow(/not loaded/);
    expect(fake.browsers.map(b => b.closed)).toEqual([true]);
  });

  it('leaves the bot session alone when a chat-mode case fails', async () => {
    // Its setup opens no chat; the case drives its sessions through resetSession.
    fake.failOpenChat = true;
    await expect(runFeishuScenario('dm-chat-claude')).rejects.toThrow(/title bar/);
    expect(fake.closeSessionCalls).toBe(0);
    expect(fake.browsers.map(b => b.closed)).toEqual([true]);
    await dmLeaseIsFree('Claude');
  });

  it('closes a built session bot session first, then the browser', async () => {
    fake.failSend = true;
    await expect(runFeishuScenario('consecutive-messages')).rejects.toThrow(/send failed/);
    expect(fake.closeSessionCalls).toBe(1);
    expect(fake.browsers.map(b => b.closed)).toEqual([true]);
    await dmLeaseIsFree('Claude');
  });
});
