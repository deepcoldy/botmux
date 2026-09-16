import { describe, expect, it } from 'vitest';
import { buildTraexStartupModeCard } from '../src/im/lark/traex-initialization-card.js';
import type { PendingTraexInitialization } from '../src/core/traex-initialization.js';

function walk(node: unknown, out: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (!node || typeof node !== 'object') return out;
  const record = node as Record<string, unknown>;
  out.push(record);
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) value.forEach(item => walk(item, out));
    else if (value && typeof value === 'object') walk(value, out);
  }
  return out;
}

describe('TraeX 启动方式卡', () => {
  const pending: PendingTraexInitialization = {
    nonce: 'nonce-1',
    ownerOpenId: 'ou_owner',
    originalPrompt: '帮我实现两阶段初始化',
    promptPrefix: '',
    phase: 'mode',
    selection: {
      kind: 'directory',
      path: '/repo/alpha',
      label: 'alpha (main)',
      pinWorkingDir: true,
    },
  };

  it('只渲染启动方式下拉，选择项回调直接携带 mode option', () => {
    const card = JSON.parse(buildTraexStartupModeCard({
      rootId: 'om_root',
      pending,
      locale: 'zh',
    }));
    const nodes = walk(card);

    expect(card.schema).toBeUndefined();
    expect(card.body).toBeUndefined();
    expect(card.header.title.content).toContain('选择 TraeX 启动方式');
    expect(JSON.stringify(card)).toContain('alpha (main)');

    const modeSelect = nodes.find(node =>
      node.tag === 'select_static'
      && (node.value as Record<string, unknown> | undefined)?.key === 'traex_init_mode');
    expect(modeSelect).toBeDefined();
    expect((modeSelect?.options as Array<Record<string, unknown>>).map(option => option.value))
      .toEqual(['traex', 'forge-pipeline', 'forge-pilot']);
    expect(modeSelect).toMatchObject({
      value: {
        key: 'traex_init_mode',
        root_id: 'om_root',
        nonce: 'nonce-1',
      },
    });
  });

  it('不包含仓库选择、提示词输入或启动按钮，避免下拉状态和按钮状态分离', () => {
    const card = JSON.parse(buildTraexStartupModeCard({
      rootId: 'om_root',
      pending,
      locale: 'zh',
    }));
    const nodes = walk(card);

    expect(nodes.find(node =>
      node.tag === 'select_static'
      && (node.value as Record<string, unknown> | undefined)?.key === 'repo_switch')).toBeUndefined();
    expect(nodes.find(node =>
      node.tag === 'select_static'
      && (node.value as Record<string, unknown> | undefined)?.key === 'repo_worktree')).toBeUndefined();
    expect(nodes.find(node => node.tag === 'input')).toBeUndefined();
    expect(nodes.find(node =>
      node.tag === 'button'
      && (node.value as Record<string, unknown> | undefined)?.action === 'traex_init_start')).toBeUndefined();
    expect(nodes.find(node =>
      node.tag === 'button'
      && (node.value as Record<string, unknown> | undefined)?.action === 'traex_init_cancel')).toBeDefined();
  });
});
