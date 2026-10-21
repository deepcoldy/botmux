import { confirm } from './confirm-modal.js';

// A page holding unsaved edits registers a guard; the shell asks it before a
// hash navigation tears the page down. With no guard registered (every page
// but the ones that opt in) navigation behaves exactly as before.

export interface LeavePrompt {
  title: string;
  message: string;
  confirmLabel?: string;
}

type LeaveGuard = () => LeavePrompt | null;

let guard: LeaveGuard | null = null;
// The hash the user already agreed to leave for: its own hashchange must pass.
let approvedTarget: string | null = null;

export function setLeaveGuard(next: LeaveGuard): () => void {
  guard = next;
  return () => { if (guard === next) guard = null; };
}

export function pendingLeavePrompt(): LeavePrompt | null {
  return guard?.() ?? null;
}

/**
 * Call from the hashchange handler before routing. Returns true when the
 * navigation was held back: the URL is put back to `from` (replaceState fires
 * no hashchange) and the page stays mounted; on confirmation the shell is sent
 * to `to` again and that second hashchange is let through.
 */
export function holdHashNavigation(from: string, to: string): boolean {
  if (approvedTarget === to) {
    approvedTarget = null;
    return false;
  }
  const prompt = pendingLeavePrompt();
  if (!prompt) return false;
  history.replaceState(history.state, '', from);
  void confirm({ ...prompt, danger: true }).then(ok => {
    // Replay only from the page the prompt was about; if the URL moved on
    // meanwhile (e.g. browser back), that navigation is the one that counts.
    if (!ok || (location.hash || '#/') !== from) return;
    approvedTarget = to;
    location.hash = to;
  });
  return true;
}

function pagePath(hash: string): string {
  const query = hash.indexOf('?');
  return query < 0 ? hash : hash.slice(0, query);
}

/**
 * The shell's hashchange handler. `applyLocale` handles the desktop shell's
 * locale rewrite (an in-place re-render, no routing); `route` mounts the page
 * for the new hash.
 */
export function createHashChangeHandler(deps: { applyLocale(): boolean; route(): void }): () => void {
  // The hash the mounted page belongs to.
  let routedHash = location.hash || '#/';
  return () => {
    const target = location.hash || '#/';
    // A locale flag rewritten onto the same page keeps that page mounted, so it
    // now owns this hash too; leaving it later must still go through the guard.
    // A locale change that also switches page is not routed (as before), so the
    // mounted page keeps its old hash.
    if (deps.applyLocale()) {
      if (pagePath(target) === pagePath(routedHash)) routedHash = target;
      return;
    }
    if (target !== routedHash && holdHashNavigation(routedHash, target)) return;
    routedHash = target;
    deps.route();
  };
}
