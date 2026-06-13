import { describe, expect, it } from 'vitest';
import { detectDashboardLocale, normalizeDashboardLocale } from '../src/dashboard/web/i18n.js';
import { stripMentionPrefix } from '../src/dashboard/web/ui.js';
import {
  DEFAULT_BOARD_ORDER,
  normalizeBoardOrder,
  normalizeSessionsViewMode,
  normalizeSidebarMode,
  normalizeSkin,
  normalizeThemeMode,
  readStoredSessionsViewMode,
  readStoredSidebarMode,
  readStoredSkin,
  resolveThemeMode,
} from '../src/dashboard/web/preferences.js';

describe('dashboard locale preferences', () => {
  it('normalizes supported locale values', () => {
    expect(normalizeDashboardLocale('zh')).toBe('zh');
    expect(normalizeDashboardLocale('zh-CN')).toBe('zh');
    expect(normalizeDashboardLocale('en-US')).toBe('en');
    expect(normalizeDashboardLocale('fr-FR')).toBeNull();
  });

  it('detects browser language with Chinese as the fallback', () => {
    expect(detectDashboardLocale(['en-US', 'zh-CN'])).toBe('en');
    expect(detectDashboardLocale(['fr-FR', 'zh-Hans-CN'])).toBe('zh');
    expect(detectDashboardLocale([])).toBe('zh');
  });
});

describe('dashboard theme preferences', () => {
  it('normalizes theme modes', () => {
    expect(normalizeThemeMode('system')).toBe('system');
    expect(normalizeThemeMode('light')).toBe('light');
    expect(normalizeThemeMode('dark')).toBe('dark');
    expect(normalizeThemeMode('sepia')).toBeNull();
  });

  it('resolves system mode from the current color scheme', () => {
    expect(resolveThemeMode('system', true)).toBe('dark');
    expect(resolveThemeMode('system', false)).toBe('light');
    expect(resolveThemeMode('dark', false)).toBe('dark');
    expect(resolveThemeMode('light', true)).toBe('light');
  });
});

describe('dashboard skin preferences', () => {
  it('normalizes skin ids', () => {
    expect(normalizeSkin('default')).toBe('default');
    expect(normalizeSkin('cyber')).toBe('cyber');
    expect(normalizeSkin('2077')).toBeNull();
    expect(normalizeSkin(undefined)).toBeNull();
  });

  it('falls back to the default skin for missing/invalid storage', () => {
    const make = (value: string | null): Storage =>
      ({ getItem: () => value }) as unknown as Storage;
    expect(readStoredSkin(undefined)).toBe('default');
    expect(readStoredSkin(make(null))).toBe('default');
    expect(readStoredSkin(make('nope'))).toBe('default');
    expect(readStoredSkin(make('cyber'))).toBe('cyber');
  });
});

describe('sessions view mode preference', () => {
  it('accepts kanban, board, and table', () => {
    expect(normalizeSessionsViewMode('kanban')).toBe('kanban');
    expect(normalizeSessionsViewMode('board')).toBe('board');
    expect(normalizeSessionsViewMode('table')).toBe('table');
    expect(normalizeSessionsViewMode('list')).toBeNull();
    expect(normalizeSessionsViewMode(undefined)).toBeNull();
  });

  it('falls back to board for missing/invalid storage', () => {
    const make = (value: string | null): Storage =>
      ({ getItem: () => value }) as unknown as Storage;
    expect(readStoredSessionsViewMode(undefined)).toBe('board');
    expect(readStoredSessionsViewMode(make(null))).toBe('board');
    expect(readStoredSessionsViewMode(make('nope'))).toBe('board');
    expect(readStoredSessionsViewMode(make('kanban'))).toBe('kanban');
  });
});

describe('sidebar mode preference', () => {
  it('accepts expanded/collapsed and rejects junk', () => {
    expect(normalizeSidebarMode('expanded')).toBe('expanded');
    expect(normalizeSidebarMode('collapsed')).toBe('collapsed');
    expect(normalizeSidebarMode('hidden')).toBeNull();
    expect(normalizeSidebarMode(undefined)).toBeNull();
  });

  it('falls back to expanded for missing/invalid storage', () => {
    const make = (value: string | null): Storage =>
      ({ getItem: () => value }) as unknown as Storage;
    expect(readStoredSidebarMode(undefined)).toBe('expanded');
    expect(readStoredSidebarMode(make(null))).toBe('expanded');
    expect(readStoredSidebarMode(make('nope'))).toBe('expanded');
    expect(readStoredSidebarMode(make('collapsed'))).toBe('collapsed');
  });
});

describe('sessions board column order', () => {
  it('accepts any permutation of the four column ids', () => {
    expect(normalizeBoardOrder([...DEFAULT_BOARD_ORDER])).toEqual([...DEFAULT_BOARD_ORDER]);
    expect(normalizeBoardOrder(['working', 'idle', 'needs-you', 'starting']))
      .toEqual(['working', 'idle', 'needs-you', 'starting']);
  });

  it('rejects missing, extra, duplicated, or unknown columns', () => {
    expect(normalizeBoardOrder(['needs-you', 'starting', 'working'])).toBeNull();
    expect(normalizeBoardOrder([...DEFAULT_BOARD_ORDER, 'closed'])).toBeNull();
    expect(normalizeBoardOrder(['needs-you', 'needs-you', 'working', 'idle'])).toBeNull();
    expect(normalizeBoardOrder(['a', 'b', 'c', 'd'])).toBeNull();
    expect(normalizeBoardOrder('needs-you,starting,working,idle')).toBeNull();
    expect(normalizeBoardOrder(null)).toBeNull();
  });

  it('returns a copy, not the caller array', () => {
    const input = [...DEFAULT_BOARD_ORDER];
    const out = normalizeBoardOrder(input)!;
    expect(out).not.toBe(input);
  });
});

describe('session title mention stripping', () => {
  it('strips a leading @bot mention', () => {
    expect(stripMentionPrefix('@claude-loopy 看看之前的工作')).toBe('看看之前的工作');
    expect(stripMentionPrefix('@哈基米 测试')).toBe('测试');
  });

  it('strips multiple consecutive leading mentions only', () => {
    expect(stripMentionPrefix('@a @b 正文 @c 保留')).toBe('正文 @c 保留');
  });

  it('keeps titles without mentions and falls back on mention-only titles', () => {
    expect(stripMentionPrefix('comfyui 是什么')).toBe('comfyui 是什么');
    expect(stripMentionPrefix('@claude-loopy')).toBe('@claude-loopy');
    expect(stripMentionPrefix(undefined)).toBe('');
  });
});
