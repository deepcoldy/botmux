import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { ReplyDeliverySection } from '../src/dashboard/web/bot-defaults-page.js';
import type { BotDefaultsRow } from '../src/dashboard/web/bot-defaults.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
it.each(['orca-codex', 'orca-claude', 'codex'])('shows the reply policy for %s', cliId => {
  let view!: TestRenderer.ReactTestRenderer;
  const bot = { larkAppId: 'app_test', cliId, replyDelivery: 'transcript', replyDeliverySupported: true } as BotDefaultsRow;
  act(() => { view = TestRenderer.create(React.createElement(ReplyDeliverySection, { bot, patchBot: vi.fn() })); });
  const toggle = view.root.findByProps({ 'data-action': 'toggle-reply-delivery' });
  expect(toggle.props.checked).toBe(true);
  expect(toggle.props.disabled).toBe(cliId.startsWith('orca-'));
  if (cliId.startsWith('orca-')) expect(JSON.stringify(view.toJSON())).toContain('Orca');
  act(() => view.unmount());
});
