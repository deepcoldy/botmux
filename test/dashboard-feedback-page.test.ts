import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

describe('feedback analytics dashboard page', () => {
  it('is navigable, localized, styled, and only presents redacted delivery fields', () => {
    const app = readFileSync(new URL('../src/dashboard/web/app.tsx', import.meta.url), 'utf8');
    const page = readFileSync(new URL('../src/dashboard/web/feedback-page.tsx', import.meta.url), 'utf8');
    const css = readFileSync(new URL('../src/dashboard/web/style.css', import.meta.url), 'utf8');
    expect(app).toContain("id: 'feedback'");
    expect(app).toContain("href: '#/feedback'");
    expect(createDashboardTranslator('zh')('feedback.title')).not.toBe('feedback.title');
    expect(createDashboardTranslator('en')('feedback.title')).not.toBe('feedback.title');
    expect(css).toContain('.feedback-kpis');
    expect(css).toContain('.feedback-bar');
    expect(page).not.toContain('commentText');
    expect(page).not.toContain('baseCard');
    expect(page).not.toContain('webhookSecret');
  });
});
