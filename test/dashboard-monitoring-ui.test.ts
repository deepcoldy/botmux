import { readFileSync } from 'node:fs';
import React from 'react';
import TestRenderer from 'react-test-renderer';
import { describe, expect, it } from 'vitest';

import { SessionResourceTable } from '../src/dashboard/web/monitoring-page.js';

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

describe('dashboard monitoring session table', () => {
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
    expect(css).toMatch(/\.metric-card \.resource-help-popover\s*\{[^}]*z-index:\s*40/s);
    expect(css).toMatch(/\.resource-help-tip:hover \.resource-help-popover,\s*\.resource-help-tip:focus-within \.resource-help-popover\s*\{[^}]*pointer-events:\s*auto/s);
  });
});
