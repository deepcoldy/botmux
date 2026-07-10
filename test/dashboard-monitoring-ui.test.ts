import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer, { type ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { MonitoringPage, SessionResourceTable } from '../src/dashboard/web/monitoring-page.js';

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

describe('dashboard monitoring session table', () => {
  it('declares runtime monitoring sections and status classes', () => {
    const page = readFileSync(new URL('../src/dashboard/web/monitoring-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(page).toContain("monitoring.runtimeHealth");
    expect(page).toContain("monitoring.resourcePressure");
    expect(page).toContain("monitoring.sessionPressure");
    expect(page).toContain("monitoring.botRuntime");
    expect(page).toContain("runtime-health-grid");
    expect(page).toContain("runtime-pressure-grid");
    expect(page).toContain("runtime-status-pill");
    expect(css).toContain(".runtime-health-grid");
    expect(css).toContain(".runtime-pressure-grid");
    expect(css).toContain(".runtime-status-pill");
  });

  it('keeps all session rows in a ten-row scroll body under a fixed header', () => {
    const renderer = TestRenderer.create(React.createElement(SessionResourceTable, {
      sessions: Array.from({ length: 12 }, (_, index) => makeSession(index + 1)),
    }));
    const root = renderer.root;

    const table = root.findByProps({ className: 'resource-table resource-session-table' });
    const header = table.findByProps({ className: 'resource-row resource-row-head' });
    const scrollBody = table.findByProps({ className: 'resource-session-scroll', 'data-visible-rows': 10 });

    expect(header.parent).toBe(table);
    expect(scrollBody.parent).toBe(table);
    const rows = scrollBody.findAll(node =>
      typeof node.props.className === 'string' && node.props.className.startsWith('resource-row'));
    expect(rows).toHaveLength(12);
    expect(scrollBody.findAll(node => node.props.className === 'resource-row is-tracked')).toHaveLength(2);
  });

  it('keeps runtime health visible when resource sampling is unsupported', () => {
    const renderer = TestRenderer.create(React.createElement(MonitoringPage, {
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
    const renderer = TestRenderer.create(React.createElement(MonitoringPage, {
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
    const renderer = TestRenderer.create(React.createElement(MonitoringPage, {
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
    const renderer = TestRenderer.create(React.createElement(MonitoringPage, {
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

    const botTable = root.findByProps({ className: 'resource-table resource-bot-table' });
    const botRow = botTable.findAllByProps({ className: 'resource-row' })
      .find(row => textContent(row).includes('FallbackBot'));
    expect(botRow).toBeTruthy();
    expect(textContent(botRow!.children[2] as ReactTestInstance)).toBe('4');
    expect(textContent(botRow!.children[3] as ReactTestInstance)).toBe('-');
    expect(textContent(botRow!.children[4] as ReactTestInstance)).toBe('-');
  });

  it('renders current CPU as unavailable before a CPU delta baseline is ready', () => {
    const renderer = TestRenderer.create(React.createElement(MonitoringPage, {
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

    const botTable = root.findByProps({ className: 'resource-table resource-bot-table' });
    const botRow = botTable.findAllByProps({ className: 'resource-row' })
      .find(row => textContent(row).includes('CpuPendingBot'));
    expect(textContent(botRow!.children[5] as ReactTestInstance)).toBe('-');
    expect(textContent(botRow!.children[6] as ReactTestInstance)).toBe('256 MiB');

    const sessionTable = root.findByProps({ className: 'resource-table resource-session-table' });
    const sessionRow = sessionTable.findAllByProps({ className: 'resource-row' })
      .find(row => textContent(row).includes('CPU Pending'));
    expect(textContent(sessionRow!.children[2] as ReactTestInstance)).toBe('-');
    expect(textContent(sessionRow!.children[3] as ReactTestInstance)).toBe('64 MiB');
  });

  it('keeps overview resource strip aligned with runtime CPU readiness', () => {
    const page = readFileSync(new URL('../src/dashboard/web/overview-page.tsx', import.meta.url), 'utf8');

    expect(page).toContain('cpuReady?: boolean');
    expect(page).toContain("tr('monitoring.runtimeTitle')");
    expect(page).not.toContain("tr('monitoring.title')</span>");
    expect(page).toContain("resources?.cpuReady === false ? '-'");
    expect(page).toContain('resource-strip-metric');
    expect(page).toContain('combinedHealth');
    expect(page).not.toContain('hottestResource');

    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    expect(css).toContain('.resource-strip:hover');
    expect(css).toContain('.resource-health-dot.danger');
  });

  it('limits the session body height with CSS instead of dropping rows', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(css).toContain('.resource-session-scroll');
    expect(css).toMatch(/max-height:\s*calc\(var\(--resource-session-row-height\)\s*\*\s*10\)/);
    expect(css).toMatch(/overflow-y:\s*auto/);
  });

  it('preserves line breaks in the RSS help tooltip', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.metric-card \.resource-help-popover\s*\{[^}]*white-space:\s*pre-line/s);
  });

  it('layers resource metric help popovers above following panels', () => {
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(css).toMatch(/\.resource-page\s*\{[^}]*isolation:\s*isolate/s);
    expect(css).toMatch(/\.resource-metrics\s*\{[^}]*position:\s*relative[^}]*z-index:\s*30/s);
    expect(css).toMatch(/\.resource-page > \.panel\s*\{[^}]*position:\s*relative[^}]*z-index:\s*10/s);
    expect(css).toMatch(/\.resource-page > \.resource-pressure\s*\{[^}]*z-index:\s*30[^}]*overflow:\s*visible/s);
    expect(css).toMatch(/\.metric-card \.resource-help-popover\s*\{[^}]*z-index:\s*40/s);
    expect(css).toMatch(/\.resource-help-tip:hover \.resource-help-popover,\s*\.resource-help-tip:focus-within \.resource-help-popover\s*\{[^}]*pointer-events:\s*auto/s);
  });

  it('uses a compact unsupported resource sampling empty state', () => {
    const page = readFileSync(new URL('../src/dashboard/web/monitoring-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');

    expect(page).toContain('resource-unavailable-card');
    expect(page).toContain("monitoring.unsupportedTitle");
    expect(page).toContain("monitoring.unsupportedHint");
    expect(page).not.toContain("<p>{current?.reason ?? 'procfs_unavailable'}</p>");
    expect(css).toContain('.resource-unavailable-card');
    expect(css).toContain('.resource-unavailable-status');
  });
});
