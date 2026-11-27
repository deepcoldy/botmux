import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/dashboard/web/modal-dialog.js', () => ({
  ModalDialog: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
}));

import { SessionDetailsDrawer } from '../src/dashboard/web/sessions-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let renderer: TestRenderer.ReactTestRenderer | undefined;

afterEach(async () => {
  if (renderer) await act(async () => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const callbacks = {
  onClose: vi.fn(), locateSession: vi.fn(), openHistory: vi.fn(), resumeSession: vi.fn(), restartSession: vi.fn(),
  closeSession: vi.fn(), setSessionLocked: vi.fn(), startSession: vi.fn(), onTakeover: vi.fn(), onOpenTerminal: vi.fn(),
};

/** 抽屉底部主操作区里渲染出来的按钮 id（没有 id 的按钮不参与比较）。 */
async function footActionIds(row: Record<string, unknown>): Promise<string[]> {
  vi.stubGlobal('window', { location: { protocol: 'https:', origin: 'https://fixture.invalid', hostname: 'fixture.invalid' } });
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(SessionDetailsDrawer, { ...callbacks, row }));
  });
  return renderer!.root
    .findByProps({ className: 'drawer-foot-actions' })
    .findAllByType('button')
    .map(node => node.props.id)
    .filter((id): id is string => typeof id === 'string');
}

const larkRow = {
  sessionId: 'lark-session', larkAppId: 'cli_app', botName: '飞书助理', cliId: 'claude', title: 'work',
  chatId: 'oc_chat', rootMessageId: 'om_root', webPort: 12345, workingDir: '/workspace',
};

describe('session drawer primary actions', () => {
  it('keeps the live actions for a dormant Feishu session, which is not closed underneath', async () => {
    const ids = await footActionIds({ ...larkRow, status: 'dormant' });
    expect(ids).not.toContain('resume-btn');
    expect(ids).toEqual(expect.arrayContaining(['takeover-btn', 'restart-btn', 'close-btn']));
  });

  it('offers only resume for a closed Feishu session', async () => {
    expect(await footActionIds({ ...larkRow, status: 'closed' })).toEqual(['resume-btn']);
  });

  it('offers only resume for a dormant WeCom session that advertises it', async () => {
    const ids = await footActionIds({
      sessionId: 'wecom:cfg:core:1', provider: 'wecom', providerBotId: 'cfg', status: 'dormant', cliId: 'codex',
      capabilities: { resume: true, close: true, restart: true },
    });
    expect(ids).toEqual(['resume-btn']);
  });

  it('shows the advertised live actions for a dormant WeCom session that cannot resume', async () => {
    const ids = await footActionIds({
      sessionId: 'wecom:cfg:core:2', provider: 'wecom', providerBotId: 'cfg', status: 'dormant', cliId: 'codex',
      capabilities: { resume: false, close: true },
    });
    expect(ids).toEqual(['close-btn']);
  });

  it('offers nothing for a closed WeCom session without resume', async () => {
    const ids = await footActionIds({
      sessionId: 'wecom:cfg:core:3', provider: 'wecom', providerBotId: 'cfg', status: 'closed', cliId: 'codex',
      capabilities: { resume: false, close: false },
    });
    expect(ids).toEqual([]);
  });
});
