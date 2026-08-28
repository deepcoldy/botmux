import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createConnection, type Socket } from 'node:net';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodexBrowserFamily } from '../core/codex-browser-config.js';

type Json = Record<string, any>;

export const CODEX_BROWSER_TOOL_NAME = 'botmux_browser';

export const CODEX_BROWSER_DYNAMIC_TOOL = {
  type: 'function',
  name: CODEX_BROWSER_TOOL_NAME,
  description: [
    'Control the user\'s explicitly configured Chrome or Edge browser through the installed Codex browser extension.',
    'Start with operation=list_tabs, then claim_tab before interacting with an existing user tab.',
    'Use snapshot to get fresh accessibility element indexes; never reuse indexes after an action.',
    'Supported operations: list_tabs, claim_tab, new_tab, selected_tab, tab_info, goto, snapshot, click, set_value, type_text, press_key, scroll, screenshot, reload, back, forward, mark_handoff, mark_deliverable, close_tab.',
    'This tool does not expose cookies, local storage, browsing history, arbitrary JavaScript, raw CDP, clipboard, or file transfer.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['operation'],
    properties: {
      operation: {
        type: 'string',
        enum: [
          'list_tabs', 'claim_tab', 'new_tab', 'selected_tab', 'tab_info',
          'goto', 'snapshot', 'click', 'set_value', 'type_text', 'press_key',
          'scroll', 'screenshot', 'reload', 'back', 'forward',
          'mark_handoff', 'mark_deliverable', 'close_tab',
        ],
      },
      tabId: { type: 'string', minLength: 1, maxLength: 256 },
      url: { type: 'string', minLength: 1, maxLength: 16_384 },
      elementIndex: { type: 'integer', minimum: 0 },
      value: { type: 'string', maxLength: 100_000 },
      key: { type: 'string', minLength: 1, maxLength: 256 },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      pages: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
      x: { type: 'number' },
      y: { type: 'number' },
      disableDiffing: { type: 'boolean' },
      fullPage: { type: 'boolean' },
    },
  },
} as const;

interface BrowserTab {
  id: string;
  back(): Promise<void>;
  close(): Promise<void>;
  forward(): Promise<void>;
  goto(url: string): Promise<void>;
  markDeliverable(): Promise<void>;
  markHandoff(): Promise<void>;
  reload(): Promise<void>;
  screenshot(opts?: { fullPage?: boolean }): Promise<Uint8Array>;
  title(): Promise<string | undefined>;
  url(): Promise<string | undefined>;
  ax: {
    click(index: number): Promise<void>;
    get(mode?: 'state', opts?: { disableDiffing?: boolean }): Promise<string>;
    pressKey(key: string): Promise<void>;
    scroll(target: number | [number, number], direction: 'up' | 'down' | 'left' | 'right', pages?: number): Promise<void>;
    setValue(index: number, value: string): Promise<void>;
    typeText(value: string): Promise<void>;
  };
}

interface BrowserBinding {
  browserId: string;
  nameSession(name: string): Promise<void>;
  tabs: {
    get(id: string): Promise<BrowserTab>;
    list(): Promise<Array<{ id: string }>>;
    'new'(): Promise<BrowserTab>;
    selected(): Promise<BrowserTab | undefined>;
  };
  user: {
    claimTab(tab: unknown): Promise<BrowserTab>;
    openTabs(): Promise<Array<{ id: string; title?: string; url?: string; lastOpened?: string }>>;
  };
}

interface BrowserAgent {
  browsers: { get(family: CodexBrowserFamily): Promise<BrowserBinding> };
}

interface BrowserPluginModules {
  setupBrowserRuntime(): Promise<BrowserAgent>;
  handleRpc(request: { method: string; params?: unknown }): Promise<unknown>;
}

export interface CodexBrowserBrokerOptions {
  sessionId: string;
  family: CodexBrowserFamily;
  pluginRoot?: string;
  /** Unit-test seam. Production always loads the installed Codex plugin. */
  modules?: BrowserPluginModules;
}

export interface DynamicToolCallParams {
  arguments: unknown;
  callId: string;
  namespace?: string | null;
  threadId: string;
  tool: string;
  turnId: string;
}

export interface DynamicToolCallResponse {
  contentItems: Array<
    | { type: 'inputText'; text: string }
    | { type: 'inputImage'; imageUrl: string }
  >;
  success: boolean;
}

