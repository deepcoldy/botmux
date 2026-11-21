import type { ReactNode } from 'react';
import { previewMarkdownHtml } from './preview-markdown.js';

function elementView(element: any, index: number): ReactNode {
  if (element.tag === 'column_set') return <div key={index} style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>{element.columns?.map(elementView)}</div>;
  if (element.tag === 'column' || element.tag === 'form' || (!element.tag && element.elements)) return <div key={index} style={{ flex: '1 1 auto' }}>{element.elements?.map(elementView)}</div>;
  if (element.tag === 'button') return <button key={index} type="button" disabled={element.disabled} style={{
    margin: 4, display: element.width === 'fill' ? 'block' : undefined, width: element.width === 'fill' ? '100%' : undefined,
    color: element.type === 'danger' ? '#c22' : undefined,
  }}>{element.text?.content}</button>;
  if (element.tag === 'input') return <textarea key={index} placeholder={element.placeholder?.content} rows={element.rows ?? 3} />;
  if (element.tag === 'markdown') return <div key={index} style={{ margin: '8px 0' }} dangerouslySetInnerHTML={{ __html: previewMarkdownHtml(element.content) }} />;
  return <div key={index} role="alert">不支持的预览组件：{String(element.tag)}</div>;
}
export function FeedbackTemplatePreview(props: { card: any; width: number }) {
  const colors: Record<string, string> = { blue: '#e7efff', green: '#e4f5e6', red: '#ffe5e5', orange: '#fff0da',
    purple: '#f2e7ff', grey: '#eeeeee', indigo: '#e8e7ff', turquoise: '#dcf7f5' };
  return <div aria-label="反馈卡片渲染预览" style={{ width: props.width, maxWidth: '100%', border: '1px solid #bbb', borderRadius: 8, overflow: 'hidden' }}>
    <div style={{ padding: 12, background: colors[props.card.header?.template] ?? colors.blue }}>{props.card.header?.title?.content}</div>
    <div style={{ padding: props.card.body?.padding ?? 12 }}>{props.card.body?.elements?.map(elementView)}</div>
  </div>;
}
