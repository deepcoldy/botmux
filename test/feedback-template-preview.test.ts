import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedbackTemplatePreview } from '../src/dashboard/web/feedback-template-preview.js';

describe('feedback preview browser projection', () => {
  it('renders native card structure as visible layout rather than a JSON dump', () => {
    const card = { header: { title: { content: 'Example title' }, template: 'blue' }, body: { elements: [
      { tag: 'column_set', columns: [{ elements: [{ tag: 'button', text: { content: 'Helpful' }, type: 'primary' }] }] },
      { tag: 'markdown', content: 'Visible example' },
    ] } };
    const html = renderToStaticMarkup(createElement(FeedbackTemplatePreview, { card, width: 320 }));
    expect(html).toContain('Example title');
    expect(html).toContain('Helpful');
    expect(html).toContain('Visible example');
    expect(html).toContain('<button');
    expect(html).not.toContain('&quot;columns&quot;');
  });
});