const TOOL_TIMEOUT_MS = 45_000;
const MAX_TEXT_RESULT_BYTES = 512 * 1024;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

function requiredString(value: unknown, field: string, max = 100_000): string {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`${field} must be a non-empty string no larger than ${max} bytes`);
  }
  return value;
}

function requiredText(value: unknown, field: string, max = 100_000): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > max) {
    throw new Error(`${field} must be a string no larger than ${max} bytes`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function requiredFinite(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
  return value;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs = TOOL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`browser operation timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function textResult(value: unknown): DynamicToolCallResponse {
  let text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_RESULT_BYTES) {
    text = `${Buffer.from(text, 'utf8').subarray(0, MAX_TEXT_RESULT_BYTES).toString('utf8')}\n[truncated by Botmux]`;
  }
  return { contentItems: [{ type: 'inputText', text }], success: true };
}

function errorResult(error: unknown): DynamicToolCallResponse {
  const message = error instanceof Error ? error.message : String(error);
  return {
    contentItems: [{ type: 'inputText', text: `Browser operation failed: ${message}` }],
    success: false,
  };
}

export function resolveCodexBrowserPluginRoot(explicitRoot?: string): string {
  if (explicitRoot && !isAbsolute(explicitRoot)) {
    throw new Error('Codex browser plugin root must be absolute');
  }
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  const pluginCache = join(codexHome, 'plugins', 'cache', 'openai-bundled', 'chrome');
  const candidate = explicitRoot ? resolve(explicitRoot) : discoverPluginRoot(pluginCache);
  const root = realpathSync(candidate);
  for (const relative of ['scripts/browser-client.mjs', 'scripts/browser-service.mjs']) {
    if (!existsSync(join(root, relative))) {
      throw new Error(`Codex browser plugin is incomplete: missing ${relative} under ${root}`);
    }
  }
  return root;
}

function discoverPluginRoot(pluginCache: string): string {
  const latest = join(pluginCache, 'latest');
  if (isCompletePluginRoot(latest)) return latest;
  let entries: string[];
  try {
    entries = readdirSync(pluginCache, { withFileTypes: true })
      .filter(entry => entry.isDirectory() || entry.isSymbolicLink())
      .map(entry => entry.name);
  } catch {
    throw new Error(`Codex browser plugin is not installed under ${pluginCache}`);
  }
  const candidates = entries
    .map(name => join(pluginCache, name))
    .filter(isCompletePluginRoot)
    .sort((left, right) => compareVersionNames(right, left));
  if (!candidates[0]) throw new Error(`Codex browser plugin is not installed under ${pluginCache}`);
  return candidates[0];
}

function isCompletePluginRoot(root: string): boolean {
  return existsSync(join(root, 'scripts/browser-client.mjs'))
    && existsSync(join(root, 'scripts/browser-service.mjs'));
}

function compareVersionNames(left: string, right: string): number {
  const leftParts = basename(left).split('.').map(Number);
  const rightParts = basename(right).split('.').map(Number);
  for (let i = 0; i < Math.max(leftParts.length, rightParts.length); i++) {
    const delta = (leftParts[i] || 0) - (rightParts[i] || 0);
    if (delta) return delta;
  }
  return left.localeCompare(right);
}

async function connectNativePipe(path: string): Promise<Socket> {
  return new Promise<Socket>((resolveConnection, reject) => {
    const socket = createConnection(path);
    const onError = (error: Error): void => reject(error);
    socket.once('error', onError);
    socket.once('connect', () => {
      socket.off('error', onError);
      resolveConnection(socket);
    });
  });
}

async function loadBrowserPluginModules(root: string): Promise<BrowserPluginModules> {
  const service = await import(pathToFileURL(join(root, 'scripts/browser-service.mjs')).href) as {
    handleRpc(request: { method: string; params?: unknown }): Promise<unknown>;
  };
  const client = await import(pathToFileURL(join(root, 'scripts/browser-client.mjs')).href) as {
    setupBrowserRuntime(): Promise<BrowserAgent>;
  };
  return {
    handleRpc: service.handleRpc,
    setupBrowserRuntime: client.setupBrowserRuntime,
  };
}

/**
 * Per-runner bridge from Codex app-server dynamic tool calls to the installed
 * Codex browser plugin. It deliberately exposes typed operations rather than a
 * JavaScript REPL or raw browser protocol.
 */
export class CodexBrowserBroker {
  private browser?: BrowserBinding;
  private init?: Promise<BrowserBinding>;
  private readonly claimedTabs = new Map<string, BrowserTab>();
  private readonly configStore = new Map<string, Json>();
  private previousNodeRepl: unknown;
  private runtimeShim?: Json;

  constructor(private readonly opts: CodexBrowserBrokerOptions) {}

  async handleToolCall(params: DynamicToolCallParams): Promise<DynamicToolCallResponse> {
    if (params.tool !== CODEX_BROWSER_TOOL_NAME || params.namespace) {
      return errorResult(new Error(`unsupported dynamic tool: ${params.namespace ? `${params.namespace}.` : ''}${params.tool}`));
    }
    if (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)) {
      return errorResult(new Error('tool arguments must be an object'));
    }
    try {
      this.updateTurnMetadata(params.threadId, params.turnId);
      return await withTimeout(this.execute(params.arguments as Json));
    } catch (error) {
      return errorResult(error);
    }
  }

  private async execute(input: Json): Promise<DynamicToolCallResponse> {
    const operation = requiredString(input.operation, 'operation', 64);
    const browser = await this.getBrowser();
    if (operation === 'list_tabs') {
      return textResult({ browserFamily: this.opts.family, tabs: await browser.user.openTabs() });
    }
    if (operation === 'claim_tab') {
      const tabId = requiredString(input.tabId, 'tabId', 256);
      const info = (await browser.user.openTabs()).find(tab => tab.id === tabId);
      if (!info) throw new Error(`user tab is no longer available: ${tabId}`);
      const tab = await browser.user.claimTab(info);
      this.claimedTabs.set(tab.id, tab);
      this.claimedTabs.set(tabId, tab);
      return textResult(await this.describeTab(tab));
    }
    if (operation === 'new_tab') {
      const tab = await browser.tabs.new();
      this.claimedTabs.set(tab.id, tab);
      return textResult(await this.describeTab(tab));
    }
    if (operation === 'selected_tab') {
      const tab = await browser.tabs.selected();
      if (!tab) return textResult({ tab: null });
      this.claimedTabs.set(tab.id, tab);
      return textResult(await this.describeTab(tab));
    }

    const tab = await this.getTab(requiredString(input.tabId, 'tabId', 256));
    switch (operation) {
      case 'tab_info':
        return textResult(await this.describeTab(tab));
      case 'goto':
        await tab.goto(requiredString(input.url, 'url', 16_384));
        return textResult(await this.describeTab(tab));
      case 'snapshot':
        return textResult(await tab.ax.get('state', { disableDiffing: input.disableDiffing === true }));
      case 'click':
        await tab.ax.click(requiredInteger(input.elementIndex, 'elementIndex'));
        return textResult({ ok: true });
      case 'set_value':
        await tab.ax.setValue(
          requiredInteger(input.elementIndex, 'elementIndex'),
          requiredText(input.value, 'value'),
        );
        return textResult({ ok: true });
      case 'type_text':
        await tab.ax.typeText(requiredText(input.value, 'value'));
        return textResult({ ok: true });
      case 'press_key':
        await tab.ax.pressKey(requiredString(input.key, 'key', 256));
        return textResult({ ok: true });
      case 'scroll': {
        const direction = input.direction;
        if (!['up', 'down', 'left', 'right'].includes(direction)) {
          throw new Error('direction must be up, down, left, or right');
        }
        const target = input.elementIndex !== undefined
          ? requiredInteger(input.elementIndex, 'elementIndex')
          : [requiredFinite(input.x, 'x'), requiredFinite(input.y, 'y')] as [number, number];
        const pages = input.pages === undefined ? undefined : requiredFinite(input.pages, 'pages');
        if (pages !== undefined && (pages <= 0 || pages > 20)) throw new Error('pages must be > 0 and <= 20');
        await tab.ax.scroll(target, direction, pages);
        return textResult({ ok: true });
      }
      case 'screenshot': {
        const bytes = await tab.screenshot({ fullPage: input.fullPage === true });
        if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
          throw new Error(`screenshot exceeds ${MAX_SCREENSHOT_BYTES} bytes`);
        }
        return {
          contentItems: [{
            type: 'inputImage',
            imageUrl: `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`,
          }],
          success: true,
        };
      }
      case 'reload': await tab.reload(); return textResult({ ok: true });
      case 'back': await tab.back(); return textResult({ ok: true });
      case 'forward': await tab.forward(); return textResult({ ok: true });
      case 'mark_handoff': await tab.markHandoff(); return textResult({ ok: true });
      case 'mark_deliverable': await tab.markDeliverable(); return textResult({ ok: true });
      case 'close_tab':
        await tab.close();
        this.claimedTabs.delete(tab.id);
        return textResult({ ok: true });
      default:
        throw new Error(`unsupported browser operation: ${operation}`);
    }
  }

  private async getBrowser(): Promise<BrowserBinding> {
    if (this.browser) return this.browser;
    this.init ??= this.initialize();
    this.browser = await this.init;
    return this.browser;
  }

  private async initialize(): Promise<BrowserBinding> {
    const modules = this.opts.modules ?? await loadBrowserPluginModules(
      resolveCodexBrowserPluginRoot(this.opts.pluginRoot),
    );
    const nodeRepl = this.createRuntimeShim();
    this.previousNodeRepl = (globalThis as Json).nodeRepl;
    (globalThis as Json).nodeRepl = nodeRepl;
    nodeRepl.rpc = async (name: string, request: { method: string; params?: unknown }) => {
      if (name !== 'browser') throw new Error(`unsupported trusted service: ${name}`);
      return modules.handleRpc(request);
    };
    const agent = await modules.setupBrowserRuntime();
    const browser = await agent.browsers.get(this.opts.family);
    await browser.nameSession(`botmux-${this.opts.sessionId.slice(0, 12)}`).catch(() => {});
    return browser;
  }

  private createRuntimeShim(): Json {
    const requestMeta: Record<string, string> = {};
    const shim: Json = {
      env: { ...process.env },
      cwd: process.cwd(),
      homeDir: homedir(),
      tmpDir: tmpdir(),
      platform: platform(),
      requestMeta,
      nativePipe: { createConnection: connectNativePipe },
      config: {
        read: async () => ({}),
        readRequirements: async () => ({}),
        readToml: async (path: string) => this.configStore.get(path) ?? {},
        writeToml: async (path: string, value: Json) => { this.configStore.set(path, value); },
      },
      // Botmux does not yet project Codex browser approval forms into Lark.
      // Cancel instead of guessing or bypassing the plugin's safety policy.
      createElicitation: async () => ({ action: 'cancel' }),
      setResponseMeta: () => {},
      addAfterSubmittedCodeHook: () => {},
      emitContentItem: () => {},
      fetch: globalThis.fetch,
      emitImage: () => {},
      write: () => {},
      rpc: undefined,
    };
    this.runtimeShim = shim;
    this.updateTurnMetadata(this.opts.sessionId, 'startup');
    return shim;
  }

  private updateTurnMetadata(threadId: string, turnId: string): void {
    if (!this.runtimeShim) return;
    this.runtimeShim.requestMeta = {
      'x-codex-turn-metadata': JSON.stringify({
        session_id: this.opts.sessionId,
        thread_id: threadId,
        turn_id: turnId,
        thread_source: 'botmux',
      }),
    };
  }

  private async getTab(tabId: string): Promise<BrowserTab> {
    const claimed = this.claimedTabs.get(tabId);
    if (claimed) return claimed;
    const browser = await this.getBrowser();
    const tab = await browser.tabs.get(tabId);
    this.claimedTabs.set(tab.id, tab);
    return tab;
  }

  private async describeTab(tab: BrowserTab): Promise<{ id: string; title?: string; url?: string }> {
    const [title, url] = await Promise.all([tab.title(), tab.url()]);
    return { id: tab.id, ...(title ? { title } : {}), ...(url ? { url } : {}) };
  }

  /** Test/process cleanup; production runner teardown exits the process. */
  close(): void {
    if ((globalThis as Json).nodeRepl === this.runtimeShim) {
      if (this.previousNodeRepl === undefined) delete (globalThis as Json).nodeRepl;
      else (globalThis as Json).nodeRepl = this.previousNodeRepl;
    }
  }
}
