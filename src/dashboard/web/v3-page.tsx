import { mountReactPage, type PageDisposer } from './react-mount.js';
import { V3RunsPage } from './v3-components.js';

export function renderV3RunsPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <V3RunsPage />);
}
