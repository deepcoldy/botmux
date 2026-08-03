import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SkillPacksTab } from '../src/dashboard/web/skills/skill-packs-tab.js';
import type { SkillPackRow } from '../src/dashboard/web/skills/types.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function pack(over: Partial<SkillPackRow> = {}): SkillPackRow {
  return {
    id: 'p1',
    name: 'Pack 1',
    include: ['skill:a', 'skill:b'],
    revision: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    references: [],
    missingSkills: [],
    resolvedSkills: [],
    ...over,
  };
}

function jsonRes(status: number, body: any) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function mockFetch(handler: (url: string, init?: RequestInit) => any): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function flush() {
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}

describe('skill packs tab', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders pack health badges for complete / missing / unassigned', async () => {
    mockFetch(() => jsonRes(200, { packs: [
      pack({ id: 'complete', name: 'Complete', references: [{ larkAppId: 'b1', botName: 'Bot1' }] }),
      pack({ id: 'missing', name: 'Missing', missingSkills: ['x'], references: [{ larkAppId: 'b1', botName: 'Bot1' }] }),
      pack({ id: 'unassigned', name: 'Unassigned', references: [] }),
    ] }));
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SkillPacksTab, { skills: [], onRefresh: () => {}, refreshKey: 0 }));
    });
    await flush();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Complete');
    expect(text).toContain('Missing');
    expect(text).toContain('Unassigned');
  });

  it('delete without in-use: calls DELETE without force', async () => {
    const fetchMock = mockFetch((url, init) => {
      if (init?.method === 'DELETE') return jsonRes(200, { ok: true });
      return jsonRes(200, { packs: [pack({ references: [{ larkAppId: 'b1', botName: 'Bot1' }] })] });
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SkillPacksTab, { skills: [], onRefresh: () => {}, refreshKey: 0 }));
    });
    await flush();
    const root = renderer.root;
    const dangerBtn = root.findAllByType('button').find((b: any) => String(b.props.className).includes('danger'));
    expect(dangerBtn).toBeDefined();
    await act(async () => { await dangerBtn!.props.onClick(); });
    await flush();
    const deleteCalls = fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'DELETE');
    expect(deleteCalls.length).toBe(1);
    expect(deleteCalls[0][0]).not.toContain('force=1');
  });

  it('delete with in-use: shows confirmation dialog, then force-deletes on confirm', async () => {
    const fetchMock = mockFetch((url, init) => {
      if (init?.method === 'DELETE' && !url.includes('force=1')) {
        return jsonRes(409, { error: 'SKILL_PACK_IN_USE', references: [{ larkAppId: 'b1', botName: 'Bot1' }] });
      }
      if (init?.method === 'DELETE' && url.includes('force=1')) {
        return jsonRes(200, { ok: true });
      }
      return jsonRes(200, { packs: [pack({ references: [{ larkAppId: 'b1', botName: 'Bot1' }] })] });
    });
    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(SkillPacksTab, { skills: [], onRefresh: () => {}, refreshKey: 0 }));
    });
    await flush();
    const root = renderer.root;
    const dangerBtn = root.findAllByType('button').find((b: any) => String(b.props.className).includes('danger'));
    await act(async () => { await dangerBtn!.props.onClick(); });
    await flush();

    // After 409, a confirmation dialog should appear with affected bot
    const dialog = root.findAllByType('dialog').find((d: any) => String(d.props.className).includes('delete-confirm'));
    expect(dialog).toBeDefined();
    expect(JSON.stringify(renderer.toJSON())).toContain('Bot1');

    // Confirm the force delete — submit the form inside the dialog
    const form = dialog!.findAllByType('form')[0];
    await act(async () => { await form.props.onSubmit({ preventDefault: () => {} }); });
    await flush();

    const forceDeleteCalls = fetchMock.mock.calls.filter((c: any) => c[1]?.method === 'DELETE' && c[0].includes('force=1'));
    expect(forceDeleteCalls.length).toBe(1);
  });
});
