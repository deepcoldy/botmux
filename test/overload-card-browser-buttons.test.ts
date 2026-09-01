import { describe, expect, it } from 'bun:test';
import {
  buildOverloadAlertCard,
  initialOverloadCardState,
  OVERLOAD_ACTION_RESTART_BROWSER,
  OVERLOAD_ACTION_NOOP,
  type OverloadAlertAction,
  type OverloadCardBrowser,
} from '../src/core/host-overload-alert.js';

const action: OverloadAlertAction = {
  kind: 'entered',
  reasons: ['memory'],
  reading: { load15: 6.9, memTotalBytes: 32e9, memFreeBytes: 0.3e9 },
  metrics: { load15: 6.9, loadPerCpu: 0.57, cpuCount: 12, memUsedFrac: 0.99 },
};

const browsers: OverloadCardBrowser[] = [
  { bundleId: 'company.thebrowser.Browser', label: 'Arc', memMB: 6202 },
  { bundleId: 'com.google.Chrome', label: 'Chrome', memMB: 1659 },
];

describe('overload card browser buttons', () => {
  it('renders one restart button per running browser, each with its own bundleId', () => {
    const st = initialOverloadCardState(action, { stopped: 0, idle: 0 }, 'n1', browsers);
    const card = JSON.parse(buildOverloadAlertCard(st));
    const btns = card.elements.flatMap((e: any) => e.tag === 'action' ? e.actions : []);
    const restartBtns = btns.filter((b: any) => b.value?.action === OVERLOAD_ACTION_RESTART_BROWSER);
    expect(restartBtns.map((b: any) => b.value.bundleId)).toEqual([
      'company.thebrowser.Browser', 'com.google.Chrome',
    ]);
    expect(restartBtns[0].text.content).toBe('♻️ 重启 Arc · 6.1 GB');
    expect(restartBtns[1].text.content).toBe('♻️ 重启 Chrome · 1.6 GB');
  });

  it('shows NO browser buttons when nothing is running', () => {
    const st = initialOverloadCardState(action, { stopped: 1, idle: 2 }, 'n2', []);
    const card = JSON.parse(buildOverloadAlertCard(st));
    const btns = card.elements.flatMap((e: any) => e.tag === 'action' ? e.actions : []);
    expect(btns.some((b: any) => b.value?.action === OVERLOAD_ACTION_RESTART_BROWSER)).toBe(false);
  });

  it('marks a restarted browser done (disabled ✓) while the other stays clickable', () => {
    const st = initialOverloadCardState(action, { stopped: 0, idle: 0 }, 'n3', browsers);
    st.restartedBrowsers = ['company.thebrowser.Browser'];
    const card = JSON.parse(buildOverloadAlertCard(st));
    const btns = card.elements.flatMap((e: any) => e.tag === 'action' ? e.actions : []);
    const arc = btns.find((b: any) => b.text.content.includes('Arc'));
    const chrome = btns.find((b: any) => b.text.content.includes('Chrome'));
    expect(arc.disabled).toBe(true);
    expect(arc.text.content).toBe('✓ 已重启 Arc');
    expect(arc.value.action).toBe(OVERLOAD_ACTION_NOOP);
    expect(chrome.disabled).toBeUndefined();
    expect(chrome.value.action).toBe(OVERLOAD_ACTION_RESTART_BROWSER);
  });
});

describe('overload card — >4 browser buttons split into rows of 4', () => {
  it('chunks 5 browser targets into two action rows (4 + 1)', () => {
    const many: OverloadCardBrowser[] = Array.from({ length: 5 }, (_, i) => ({
      bundleId: `com.b${i}.Browser`, label: `B${i}`, memMB: 1000 + i,
    }));
    const st = initialOverloadCardState(action, { stopped: 0, idle: 0 }, 'n-many', many);
    const card = JSON.parse(buildOverloadAlertCard(st));
    const actionRows = card.elements.filter((e: any) => e.tag === 'action');
    // row 0 = clean+suspend, rows 1..N = browser buttons chunked by 4.
    const browserRows = actionRows.filter((r: any) =>
      r.actions.some((b: any) => b.value?.action === OVERLOAD_ACTION_RESTART_BROWSER || String(b.text.content).includes('重启 B')));
    expect(browserRows).toHaveLength(2);
    expect(browserRows[0].actions).toHaveLength(4);
    expect(browserRows[1].actions).toHaveLength(1);
  });
});
