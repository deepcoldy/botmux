import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { MonitoringPage, SessionResourceTable } from '../src/dashboard/web/monitoring-page.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeSession(index: number) {
  return {
    sessionId: `session-${index}`,
    larkAppId: 'app-a',
    botName: 'AI',
    title: `Session ${index}`,
    confidence: 'marker',
    tracked: index <= 2,
    rankReasons: index <= 2 ? ['cpu'] : [],
    current: {
      cpuPct: index,
      cpu1mPct: index,
      cpu5mPct: index,
      rssBytes: index * 1024 * 1024,
      rssGrowth5mBytes: index * 1024,
    },
  };
}

function textContent(node: ReactTestInstance): string {
  return node.children.map(child => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    return textContent(child as ReactTestInstance);
  }).join('');
}

function resourcePills(node: ReactTestInstance): ReactTestInstance[] {
  return node.findAll(child =>
    child.type === 'span'
    && typeof child.props.className === 'string'
    && child.props.className.split(/\s+/).includes('resource-pill'));
}

function render(element: React.ReactElement): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

describe('dashboard monitoring session table', () => {
  it('keeps all session rows in a ten-row scroll list', () => {
    const renderer = render(React.createElement(SessionResourceTable, {
      sessions: Array.from({ length: 12 }, (_, index) => makeSession(index + 1)),
    }));
    const root = renderer.root;

    const scrollList = root.findByProps({ className: 'overview-list resource-runtime-list resource-session-list' });
    const rows = scrollList.findAll(node =>
      node.type === 'li'
      && typeof node.props.className === 'string'
      && node.props.className.includes('resource-session-item'));
    expect(rows).toHaveLength(12);
    expect(rows.filter(row => row.props.className.includes('is-tracked'))).toHaveLength(2);
  });

  it('keeps runtime health visible when resource sampling is unsupported', () => {
    const renderer = render(React.createElement(MonitoringPage, {
      initialCurrent: {
        supported: false,
        reason: 'procfs_unavailable',
        runtime: {
          sampleHealth: { status: 'fresh', ageMs: 5_000 },
          daemons: { total: 2, online: 1, offline: 1 },
          sessions: {
            total: 3,
            working: 2,
            starting: 1,
            idle: 0,
            waiting: 0,
            unknown: 0,
            unattributed: 1,
            longestRunning: { sessionId: 'run', larkAppId: 'app-a', botName: 'AI', title: 'Run', durationMs: 59_000 },
            longestWaiting: { sessionId: 'wait', larkAppId: 'app-a', botName: 'AI', title: 'Wait', durationMs: 1_000 },
          },
        },
      },
      initialHistory: { supported: false, bots: [], sessions: [] },
      poll: false,
    }));
    const root = renderer.root;

    const health = root.findByProps({ className: 'panel runtime-health-panel' });
    expect(health.findByProps({ className: 'runtime-status-pill fresh' })).toBeTruthy();
    expect(textContent(health)).toContain('1/2');
    expect(textContent(health)).toContain('5s');

    const pressure = root.findByProps({ className: 'panel runtime-session-pressure' });
    expect(textContent(pressure)).toContain('59s');
    expect(textContent(pressure)).toContain('1s');

    const unavailable = root.findByProps({ className: 'panel resource-unavailable' });
    expect(unavailable.findByProps({ className: 'resource-unavailable-card' })).toBeTruthy();
    expect(textContent(unavailable)).toContain('资源采样仅支持 Linux');
    expect(textContent(unavailable)).toContain('运行健康仍可继续查看');
    expect(textContent(unavailable)).not.toContain('procfs_unavailable');
    expect(root.findAllByProps({ className: 'panel resource-pressure' })).toHaveLength(0);
  });

  it('renders zero sample age as fresh data instead of missing data', () => {
    const renderer = render(React.createElement(MonitoringPage, {
      initialCurrent: {
        supported: true,
        host: { cpuPct: 1, memUsedPct: 2, load1: 0.1 },
        botmux: { cpuPct: 1, rssBytes: 128 * 1024 * 1024 },
        bots: [],
        sessions: [],
        rankings: { tracked: [] },
        runtime: {
          sampleHealth: { status: 'fresh', ageMs: 0 },
          daemons: { total: 0, online: 0, offline: 0 },
          sessions: { total: 0, working: 0, starting: 0, idle: 0, waiting: 0, unknown: 0, unattributed: 0 },
        },
      },
      initialHistory: { supported: true, bots: [], sessions: [] },
      poll: false,
    }));

    const healthText = textContent(renderer.root.findByProps({ className: 'panel runtime-health-panel' }));
    expect(healthText).toContain('0s');
    expect(healthText).not.toContain('数据年龄 -');
  });

  it('breaks the Botmux memory tile into self (daemon + worker) vs external CLI', () => {
    const renderer = render(React.createElement(MonitoringPage, {
      initialCurrent: {
        supported: true,
        cpuReady: true,
        host: { cpuPct: 1, memUsedPct: 2, load1: 0.1 },
        botmux: { cpuPct: 1, rssBytes: 768 * 1024 * 1024 },
        botmuxBreakdown: {
          daemon: { cpuPct: 0, rssBytes: 128 * 1024 * 1024 },
          worker: { cpuPct: 0, rssBytes: 128 * 1024 * 1024 },
          cli: { cpuPct: 0, rssBytes: 512 * 1024 * 1024 },
        },
        bots: [],
        sessions: [],
        rankings: { tracked: [] },
        runtime: {
          sampleHealth: { status: 'fresh', ageMs: 0 },
          daemons: { total: 0, online: 0, offline: 0 },
          sessions: { total: 0, working: 0, starting: 0, idle: 0, waiting: 0, unknown: 0, unattributed: 0 },
        },
      },
      initialHistory: { supported: true, bots: [], sessions: [] },
      poll: false,
    }));

    const botmuxCard = renderer.root
      .findByProps({ className: 'panel resource-pressure' })
      .findAllByProps({ className: 'metric-card' })[2];
    const text = textContent(botmuxCard);
    expect(text).toContain('768 MiB');   // total (strong)
    expect(text).toContain('本体');       // self line label
    expect(text).toContain('256 MiB');   // self = daemon 128 + worker 128
    expect(text).toContain('外部 CLI');   // external CLI line label
    expect(text).toContain('512 MiB');   // external CLI value
    // CPU must NOT appear in the memory tile anymore.
    expect(text).not.toContain('%');
  });

  it('renders missing runtime counts as unknown without hiding resource fallback counts', () => {
    const renderer = render(React.createElement(MonitoringPage, {
      initialCurrent: {
        supported: true,
        host: { cpuPct: 12, memUsedPct: 34, load1: 0.5 },
        botmux: { cpuPct: 3, rssBytes: 512 * 1024 * 1024 },
        bots: [{
          larkAppId: 'app-a',
          botName: 'FallbackBot',
          daemonStatus: 'online',
          sessions: { count: 4 },
          total: { cpuPct: 1.5, rssBytes: 256 * 1024 * 1024 },
        }],
        sessions: [],
        rankings: { tracked: [] },
      },
      initialHistory: { supported: true, bots: [], sessions: [] },
      poll: false,
    }));
    const root = renderer.root;

    const healthText = textContent(root.findByProps({ className: 'panel runtime-health-panel' }));
    expect(healthText).toContain('-/-');
    expect(healthText).not.toContain('0/0');
    expect(healthText).not.toContain('工作中 0');

    const botList = root.findByProps({ className: 'overview-list resource-runtime-list' });
    const botRow = botList.findAllByProps({ className: 'overview-list-item resource-list-item resource-bot-item' })
      .find(row => textContent(row).includes('FallbackBot'));
    expect(botRow).toBeTruthy();
    expect(textContent(botRow!.findByProps({ className: 'overview-list-main' }))).toContain('4');
    expect(botRow!.findAllByProps({ className: 'resource-pill accent' })[0].findByType('b').children).toEqual(['-']);
  });

  it('renders current CPU as unavailable before a CPU delta baseline is ready', () => {
    const renderer = render(React.createElement(MonitoringPage, {
      initialCurrent: {
        supported: true,
        cpuReady: false,
        host: { cpuPct: 0, memUsedPct: 40, load1: 0.25 },
        botmux: { cpuPct: 0, rssBytes: 128 * 1024 * 1024 },
        bots: [{
          larkAppId: 'app-a',
          botName: 'CpuPendingBot',
          daemonStatus: 'online',
          runtime: { daemonStatus: 'online', sessions: { total: 1, working: 1, starting: 0, waiting: 0 } },
          total: { cpuPct: 0, rssBytes: 256 * 1024 * 1024 },
        }],
        sessions: [{
          sessionId: 'session-a',
          larkAppId: 'app-a',
          botName: 'CpuPendingBot',
          title: 'CPU Pending',
          status: 'working',
          confidence: 'descendant',
          current: {
            cpuPct: 0,
            cpu1mPct: 0,
            rssBytes: 64 * 1024 * 1024,
            rssGrowth5mBytes: 4 * 1024 * 1024,
          },
        }],
        runtime: {
          sampleHealth: { status: 'fresh', ageMs: 0 },
          daemons: { total: 1, online: 1, offline: 0 },
          sessions: { total: 1, working: 1, starting: 0, idle: 0, waiting: 0, unknown: 0, unattributed: 0 },
        },
        rankings: { tracked: [] },
      },
      initialHistory: { supported: true, bots: [], sessions: [] },
      poll: false,
    }));
    const root = renderer.root;

    const healthCards = root
      .findByProps({ className: 'panel runtime-health-panel' })
      .findAllByProps({ className: 'metric-card runtime-health-card' });
    expect(textContent(healthCards[3].findByType('strong'))).toBe('-');
    expect(textContent(healthCards[3])).toContain('40.0%');
    expect(textContent(healthCards[3])).toContain('128 MiB');

    const pressureCards = root
      .findByProps({ className: 'panel resource-pressure' })
      .findAllByProps({ className: 'metric-card' });
    expect(textContent(pressureCards[0].findByType('strong'))).toBe('-');
    expect(textContent(pressureCards[1].findByType('strong'))).toBe('40.0%');
    // The Botmux memory tile is memory-only now — CPU was removed from it (CPU under
    // a memory tile is misleading; the Botmux CPU trend still lives in the sparklines).
    expect(textContent(pressureCards[2].findByType('strong'))).toBe('128 MiB');

    const botList = root.findByProps({ className: 'overview-list resource-runtime-list' });
    const botRow = botList.findAllByProps({ className: 'overview-list-item resource-list-item resource-bot-item' })
      .find(row => textContent(row).includes('CpuPendingBot'));
    const botPills = resourcePills(botRow!);
    expect(textContent(botPills[3])).toContain('-');
    expect(textContent(botPills[4])).toContain('256 MiB');

    const sessionList = root.findByProps({ className: 'overview-list resource-runtime-list resource-session-list' });
    const sessionRow = sessionList.findAllByProps({ className: 'overview-list-item resource-list-item resource-session-item' })
      .find(row => textContent(row).includes('CPU Pending'));
    const sessionPills = resourcePills(sessionRow!);
    expect(textContent(sessionPills[0])).toContain('-');
    expect(textContent(sessionPills[1])).toContain('64 MiB');
  });
});
