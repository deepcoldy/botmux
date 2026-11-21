import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useClosedHistorySearch } from '../src/dashboard/web/closed-history-search.js';

type Searches = NonNullable<Parameters<typeof useClosedHistorySearch>[1]>;
function Probe(props: { query: string; searches: Searches }) {
  useClosedHistorySearch(props.query, props.searches);
  return null;
}
let renderer: TestRenderer.ReactTestRenderer | undefined;
beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => {
  act(() => renderer?.unmount()); renderer = undefined;
  vi.useRealTimers(); vi.unstubAllGlobals();
});

describe('shared metadata and content search debounce', () => {
  it('issues both lookups at the same pause and cancels the previous input timer', async () => {
    const searches = { searchClosedSessions: vi.fn<(query: string) => Promise<void>>().mockResolvedValue(undefined),
      searchContent: vi.fn<(query: string) => Promise<void>>().mockResolvedValue(undefined) };
    act(() => { renderer = TestRenderer.create(createElement(Probe, { query: 'old', searches })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(searches.searchClosedSessions).not.toHaveBeenCalled(); expect(searches.searchContent).not.toHaveBeenCalled();
    act(() => { renderer?.update(createElement(Probe, { query: 'new', searches })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(searches.searchContent).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(searches.searchClosedSessions).toHaveBeenCalledExactlyOnceWith('new');
    expect(searches.searchContent).toHaveBeenCalledExactlyOnceWith('new','default');
    act(() => { renderer?.update(createElement(Probe, { query: '', searches })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(searches.searchContent).toHaveBeenCalledTimes(1);
  });

  it('silently ignores a failed lookup without suppressing the other one', async () => {
    const searches = { searchClosedSessions: vi.fn<(query: string) => Promise<void>>().mockRejectedValue(new Error('offline')),
      searchContent: vi.fn<(query: string) => Promise<void>>().mockResolvedValue(undefined) };
    act(() => { renderer = TestRenderer.create(createElement(Probe, { query: 'needle', searches })); });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(searches.searchContent).toHaveBeenCalledExactlyOnceWith('needle','default');
    expect(searches.searchClosedSessions).toHaveBeenCalledExactlyOnceWith('needle');
  });
});
