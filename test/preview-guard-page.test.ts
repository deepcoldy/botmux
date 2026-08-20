import { createServer, type IncomingMessage, type Server } from 'node:http';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_CONTENT_SEGMENT } from '../src/core/session-preview.js';
import {
  projectWorkbenchOperationCapabilities,
  type WorkbenchCapabilityActor,
} from '../src/dashboard/auth.js';
import {
  createPreviewGuardPage,
  previewGuardHtml,
} from '../src/dashboard/preview-guard-page.js';
import { PREVIEW_SANDBOX_TOKENS } from '../src/dashboard/preview-proxy.js';
import {
  PREVIEW_DEFAULT_MODE_LABEL,
  PREVIEW_INTERACTIVE_MODE_LABEL,
  PREVIEW_OVERLAY_SECURITY_NOTICE,
} from '../src/dashboard/preview-interaction.js';

const CAPABILITY = 'bmxpv1.capability-payload.capability-signature';
let server: Server | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

interface StartOptions {
  authenticated?: boolean;
  mintable?: boolean;
  /** 用真实的能力投影回答「这个身份能不能解锁」，请求头 `x-test-role` 选身份。 */
  canInteract?(req: IncomingMessage): boolean;
}

/** 六类身份里与 Preview 有关的三种真实形状（与 request-identity.ts 一致）。 */
const IDENTITIES: Record<string, WorkbenchCapabilityActor> = {
  owner: { kind: 'legacy-dashboard', terminalCapability: 'controlled', previewCapability: 'operate' },
  h5: { kind: 'feishu-h5', terminalCapability: 'controlled', previewCapability: 'operate' },
  teammate: { kind: 'platform-dashboard', terminalCapability: 'readonly', previewCapability: 'readonly' },
  guest: { kind: 'platform-dashboard', terminalCapability: 'readonly', previewCapability: 'readonly' },
};

async function start(options: StartOptions = {}): Promise<string> {
  const authenticated = options.authenticated ?? true;
  const mintable = options.mintable ?? true;
  const guard = createPreviewGuardPage({
    authenticated: () => authenticated,
    resolve: sessionId => sessionId === 's1'
      ? { ok: true, target: { host: '127.0.0.1', port: 3000, registeredAt: '2026-08-11T12:00:00.000Z' } }
      : { ok: false, status: 404, error: 'unknown_session' },
    mintContentCapability: () => (mintable
      ? { token: CAPABILITY, expiresAt: Date.now() + 60_000 }
      : null),
    canInteract: options.canInteract ?? (() => true),
  });
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dashboard.test');
    if (!guard.handle(req, res, url)) { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

// ─── 真实壳脚本执行器 ────────────────────────────────────────────────────────
//
// 下面这些用例跑的是**页面里真正下发的那段脚本**：从渲染出的 HTML 里取出
// `<script>` 原文，在 vm 里配上一套受控的 DOM/fetch/timer 执行。断言的是它在真实
// 时序（响应乱序到达、用户点击穿插）下对蒙层做了什么，而不是源码里有没有某个字符
// 串——把 `send(...)` 换个写法但竞态还在，这些用例照样红。

interface FakeElement {
  id: string;
  classes: Set<string>;
  classList: {
    add(name: string): void;
    remove(name: string): void;
    toggle(name: string, force?: boolean): void;
    contains(name: string): boolean;
  };
  textContent: string;
  attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, handler: (event?: unknown) => void): void;
  dispatch(type: string): void;
}

function fakeElement(id: string, initialClasses: string): FakeElement {
  const classes = new Set(initialClasses.split(/\s+/).filter(Boolean));
  const listeners = new Map<string, Array<(event?: unknown) => void>>();
  return {
    id,
    classes,
    classList: {
      add: name => { classes.add(name); },
      remove: name => { classes.delete(name); },
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : force;
        if (on) classes.add(name); else classes.delete(name);
      },
      contains: name => classes.has(name),
    },
    textContent: '',
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    addEventListener(type, handler) {
      const bucket = listeners.get(type) ?? [];
      bucket.push(handler);
      listeners.set(type, bucket);
    },
    dispatch(type) { for (const handler of listeners.get(type) ?? []) handler({ type }); },
  };
}

/** 按渲染出的标记建元素表：HTML 里没有的 id（只读身份的 unlock/lock）就是 null，
 *  和浏览器里 `getElementById` 的行为一致。 */
