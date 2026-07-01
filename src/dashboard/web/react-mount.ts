import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

export type PageDisposer = () => void;

export function mountReactPage(root: HTMLElement, node: ReactNode): PageDisposer {
  const reactRoot = createRoot(root);
  reactRoot.render(node);
  return () => reactRoot.unmount();
}
