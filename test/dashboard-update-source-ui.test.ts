import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UpdateBadge } from '../src/dashboard/web/settings-page.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { ui } from '../src/dashboard/web/ui.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function render(status: Record<string, unknown>, locale: 'zh' | 'en' = 'zh'): string {
  vi.spyOn(ui, 't').mockImplementation(createDashboardTranslator(locale));
  return renderToStaticMarkup(createElement(UpdateBadge, {
    status: {
      current: '3.47.0',
      latest: '3.47.0',
      latestSource: 'public',
      behind: false,
      ...status,
    } as any,
  }));
}

describe('Dashboard update source labels', () => {
  it('does not claim global latest when only the configured mirror answered', () => {
    expect(render({ latestSource: 'configured-fallback' }))
      .toContain('已是当前镜像源最新版（公共源暂不可用）');
    expect(render({ latestSource: 'configured-fallback' }))
      .not.toContain('已是最新版本');
  });

  it('labels an available mirror version without hiding the public-source outage', () => {
    expect(render({
      latest: '3.48.0',
      latestSource: 'configured-fallback',
      behind: true,
    })).toContain('镜像源可更新至 v3.48.0（公共源暂不可用）');
  });

  it('keeps the normal labels for an authoritative public result', () => {
    expect(render({})).toContain('已是最新版本');
    expect(render({ latest: '3.48.0', behind: true }))
      .toContain('发现新版本 v3.48.0');
  });

  it('renders the same fallback distinction in English', () => {
    expect(render({ latestSource: 'configured-fallback' }, 'en'))
      .toContain('Up to date on the configured mirror');
  });
});