function parseElements(html: string): Map<string, FakeElement> {
  const markup = html.slice(0, html.indexOf('<script>'));
  const elements = new Map<string, FakeElement>();
  for (const match of markup.matchAll(/<[a-zA-Z]+\s([^>]*)>/g)) {
    const attrs = match[1];
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    if (!id) continue;
    elements.set(id, fakeElement(id, /\bclass="([^"]*)"/.exec(attrs)?.[1] ?? ''));
  }
  return elements;
}

interface ShellRequest {
  path: string;
  method: string;
  csrf: string | undefined;
  aborted: boolean;
  respond(body: unknown): void;
  fail(): void;
}

interface ShellState {
  mode: 'preview' | 'interactive';
  label: string;
  securityNotice: string;
  idleExpiresAt?: number;
}

const interactiveState = (): ShellState => ({
  mode: 'interactive',
  label: PREVIEW_INTERACTIVE_MODE_LABEL,
  securityNotice: PREVIEW_OVERLAY_SECURITY_NOTICE,
  idleExpiresAt: Date.now() + 15 * 60_000,
});

const previewState = (): ShellState => ({
  mode: 'preview',
  label: PREVIEW_DEFAULT_MODE_LABEL,
  securityNotice: PREVIEW_OVERLAY_SECURITY_NOTICE,
});

interface MountedShell {
  requests: ShellRequest[];
  last(): ShellRequest;
  element(id: string): FakeElement | null;
  overlayLocked(): boolean;
  badge(): string;
  click(id: string): void;
  pointerDown(): void;
  focusLeavesIntoPreview(): void;
  poll(): void;
  flush(): Promise<void>;
}

function mountGuardShell(html: string): MountedShell {
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('guard shell has no inline script');
  const elements = parseElements(html);
  const requests: ShellRequest[] = [];
  const documentListeners = new Map<string, Array<(event?: unknown) => void>>();
  const windowListeners = new Map<string, Array<(event?: unknown) => void>>();
  const intervals: Array<() => void> = [];
  const timeouts = new Map<number, () => void>();
  let nextTimer = 1;

  const listen = (bucket: Map<string, Array<(event?: unknown) => void>>) =>
    (type: string, handler: (event?: unknown) => void) => {
      const list = bucket.get(type) ?? [];
      list.push(handler);
      bucket.set(type, list);
    };

  const documentStub = {
    hidden: false,
    activeElement: null as FakeElement | null,
    getElementById: (id: string) => elements.get(id) ?? null,
    addEventListener: listen(documentListeners),
  };
  const windowStub = { addEventListener: listen(windowListeners) };

  const context = {
    document: documentStub,
    window: windowStub,
    location: { reload: () => { /* 只在 capability 到期前触发，本用例不跑到那 */ } },
    AbortController,
    fetch: (url: string, init: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }) => {
      const entry: ShellRequest = {
        path: url,
        method: init?.method ?? 'GET',
        csrf: init?.headers?.['x-botmux-csrf'],
        aborted: false,
        respond: () => { /* replaced below */ },
        fail: () => { /* replaced below */ },
      };
      init?.signal?.addEventListener('abort', () => { entry.aborted = true; });
      const promise = new Promise<{ ok: boolean; json(): Promise<unknown> }>((resolve, reject) => {
        entry.respond = body => resolve({ ok: true, json: async () => body });
        entry.fail = () => reject(new Error('network'));
      });
      requests.push(entry);
      return promise;
    },
    setTimeout: (fn: () => void, _delay?: number) => {
      const id = nextTimer++;
      timeouts.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => { timeouts.delete(id); },
    setInterval: (fn: () => void, _delay?: number) => {
      intervals.push(fn);
      return nextTimer++;
    },
    clearInterval: () => { /* 壳不清自己的轮询 */ },
  };
  runInNewContext(script, context);

  const overlay = elements.get('overlay');
  if (!overlay) throw new Error('guard shell has no overlay');
  return {
    requests,
    last: () => requests[requests.length - 1],
    element: id => elements.get(id) ?? null,
    overlayLocked: () => !overlay.classes.has('hidden'),
    badge: () => elements.get('badge')?.textContent ?? '',
    click: id => elements.get(id)?.dispatch('click'),
    pointerDown: () => { for (const fn of documentListeners.get('pointerdown') ?? []) fn({ type: 'pointerdown' }); },
    focusLeavesIntoPreview: () => {
      documentStub.activeElement = elements.get('app') ?? null;
      for (const fn of windowListeners.get('blur') ?? []) fn({ type: 'blur' });
    },
    poll: () => { for (const fn of [...intervals]) fn(); },
    flush: () => new Promise<void>(resolve => setImmediate(resolve)),
  };
}

