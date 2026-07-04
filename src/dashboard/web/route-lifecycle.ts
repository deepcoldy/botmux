import type { DashboardRouteLoadResult } from './dashboard-routes.js';
import type { PageDisposer } from './react-mount.js';

export interface DashboardRouteState {
  seq: number;
  pageDispose: PageDisposer | null;
  rerenderOnUiChange: boolean;
}

export function createDashboardRouteState(): DashboardRouteState {
  return { seq: 0, pageDispose: null, rerenderOnUiChange: true };
}

export function beginDashboardRoute(state: DashboardRouteState): number {
  const seq = ++state.seq;
  if (state.pageDispose) {
    state.pageDispose();
    state.pageDispose = null;
  }
  return seq;
}

export function isDashboardRouteCurrent(state: DashboardRouteState, seq: number): boolean {
  return seq === state.seq;
}

export async function loadAndRenderDashboardRoute(
  state: DashboardRouteState,
  seq: number,
  root: HTMLElement,
  load: () => DashboardRouteLoadResult,
  options: { rerenderOnUiChange?: boolean } = {},
): Promise<boolean> {
  const render = await load();
  if (!isDashboardRouteCurrent(state, seq)) return false;
  const dispose = render(root);
  if (!isDashboardRouteCurrent(state, seq)) {
    if (typeof dispose === 'function') dispose();
    return false;
  }
  state.pageDispose = typeof dispose === 'function' ? dispose : null;
  state.rerenderOnUiChange = options.rerenderOnUiChange ?? true;
  return true;
}
