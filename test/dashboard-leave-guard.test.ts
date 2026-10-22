import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const confirmMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/dashboard/web/confirm-modal.js', () => ({ confirm: confirmMock }));

const { createHashChangeHandler, holdHashNavigation, navigateToHash, pendingLeavePrompt, setLeaveGuard } = await import('../src/dashboard/web/leave-guard.js');

const PROMPT = { title: 'Unsaved', message: 'Leave anyway?' };

describe('leave guard', () => {
  let release: (() => void) | undefined;
  const replaceState = vi.fn();
  const location = { hash: '#/message-listeners' };

  beforeEach(() => {
    confirmMock.mockReset();
    replaceState.mockReset();
    vi.stubGlobal('history', { state: null, replaceState });
    vi.stubGlobal('location', location);
  });
  afterEach(() => {
    release?.();
    release = undefined;
    vi.unstubAllGlobals();
  });

  it('lets navigation through when no page holds unsaved edits', () => {
    release = setLeaveGuard(() => null);
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(false);
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('puts the URL back and stays when the user keeps editing', async () => {
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValueOnce(false);
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(true);
    expect(replaceState).toHaveBeenCalledWith(null, '', '#/message-listeners');
    await Promise.resolve();
    expect(location.hash).toBe('#/message-listeners');
  });

  it('navigates on confirmation and lets that one hashchange pass', async () => {
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValueOnce(true);
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(true);
    await Promise.resolve();
    expect(location.hash).toBe('#/roles');
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(false);
    // Only once: a later navigation is held again while edits remain.
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(true);
  });

  it('does not replay a confirmed navigation once the URL has moved on', async () => {
    release = setLeaveGuard(() => PROMPT);
    let answer!: (ok: boolean) => void;
    confirmMock.mockImplementationOnce(() => new Promise<boolean>(resolve => { answer = resolve; }));
    expect(holdHashNavigation('#/message-listeners', '#/roles')).toBe(true);
    location.hash = '#/sessions'; // e.g. browser back while the dialog is open
    answer(true);
    await Promise.resolve();
    expect(location.hash).toBe('#/sessions');
  });

  it('drops the guard when its page unregisters', () => {
    const unregister = setLeaveGuard(() => PROMPT);
    expect(pendingLeavePrompt()).toEqual(PROMPT);
    unregister();
    expect(pendingLeavePrompt()).toBeNull();
  });
});

describe('shell hashchange handler', () => {
  let release: (() => void) | undefined;
  const location = { hash: '#/message-listeners' };
  const route = vi.fn();
  let localeRewrite = false;

  beforeEach(() => {
    confirmMock.mockReset();
    route.mockReset();
    localeRewrite = false;
    location.hash = '#/message-listeners';
    vi.stubGlobal('history', { state: null, replaceState: (_state: unknown, _title: string, url: string) => { location.hash = url; } });
    vi.stubGlobal('location', location);
  });
  afterEach(() => {
    release?.();
    release = undefined;
    vi.unstubAllGlobals();
  });

  const handler = () => createHashChangeHandler({ applyLocale: () => localeRewrite, route });

  it('routes every navigation while nothing is unsaved', () => {
    const onHashChange = handler();
    location.hash = '#/roles';
    onHashChange();
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('holds a navigation away from a page with unsaved edits', () => {
    const onHashChange = handler();
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValueOnce(false);
    location.hash = '#/roles';
    onHashChange();
    expect(route).not.toHaveBeenCalled();
    expect(location.hash).toBe('#/message-listeners');
  });

  it('keeps guarding after the desktop shell rewrites the locale in place', () => {
    const onHashChange = handler();
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValue(false);
    // Locale rewrite: re-rendered in place, not routed.
    localeRewrite = true;
    location.hash = '#/message-listeners?locale=en';
    onHashChange();
    expect(route).not.toHaveBeenCalled();
    // Clicking the current page's nav item afterwards would remount it.
    localeRewrite = false;
    location.hash = '#/message-listeners';
    onHashChange();
    expect(route).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the mounted page as the way back when a locale change also switched page', () => {
    const onHashChange = handler();
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValue(false);
    // Not routed (unchanged shell behavior): the listener page is still mounted.
    localeRewrite = true;
    location.hash = '#/roles?locale=en';
    onHashChange();
    expect(route).not.toHaveBeenCalled();
    localeRewrite = false;
    location.hash = '#/sessions';
    onHashChange();
    expect(location.hash).toBe('#/message-listeners');
  });
});

describe('in-app navigation (⌘K palette)', () => {
  let release: (() => void) | undefined;
  const dispatchEvent = vi.fn();
  const location = { hash: '#/message-listeners' };

  beforeEach(() => {
    confirmMock.mockReset();
    dispatchEvent.mockReset();
    location.hash = '#/message-listeners';
    vi.stubGlobal('location', location);
    vi.stubGlobal('window', { dispatchEvent });
    vi.stubGlobal('HashChangeEvent', class { constructor(readonly type: string) {} });
  });
  afterEach(() => {
    release?.();
    release = undefined;
    vi.unstubAllGlobals();
  });

  it('changes the hash for a different target and leaves guarding to the hashchange handler', () => {
    release = setLeaveGuard(() => PROMPT);
    navigateToHash('#/roles');
    expect(location.hash).toBe('#/roles');
    expect(confirmMock).not.toHaveBeenCalled();
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('replays the same hash right away when nothing is unsaved', () => {
    release = setLeaveGuard(() => null);
    navigateToHash('#/message-listeners');
    expect(dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'hashchange' }));
  });

  it('asks before replaying the same hash over unsaved edits (the shell handler does not guard same-hash events)', async () => {
    release = setLeaveGuard(() => PROMPT);
    confirmMock.mockResolvedValueOnce(false);
    navigateToHash('#/message-listeners');
    await Promise.resolve();
    expect(confirmMock).toHaveBeenCalledWith(expect.objectContaining({ title: 'Unsaved', danger: true }));
    expect(dispatchEvent).not.toHaveBeenCalled();

    confirmMock.mockResolvedValueOnce(true);
    navigateToHash('#/message-listeners');
    await Promise.resolve();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
  });
});