function render(canInteract: boolean, csrfToken: string | null = 'csrf-ticket'): string {
  return previewGuardHtml(
    's1',
    { token: CAPABILITY, expiresAt: Date.now() + 600_000 },
    { canInteract, csrfToken },
  );
}

describe('guarded web preview shell', () => {
  it('renders the app in visibly labelled preview mode with explicit unlock and exact safety copy', () => {
    const html = render(true);
    expect(html).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect(html).toContain(PREVIEW_OVERLAY_SECURITY_NOTICE);
    expect(html).toContain('解锁交互（15 分钟无操作后回锁）');
    expect(html).toContain(`/preview/s1/${PREVIEW_CONTENT_SEGMENT}/${CAPABILITY}/`);
    expect(html).toContain('/api/sessions/s1/preview-interaction');
    expect(html).not.toMatch(/[?&](?:t|token|viewToken)=/);
  });

  it('drives the real interaction endpoints: 首次 GET → 解锁 → 活动续期 → 锁定', async () => {
    const shell = mountGuardShell(render(true));
    expect(shell.overlayLocked()).toBe(true);
    expect(shell.last()).toMatchObject({
      path: '/api/sessions/s1/preview-interaction',
      method: 'GET',
      csrf: 'csrf-ticket',
    });

    shell.last().respond(previewState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);
    expect(shell.badge()).toBe(PREVIEW_DEFAULT_MODE_LABEL);

    shell.click('unlock');
    expect(shell.last()).toMatchObject({
      path: '/api/sessions/s1/preview-interaction/unlock',
      method: 'POST',
      csrf: 'csrf-ticket',
    });
    shell.last().respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);
    expect(shell.badge()).toBe(PREVIEW_INTERACTIVE_MODE_LABEL);
    expect(shell.element('lock')?.classes.has('hidden')).toBe(false);

    // 焦点落进预览 iframe 是宿主侧唯一可观测的活动信号（框内是 opaque origin）。
    shell.focusLeavesIntoPreview();
    expect(shell.last()).toMatchObject({
      path: '/api/sessions/s1/preview-interaction/activity',
      method: 'POST',
    });
    shell.last().respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);

    shell.click('lock');
    expect(shell.last()).toMatchObject({ path: '/api/sessions/s1/preview-interaction/lock', method: 'POST' });
    shell.last().respond(previewState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);
    expect(shell.element('lock')?.classes.has('hidden')).toBe(true);
  });

  it('P1-16：显式锁定后，在途的旧 activity 响应迟到也掀不开蒙层', async () => {
    const shell = mountGuardShell(render(true));
    shell.last().respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);

    // ① 用户在预览里点了一下 → activity 上路，服务端还没回。
    shell.pointerDown();
    const staleActivity = shell.last();
    expect(staleActivity.path).toBe('/api/sessions/s1/preview-interaction/activity');

    // ② 用户改主意，点「返回预览模式」。
    shell.click('lock');
    const lockRequest = shell.last();
    expect(lockRequest.path).toBe('/api/sessions/s1/preview-interaction/lock');
    // 锁定这一步先落地：请求还没回，蒙层已经盖上（只会更严）。
    expect(shell.overlayLocked()).toBe(true);
    // 在途的 activity 被显式作废。
    expect(staleActivity.aborted).toBe(true);

    lockRequest.respond(previewState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);

    // ③ 早已在网线上的那份 activity 响应现在才落地——abort 拦不住已经收到的响应，
    //    generation 必须把它丢掉，否则蒙层被掀开直到下一轮 15s 轮询才自愈。
    staleActivity.respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);
    expect(shell.badge()).toBe(PREVIEW_DEFAULT_MODE_LABEL);
  });

  it('P1-16：显式锁定后，在途的旧轮询 GET 迟到同样被丢弃', async () => {
    const shell = mountGuardShell(render(true));
    shell.last().respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);

    // 15s 轮询发出，还没回。
    shell.poll();
    const stalePoll = shell.last();
    expect(stalePoll).toMatchObject({ path: '/api/sessions/s1/preview-interaction', method: 'GET' });

    shell.click('lock');
    const lockRequest = shell.last();
    lockRequest.respond(previewState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);

    stalePoll.respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);

    // 锁定在途期间的轮询不许抢跑：它只可能带回点击之前的状态。
    shell.click('lock');
    const pendingLock = shell.last();
    const before = shell.requests.length;
    shell.poll();
    expect(shell.requests.length).toBe(before);
    pendingLock.respond(previewState());
    await shell.flush();
    // 锁定落地后轮询恢复。
    shell.poll();
    expect(shell.requests.length).toBe(before + 1);
  });

  it('P1-16：解锁同样是权威决定，先发的轮询迟到也覆盖不了它', async () => {
    const shell = mountGuardShell(render(true));
    shell.last().respond(previewState());
    await shell.flush();

    shell.poll();
    const stalePoll = shell.last();

    shell.click('unlock');
    const unlockRequest = shell.last();
    expect(unlockRequest.path).toBe('/api/sessions/s1/preview-interaction/unlock');
    unlockRequest.respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);

    // 解锁之前发出的轮询回了「preview」，不能把刚解锁的壳又锁回去（同一竞态的反向）。
    stalePoll.respond(previewState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);
    expect(shell.badge()).toBe(PREVIEW_INTERACTIVE_MODE_LABEL);
  });

  it('请求失败仍然 fail closed，但被作废的旧请求失败不许反过来改状态', async () => {
    const shell = mountGuardShell(render(true));
    shell.last().respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);

    shell.poll();
    const stalePoll = shell.last();
    shell.click('unlock');
    const unlockRequest = shell.last();
    unlockRequest.respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);

    // 被 abort 的旧轮询以 AbortError 收场，不能被当成「状态拿不到 → 锁死」。
    stalePoll.fail();
    await shell.flush();
    expect(shell.overlayLocked()).toBe(false);

    // 而当前这一代请求失败时，照旧 fail closed。
    shell.poll();
    shell.last().fail();
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);
    expect(shell.badge()).toBe(PREVIEW_DEFAULT_MODE_LABEL);
  });

  it('P2：只读身份的壳没有解锁入口，状态说 interactive 也掀不开蒙层', async () => {
    const html = render(false);
    expect(html).toContain('data-can-interact="false"');
    expect(html).not.toContain('id="unlock"');
    expect(html).not.toContain('id="lock"');
    expect(html).not.toContain('解锁交互（15 分钟无操作后回锁）');
    expect(html).not.toContain('返回预览模式');
    // 只读不等于看不见：预览本体、说明与安全提示都照常。
    expect(html).toContain(`/preview/s1/${PREVIEW_CONTENT_SEGMENT}/${CAPABILITY}/`);
    expect(html).toContain(PREVIEW_OVERLAY_SECURITY_NOTICE);
    expect(html).toContain('只读身份');

    const shell = mountGuardShell(html);
    expect(shell.element('unlock')).toBeNull();
    expect(shell.element('lock')).toBeNull();
    expect(shell.overlayLocked()).toBe(true);

    // 服务端就算回了 interactive（旧租约、串号、投影漂移），只读壳也停在锁定态。
    shell.last().respond(interactiveState());
    await shell.flush();
    expect(shell.overlayLocked()).toBe(true);

    // 没有交互态 → 不会再有 activity 这类必然 403 的 POST。
    const before = shell.requests.length;
    shell.pointerDown();
    shell.focusLeavesIntoPreview();
    expect(shell.requests.length).toBe(before);
  });

  it('P2：可交互身份的壳保留解锁入口（能力为真时不误伤）', async () => {
    const shell = mountGuardShell(render(true));
    expect(shell.element('unlock')).not.toBeNull();
    shell.last().respond(previewState());
    await shell.flush();
    shell.click('unlock');
    expect(shell.last().path).toBe('/api/sessions/s1/preview-interaction/unlock');
  });

  it('P0: frames the agent app as an opaque origin and never reaches into its document', () => {
    const html = render(true);
    const iframe = html.match(/<iframe[^>]*id="app"[^>]*>/)?.[0] ?? '';
    expect(iframe).toContain(`sandbox="${PREVIEW_SANDBOX_TOKENS}"`);
    // The single flag that would undo the whole boundary: with it the framed
    // agent page is back on the dashboard origin and can read the DOM, call
    // /api/* with the owner cookie and open a debug terminal.
    expect(iframe).not.toContain('allow-same-origin');
    expect(html).not.toContain('allow-same-origin');
    expect(PREVIEW_SANDBOX_TOKENS.split(' ')).not.toContain('allow-same-origin');
    // No shell code may depend on same-origin access to the frame.
    expect(html).not.toContain('contentWindow');
    expect(html).not.toContain('contentDocument');
    // Idle refresh now rides on a host-side focus signal instead.
    expect(html).toContain("window.addEventListener('blur'");
    expect(html).toContain('document.activeElement===frame');
  });

  it('re-mints before the content capability expires instead of dying silently', () => {
    const now = 1_760_000_000_000;
    const html = previewGuardHtml(
      's1',
      { token: CAPABILITY, expiresAt: now + 600_000 },
      { now, canInteract: true },
    );
    expect(html).toContain('if(570000>0)setTimeout(function(){location.reload()},570000)');

    const expiring = previewGuardHtml(
      's1',
      { token: CAPABILITY, expiresAt: now + 1_000 },
      { now, canInteract: true },
    );
    expect(expiring).toContain('if(0>0)');
  });

  it('serves only an authenticated exact descriptor root; unauthorized users get no app shell', async () => {
    const deniedBase = await start({ authenticated: false });
    const denied = await fetch(`${deniedBase}/preview/s1/`);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ ok: false, error: 'authentication_required' });
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = null;

    const allowedBase = await start();
    const allowed = await fetch(`${allowedBase}/preview/s1/`);
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('content-security-policy')).toContain('https://*.feishu.cn');
    expect(allowed.headers.get('content-security-policy')).toContain('https://*.larksuite.com');
    const body = await allowed.text();
    expect(body).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect(body).toContain(`sandbox="${PREVIEW_SANDBOX_TOKENS}"`);
    const noSlash = await fetch(`${allowedBase}/preview/s1`);
    expect(noSlash.status).toBe(200);
    expect(await noSlash.text()).toContain(PREVIEW_DEFAULT_MODE_LABEL);
    expect((await fetch(`${allowedBase}/preview/unknown/`)).status).toBe(404);
    // The sandboxed content stream lives under the reserved segment and is
    // left entirely to the hardened preview proxy mounted immediately after.
    expect((await fetch(`${allowedBase}/preview/s1/${PREVIEW_CONTENT_SEGMENT}/${CAPABILITY}/`)).status).toBe(404);
  });

  it('P2：解锁入口按真实能力投影渲染——只读 teammate/guest 拿不到按钮，owner/H5 照常', async () => {
    // 用的是工作台按钮同一份投影，不是给壳单独写一张权限表。
    const base = await start({
      canInteract: req => projectWorkbenchOperationCapabilities(
        IDENTITIES[String(req.headers['x-test-role'] ?? 'owner')] ?? null,
      ).canInteract,
    });
    const shellFor = async (role: string): Promise<string> => {
      const response = await fetch(`${base}/preview/s1/`, { headers: { 'x-test-role': role } });
      expect(response.status).toBe(200);
      return response.text();
    };

    for (const role of ['teammate', 'guest']) {
      const html = await shellFor(role);
      expect(html, role).toContain('data-can-interact="false"');
      expect(html, role).not.toContain('id="unlock"');
      expect(html, role).not.toContain('解锁交互（15 分钟无操作后回锁）');
      // 预览本体仍然给：只读身份该看得到页面。
      expect(html, role).toContain(`/preview/s1/${PREVIEW_CONTENT_SEGMENT}/`);
    }
    for (const role of ['owner', 'h5']) {
      const html = await shellFor(role);
      expect(html, role).toContain('data-can-interact="true"');
      expect(html, role).toContain('id="unlock"');
    }
  });

  it('fails closed when no content capability can be minted', async () => {
    const base = await start({ mintable: false });
    const response = await fetch(`${base}/preview/s1/`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'preview_capability_unavailable' });
  });
});
