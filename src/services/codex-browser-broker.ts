import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createConnection, type Socket } from 'node:net';
import { homedir, platform, tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { findMissingAskEnv } from '../core/ask-args.js';
import type { CodexBrowserFamily } from '../core/codex-browser-config.js';
import { CodexBrowserAuthenticatedFetch } from './codex-browser-authenticated-fetch.js';

type Json = Record<string, any>;

export const CODEX_BROWSER_TOOL_NAME = 'botmux_browser';

export const CODEX_BROWSER_DYNAMIC_TOOL = {
  type: 'function',
  name: CODEX_BROWSER_TOOL_NAME,
  description: [
    'Control the user\'s explicitly configured Chrome or Edge browser through the installed Codex browser extension.',
    'Start with operation=list_tabs, then claim_tab before interacting with an existing user tab.',
    'Call capabilities after claiming a tab. Prefer snapshot and accessibility actions; snapshot automatically falls back to DOM when AX is unavailable.',
    'For stable selectors or frontend testing, use locator_* operations. Use DOM or coordinate operations only when AX and locators are unsuitable.',
    'For locator_upload, target the visible upload button or label that opens the chooser; use locator_count and locator_is_visible to disambiguate, and do not pick an arbitrary hidden input[type=file].',
    'Browser security prompts are projected to a blocking Lark confirmation card and require an authorized human decision.',
    'This tool does not expose cookies, local storage, browsing history, arbitrary JavaScript, raw CDP, or clipboard.',
  ].join(' '),
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['operation'],
    properties: {
      operation: {
        type: 'string',
        enum: [
          'capabilities', 'list_tabs', 'claim_tab', 'new_tab', 'selected_tab', 'tab_info',
          'goto', 'snapshot', 'click', 'set_value', 'type_text', 'press_key',
          'scroll', 'select_text', 'secondary_action', 'drag',
          'dom_snapshot', 'dom_click', 'dom_double_click', 'dom_type', 'dom_keypress', 'dom_scroll',
          'coordinate_click', 'coordinate_double_click', 'coordinate_move', 'coordinate_drag',
          'coordinate_type', 'coordinate_keypress', 'coordinate_scroll',
          'locator_count', 'locator_text', 'locator_all_text', 'locator_click',
          'locator_double_click', 'locator_fill', 'locator_type', 'locator_press',
          'locator_check', 'locator_uncheck', 'locator_set_checked', 'locator_select_option',
          'locator_wait', 'locator_is_visible', 'locator_is_enabled', 'locator_attribute',
          'locator_download', 'locator_upload',
          'wait_for_load_state', 'wait_for_url', 'wait',
          'dialog_info', 'dialog_accept', 'dialog_dismiss',
          'screenshot', 'reload', 'back', 'forward',
          'mark_handoff', 'mark_deliverable', 'close_tab',
        ],
      },
      tabId: { type: 'string', minLength: 1, maxLength: 256 },
      url: { type: 'string', minLength: 1, maxLength: 16_384 },
      elementIndex: { type: 'integer', minimum: 0 },
      value: { type: 'string', maxLength: 100_000 },
      text: { type: 'string', maxLength: 100_000 },
      key: { type: 'string', minLength: 1, maxLength: 256 },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
      pages: { type: 'number', exclusiveMinimum: 0, maximum: 20 },
      x: { type: 'number' },
      y: { type: 'number' },
      x2: { type: 'number' },
      y2: { type: 'number' },
      deltaX: { type: 'number' },
      deltaY: { type: 'number' },
      nodeId: { type: 'string', minLength: 1, maxLength: 256 },
      locatorType: { type: 'string', enum: ['selector', 'role', 'text', 'label', 'placeholder', 'test_id'] },
      selector: { type: 'string', minLength: 1, maxLength: 16_384 },
      frameSelector: { type: 'string', minLength: 1, maxLength: 16_384 },
      role: { type: 'string', minLength: 1, maxLength: 256 },
      name: { type: 'string', maxLength: 10_000 },
      exact: { type: 'boolean' },
      pick: { type: 'string', enum: ['first', 'last', 'nth'] },
      nth: { type: 'integer', minimum: 0, maximum: 100_000 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 60_000 },
      attribute: { type: 'string', minLength: 1, maxLength: 512 },
      checked: { type: 'boolean' },
      values: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'string', maxLength: 10_000 } },
      files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 16_384 } },
      state: { type: 'string', enum: ['attached', 'detached', 'visible', 'hidden', 'load', 'domcontentloaded', 'networkidle'] },
      waitUntil: { type: 'string', enum: ['load', 'domcontentloaded', 'networkidle', 'commit'] },
      button: { type: 'string', enum: ['left', 'right', 'middle'] },
      modifiers: { type: 'array', maxItems: 4, items: { type: 'string', enum: ['Alt', 'Control', 'ControlOrMeta', 'Meta', 'Shift'] } },
      prefix: { type: 'string', maxLength: 10_000 },
      suffix: { type: 'string', maxLength: 10_000 },
      selectionType: { type: 'string', enum: ['text', 'cursor_before', 'cursor_after'] },
      secondaryAction: { type: 'string', minLength: 1, maxLength: 256 },
      disableDiffing: { type: 'boolean' },
      fullPage: { type: 'boolean' },
    },
  },
} as const;

interface BrowserAX {
  click(target: number | [number, number], opts?: { mouseButton?: 'left' | 'right' }): Promise<void>;
  drag(from: [number, number], to: [number, number]): Promise<void>;
  get(mode?: 'state', opts?: { disableDiffing?: boolean }): Promise<string>;
  performSecondaryAction(elementIndex: number, action: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(target: number | [number, number], direction: 'up' | 'down' | 'left' | 'right', pages?: number): Promise<void>;
  selectText(
    elementIndex: number,
    text: string,
    opts?: { prefix?: string; selectionType?: 'text' | 'cursor_before' | 'cursor_after'; suffix?: string },
  ): Promise<void>;
  setValue(index: number, value: string): Promise<void>;
  typeText(value: string): Promise<void>;
}

interface BrowserLocator {
  allTextContents(opts: { timeoutMs?: number }): Promise<string[]>;
  check(opts: { timeoutMs?: number }): Promise<void>;
  click(opts: { button?: 'left' | 'right' | 'middle'; modifiers?: string[]; timeoutMs?: number }): Promise<void>;
  count(): Promise<number>;
  dblclick(opts: { button?: 'left' | 'right' | 'middle'; modifiers?: string[]; timeoutMs?: number }): Promise<void>;
  fill(value: string, opts: { timeoutMs?: number }): Promise<void>;
  first(): BrowserLocator;
  getAttribute(name: string, opts: { timeoutMs?: number }): Promise<string | null>;
  innerText(opts: { timeoutMs?: number }): Promise<string>;
  isEnabled(): Promise<boolean>;
  isVisible(): Promise<boolean>;
  last(): BrowserLocator;
  nth(index: number): BrowserLocator;
  press(value: string, opts: { timeoutMs?: number }): Promise<void>;
  selectOption(value: string | string[], opts: { timeoutMs?: number }): Promise<void>;
  setChecked(checked: boolean, opts: { timeoutMs?: number }): Promise<void>;
  textContent(opts: { timeoutMs?: number }): Promise<string | null>;
  type(value: string, opts: { timeoutMs?: number }): Promise<void>;
  uncheck(opts: { timeoutMs?: number }): Promise<void>;
  waitFor(opts: { state: 'attached' | 'detached' | 'visible' | 'hidden'; timeoutMs?: number }): Promise<void>;
}

interface BrowserLocatorFactory {
  getByLabel(text: string, opts: { exact?: boolean }): BrowserLocator;
  getByPlaceholder(text: string, opts: { exact?: boolean }): BrowserLocator;
  getByRole(role: string, opts: { exact?: boolean; name?: string }): BrowserLocator;
  getByTestId(testId: string): BrowserLocator;
  getByText(text: string, opts: { exact?: boolean }): BrowserLocator;
  locator(selector: string): BrowserLocator;
}

interface BrowserPlaywright extends BrowserLocatorFactory {
  domSnapshot(): Promise<string>;
  frameLocator(frameSelector: string): BrowserLocatorFactory;
  waitForEvent(event: 'download', opts?: { timeoutMs?: number }): Promise<{
    path(opts: { timeoutMs?: number }): Promise<string | null>;
  }>;
  waitForEvent(event: 'filechooser', opts?: { timeoutMs?: number }): Promise<{
    isMultiple(): boolean;
    setFiles(files: string | string[], opts: { timeoutMs?: number }): Promise<void>;
  }>;
  waitForLoadState(opts: { state?: 'load' | 'domcontentloaded' | 'networkidle'; timeoutMs?: number }): Promise<void>;
  waitForTimeout(timeoutMs: number): Promise<void>;
  waitForURL(url: string, opts: {
    timeoutMs?: number;
    waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit';
  }): Promise<void>;
}

interface BrowserDomCua {
  click(opts: { node_id: string }): Promise<void>;
  double_click(opts: { node_id: string }): Promise<void>;
  get_visible_dom(): Promise<unknown>;
  keypress(opts: { keys: string[] }): Promise<void>;
  scroll(opts: { node_id?: string; x: number; y: number }): Promise<void>;
  type(opts: { text: string }): Promise<void>;
}

interface BrowserCua {
  click(opts: { button?: number; keypress?: string[]; x: number; y: number }): Promise<void>;
  double_click(opts: { keypress?: string[]; x: number; y: number }): Promise<void>;
  drag(opts: { keys?: string[]; path: Array<{ x: number; y: number }> }): Promise<void>;
  keypress(opts: { keys: string[] }): Promise<void>;
  move(opts: { keys?: string[]; x: number; y: number }): Promise<void>;
  scroll(opts: { keypress?: string[]; scrollX: number; scrollY: number; x: number; y: number }): Promise<void>;
  type(opts: { text: string }): Promise<void>;
}

interface BrowserDialog {
  type: 'alert' | 'beforeunload' | 'confirm' | 'prompt';
  accept?: (text?: string) => Promise<void>;
  dismiss(): Promise<void>;
}

interface BrowserCapabilityCollection {
  list(): Promise<unknown[]>;
}

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
  getJsDialog?(): Promise<BrowserDialog | undefined>;
  capabilities?: BrowserCapabilityCollection;
  ax?: BrowserAX;
  playwright?: BrowserPlaywright;
  dom_cua?: BrowserDomCua;
  cua?: BrowserCua;
}

interface BrowserBinding {
  browserId: string;
  capabilities?: BrowserCapabilityCollection;
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
  codexBin?: string;
  family: CodexBrowserFamily;
  pluginRoot?: string;
  /** Unit-test seam. Production always loads the installed Codex plugin. */
  modules?: BrowserPluginModules;
  /** Unit-test seam. Production projects browser safety decisions into Lark. */
  requestApproval?: BrowserApprovalHandler;
  /** Security inputs from the same Codex app-server that owns this runner. */
  readConfig?: (params: { cwd: string; includeLayers: boolean }) => Promise<Json>;
  readConfigRequirements?: () => Promise<Json>;
}

export interface BrowserElicitationRequest {
  message?: unknown;
  meta?: Json;
  _meta?: Json;
  requestedSchema?: unknown;
}

export interface BrowserElicitationResponse {
  action: 'accept' | 'decline' | 'cancel';
  meta?: Json;
}

export type BrowserApprovalHandler = (
  request: BrowserElicitationRequest,
) => Promise<BrowserElicitationResponse>;

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

const TOOL_TIMEOUT_MS = 660_000;
const MAX_TEXT_RESULT_BYTES = 512 * 1024;
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_FILE_CHOOSER_TIMEOUT_MS = 10_000;
const execFileAsync = promisify(execFile);

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

function optionalString(value: unknown, field: string, max = 100_000): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, field, max);
}

function requiredStringArray(value: unknown, field: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw new Error(`${field} must be a non-empty string array with at most ${maxItems} items`);
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`, 16_384));
}

function optionalStringArray(value: unknown, field: string, maxItems = 100): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${field} must be a string array with at most ${maxItems} items`);
  }
  return value.map((item, index) => requiredString(item, `${field}[${index}]`, 16_384));
}

function operationTimeout(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const timeoutMs = requiredInteger(value, 'timeoutMs');
  if (timeoutMs < 1 || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be between 1 and ${MAX_OPERATION_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function requireCapability<T>(value: T | undefined, name: string): T {
  if (!value) {
    throw new Error(
      `${name} is unavailable for this browser/tab; call capabilities and use an advertised fallback`,
    );
  }
  return value;
}

function asMeta(request: BrowserElicitationRequest): Json {
  return request.meta && typeof request.meta === 'object'
    ? request.meta
    : request._meta && typeof request._meta === 'object'
      ? request._meta
      : {};
}

function displayApprovalRequest(request: BrowserElicitationRequest): string {
  const meta = asMeta(request);
  const message = typeof request.message === 'string' ? request.message : '浏览器请求执行受保护操作';
  const tool = typeof meta.tool_title === 'string'
    ? meta.tool_title
    : typeof meta.tool_name === 'string' ? meta.tool_name : undefined;
  const origin = typeof meta.origin === 'string' ? meta.origin : undefined;
  const risk = typeof meta.risk_level === 'string'
    ? meta.risk_level
    : typeof meta.riskLevel === 'string' ? meta.riskLevel : undefined;
  return [
    'BotMux 浏览器安全确认',
    message,
    tool ? `操作：${tool}` : undefined,
    origin ? `站点：${origin}` : undefined,
    risk ? `风险级别：${risk}` : undefined,
    '请选择授权范围；拒绝或超时将取消操作。授权记录由 Browser Use 安全策略管理。',
  ].filter(Boolean).join('\n').slice(0, 4_000);
}

function approvalOptions(meta: Json): string {
  const persist = Array.isArray(meta.persist) ? meta.persist : [meta.persist];
  if (persist.includes('session') || persist.includes('always')) {
    return 'session=本会话允许,always=始终允许,decline=拒绝';
  }
  return 'approve=允许,decline=拒绝';
}

function sessionApprovalKey(request: BrowserElicitationRequest): string | undefined {
  const meta = asMeta(request);
  if (meta.codex_approval_kind === 'browser_auth') return undefined;

  const persist = Array.isArray(meta.persist) ? meta.persist : [meta.persist];
  if (!persist.includes('session') && !persist.includes('always')) return undefined;

  const origin = typeof meta.origin === 'string' ? meta.origin.trim() : undefined;
  const tool = typeof meta.tool_name === 'string'
    ? meta.tool_name.trim()
    : typeof meta.file_transfer === 'string' ? meta.file_transfer.trim() : undefined;
  if (!origin || !tool) return undefined;

  return JSON.stringify({
    kind: typeof meta.codex_approval_kind === 'string' ? meta.codex_approval_kind : 'browser',
    origin,
    risk: typeof meta.risk_level === 'string'
      ? meta.risk_level
      : typeof meta.riskLevel === 'string' ? meta.riskLevel : undefined,
    tool,
  });
}

async function requestLarkBrowserApproval(
  request: BrowserElicitationRequest,
): Promise<BrowserElicitationResponse> {
  const meta = asMeta(request);
  if (meta.codex_approval_kind === 'browser_auth') {
    // Authentication elicitations may contain secrets and require the Codex
    // secure challenge broker. An ordinary Lark card must never impersonate it.
    return { action: 'cancel' };
  }
  if (findMissingAskEnv(process.env) !== null) {
    return { action: 'cancel' };
  }
  try {
    const { stdout } = await execFileAsync('botmux', [
      'ask',
      'buttons',
      '--json',
      '--timeout',
      '600',
      '--options',
      approvalOptions(meta),
      displayApprovalRequest(request),
    ], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 610_000,
      windowsHide: true,
    });
    const answer = JSON.parse(stdout) as { selected?: unknown; by?: unknown; timedOut?: unknown };
    if (answer.selected === 'approve' || answer.selected === 'session' || answer.selected === 'always') {
      return {
        action: 'accept',
        meta: {
          approval_channel: 'lark',
          approved_by: typeof answer.by === 'string' ? answer.by : 'authorized_user',
          // A plain "允许" is intentionally a session grant. This keeps the
          // common one-click flow useful without turning it into a persistent
          // browser permission. The explicit "始终允许" option remains the
          // only path that asks the browser plugin for durable permission.
          persist: answer.selected === 'always' ? 'always' : 'session',
        },
      };
    }
    if (answer.selected === 'decline') return { action: 'decline' };
    return { action: 'cancel' };
  } catch {
    return { action: 'cancel' };
  }
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
  private readonly sessionApprovals = new Set<string>();
  private readonly pendingApprovals = new Map<string, Promise<BrowserElicitationResponse>>();
  private previousNodeRepl: unknown;
  private runtimeShim?: Json;
  private authenticatedFetch?: CodexBrowserAuthenticatedFetch;

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
      case 'capabilities':
        return textResult(await this.describeCapabilities(browser, tab));
      case 'tab_info':
        return textResult(await this.describeTab(tab));
      case 'goto':
        await tab.goto(requiredString(input.url, 'url', 16_384));
        return textResult(await this.describeTab(tab));
      case 'snapshot':
        return this.snapshot(tab, input.disableDiffing === true);
      case 'click':
        await requireCapability(tab.ax, 'accessibility').click(requiredInteger(input.elementIndex, 'elementIndex'));
        return textResult({ ok: true });
      case 'set_value':
        await requireCapability(tab.ax, 'accessibility').setValue(
          requiredInteger(input.elementIndex, 'elementIndex'),
          requiredText(input.value, 'value'),
        );
        return textResult({ ok: true });
      case 'type_text':
        await requireCapability(tab.ax, 'accessibility').typeText(requiredText(input.value, 'value'));
        return textResult({ ok: true });
      case 'press_key':
        await requireCapability(tab.ax, 'accessibility').pressKey(requiredString(input.key, 'key', 256));
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
        await requireCapability(tab.ax, 'accessibility').scroll(target, direction, pages);
        return textResult({ ok: true });
      }
      case 'select_text':
        await requireCapability(tab.ax, 'accessibility').selectText(
          requiredInteger(input.elementIndex, 'elementIndex'),
          requiredText(input.value, 'value'),
          {
            prefix: optionalString(input.prefix, 'prefix', 10_000),
            suffix: optionalString(input.suffix, 'suffix', 10_000),
            selectionType: input.selectionType,
          },
        );
        return textResult({ ok: true });
      case 'secondary_action':
        await requireCapability(tab.ax, 'accessibility').performSecondaryAction(
          requiredInteger(input.elementIndex, 'elementIndex'),
          requiredString(input.secondaryAction, 'secondaryAction', 256),
        );
        return textResult({ ok: true });
      case 'drag':
        await requireCapability(tab.ax, 'accessibility').drag(
          [requiredFinite(input.x, 'x'), requiredFinite(input.y, 'y')],
          [requiredFinite(input.x2, 'x2'), requiredFinite(input.y2, 'y2')],
        );
        return textResult({ ok: true });
      case 'dom_snapshot':
        return textResult(await requireCapability(tab.dom_cua, 'DOM CUA').get_visible_dom());
      case 'dom_click':
        await requireCapability(tab.dom_cua, 'DOM CUA').click({
          node_id: requiredString(input.nodeId, 'nodeId', 256),
        });
        return textResult({ ok: true });
      case 'dom_double_click':
        await requireCapability(tab.dom_cua, 'DOM CUA').double_click({
          node_id: requiredString(input.nodeId, 'nodeId', 256),
        });
        return textResult({ ok: true });
      case 'dom_type':
        await requireCapability(tab.dom_cua, 'DOM CUA').type({ text: requiredText(input.value, 'value') });
        return textResult({ ok: true });
      case 'dom_keypress':
        await requireCapability(tab.dom_cua, 'DOM CUA').keypress({ keys: this.keys(input) });
        return textResult({ ok: true });
      case 'dom_scroll':
        await requireCapability(tab.dom_cua, 'DOM CUA').scroll({
          ...(input.nodeId === undefined ? {} : { node_id: requiredString(input.nodeId, 'nodeId', 256) }),
          x: requiredFinite(input.deltaX, 'deltaX'),
          y: requiredFinite(input.deltaY, 'deltaY'),
        });
        return textResult({ ok: true });
      case 'coordinate_click':
        await requireCapability(tab.cua, 'coordinate CUA').click({
          x: requiredFinite(input.x, 'x'),
          y: requiredFinite(input.y, 'y'),
          button: this.coordinateButton(input.button),
          keypress: optionalStringArray(input.modifiers, 'modifiers', 4),
        });
        return textResult({ ok: true });
      case 'coordinate_double_click':
        await requireCapability(tab.cua, 'coordinate CUA').double_click({
          x: requiredFinite(input.x, 'x'),
          y: requiredFinite(input.y, 'y'),
          keypress: optionalStringArray(input.modifiers, 'modifiers', 4),
        });
        return textResult({ ok: true });
      case 'coordinate_move':
        await requireCapability(tab.cua, 'coordinate CUA').move({
          x: requiredFinite(input.x, 'x'),
          y: requiredFinite(input.y, 'y'),
          keys: optionalStringArray(input.modifiers, 'modifiers', 4),
        });
        return textResult({ ok: true });
      case 'coordinate_drag':
        await requireCapability(tab.cua, 'coordinate CUA').drag({
          path: [
            { x: requiredFinite(input.x, 'x'), y: requiredFinite(input.y, 'y') },
            { x: requiredFinite(input.x2, 'x2'), y: requiredFinite(input.y2, 'y2') },
          ],
          keys: optionalStringArray(input.modifiers, 'modifiers', 4),
        });
        return textResult({ ok: true });
      case 'coordinate_type':
        await requireCapability(tab.cua, 'coordinate CUA').type({ text: requiredText(input.value, 'value') });
        return textResult({ ok: true });
      case 'coordinate_keypress':
        await requireCapability(tab.cua, 'coordinate CUA').keypress({ keys: this.keys(input) });
        return textResult({ ok: true });
      case 'coordinate_scroll':
        await requireCapability(tab.cua, 'coordinate CUA').scroll({
          x: requiredFinite(input.x, 'x'),
          y: requiredFinite(input.y, 'y'),
          scrollX: requiredFinite(input.deltaX, 'deltaX'),
          scrollY: requiredFinite(input.deltaY, 'deltaY'),
          keypress: optionalStringArray(input.modifiers, 'modifiers', 4),
        });
        return textResult({ ok: true });
      case 'locator_count':
        return textResult({ count: await this.locator(tab, input).count() });
      case 'locator_text': {
        const timeoutMs = operationTimeout(input.timeoutMs);
        const locator = this.locator(tab, input);
        return textResult({
          innerText: await locator.innerText({ timeoutMs }),
          textContent: await locator.textContent({ timeoutMs }),
        });
      }
      case 'locator_all_text':
        return textResult(await this.locator(tab, input).allTextContents({
          timeoutMs: operationTimeout(input.timeoutMs),
        }));
      case 'locator_click':
        await this.locator(tab, input).click(this.locatorClickOptions(input));
        return textResult({ ok: true });
      case 'locator_double_click':
        await this.locator(tab, input).dblclick(this.locatorClickOptions(input));
        return textResult({ ok: true });
      case 'locator_fill':
        await this.locator(tab, input).fill(requiredText(input.value, 'value'), {
          timeoutMs: operationTimeout(input.timeoutMs),
        });
        return textResult({ ok: true });
      case 'locator_type':
        await this.locator(tab, input).type(requiredText(input.value, 'value'), {
          timeoutMs: operationTimeout(input.timeoutMs),
        });
        return textResult({ ok: true });
      case 'locator_press':
        await this.locator(tab, input).press(requiredString(input.key, 'key', 256), {
          timeoutMs: operationTimeout(input.timeoutMs),
        });
        return textResult({ ok: true });
      case 'locator_check':
        await this.locator(tab, input).check({ timeoutMs: operationTimeout(input.timeoutMs) });
        return textResult({ ok: true });
      case 'locator_uncheck':
        await this.locator(tab, input).uncheck({ timeoutMs: operationTimeout(input.timeoutMs) });
        return textResult({ ok: true });
      case 'locator_set_checked':
        if (typeof input.checked !== 'boolean') throw new Error('checked must be a boolean');
        await this.locator(tab, input).setChecked(input.checked, {
          timeoutMs: operationTimeout(input.timeoutMs),
        });
        return textResult({ ok: true });
      case 'locator_select_option': {
        const values = requiredStringArray(input.values, 'values');
        await this.locator(tab, input).selectOption(values.length === 1 ? values[0]! : values, {
          timeoutMs: operationTimeout(input.timeoutMs),
        });
        return textResult({ ok: true });
      }
      case 'locator_wait': {
        const state = input.state;
        if (!['attached', 'detached', 'visible', 'hidden'].includes(state)) {
          throw new Error('state must be attached, detached, visible, or hidden');
        }
        await this.locator(tab, input).waitFor({ state, timeoutMs: operationTimeout(input.timeoutMs) });
        return textResult({ ok: true });
      }
      case 'locator_is_visible':
        return textResult({ visible: await this.locator(tab, input).isVisible() });
      case 'locator_is_enabled':
        return textResult({ enabled: await this.locator(tab, input).isEnabled() });
      case 'locator_attribute':
        return textResult({
          value: await this.locator(tab, input).getAttribute(
            requiredString(input.attribute, 'attribute', 512),
            { timeoutMs: operationTimeout(input.timeoutMs) },
          ),
        });
      case 'locator_download':
        return textResult({ path: await this.locatorDownload(tab, input) });
      case 'locator_upload':
        await this.locatorUpload(tab, input);
        return textResult({ ok: true });
      case 'wait_for_load_state': {
        const state = input.state;
        if (state !== undefined && !['load', 'domcontentloaded', 'networkidle'].includes(state)) {
          throw new Error('state must be load, domcontentloaded, or networkidle');
        }
        await requireCapability(tab.playwright, 'Playwright').waitForLoadState({
          state,
          timeoutMs: operationTimeout(input.timeoutMs),
        });
        return textResult({ ok: true });
      }
      case 'wait_for_url': {
        const waitUntil = input.waitUntil;
        if (waitUntil !== undefined && !['load', 'domcontentloaded', 'networkidle', 'commit'].includes(waitUntil)) {
          throw new Error('waitUntil must be load, domcontentloaded, networkidle, or commit');
        }
        await requireCapability(tab.playwright, 'Playwright').waitForURL(
          requiredString(input.url, 'url', 16_384),
          { waitUntil, timeoutMs: operationTimeout(input.timeoutMs) },
        );
        return textResult({ ok: true });
      }
      case 'wait': {
        const timeoutMs = operationTimeout(input.timeoutMs);
        if (timeoutMs === undefined) throw new Error('timeoutMs is required');
        await requireCapability(tab.playwright, 'Playwright').waitForTimeout(timeoutMs);
        return textResult({ ok: true });
      }
      case 'dialog_info': {
        const dialog = await requireCapability(tab.getJsDialog, 'JavaScript dialog').call(tab);
        return textResult(dialog ? { type: dialog.type } : { dialog: null });
      }
      case 'dialog_accept': {
        const dialog = await requireCapability(tab.getJsDialog, 'JavaScript dialog').call(tab);
        if (!dialog) throw new Error('there is no active JavaScript dialog');
        if (!dialog.accept) throw new Error(`${dialog.type} dialog cannot be accepted`);
        await dialog.accept(dialog.type === 'prompt' ? requiredText(input.value, 'value') : undefined);
        return textResult({ ok: true });
      }
      case 'dialog_dismiss': {
        const dialog = await requireCapability(tab.getJsDialog, 'JavaScript dialog').call(tab);
        if (!dialog) throw new Error('there is no active JavaScript dialog');
        await dialog.dismiss();
        return textResult({ ok: true });
      }
      case 'screenshot': {
        return this.screenshot(tab, input.fullPage === true);
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

  private async snapshot(tab: BrowserTab, disableDiffing: boolean): Promise<DynamicToolCallResponse> {
    if (tab.ax?.get) {
      return textResult(await tab.ax.get('state', { disableDiffing }));
    }
    if (tab.dom_cua?.get_visible_dom) {
      return textResult({ representation: 'visible_dom', snapshot: await tab.dom_cua.get_visible_dom() });
    }
    if (tab.playwright?.domSnapshot) {
      return textResult({ representation: 'playwright_dom', snapshot: await tab.playwright.domSnapshot() });
    }
    return this.screenshot(tab, false);
  }

  private async screenshot(tab: BrowserTab, fullPage: boolean): Promise<DynamicToolCallResponse> {
    const bytes = await tab.screenshot({ fullPage });
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

  private async describeCapabilities(browser: BrowserBinding, tab: BrowserTab): Promise<Json> {
    return {
      browserFamily: this.opts.family,
      browserId: browser.browserId,
      tabId: tab.id,
      core: {
        navigation: typeof tab.goto === 'function',
        screenshot: typeof tab.screenshot === 'function',
        dialogs: typeof tab.getJsDialog === 'function',
        markHandoff: typeof tab.markHandoff === 'function',
        markDeliverable: typeof tab.markDeliverable === 'function',
      },
      interaction: {
        accessibility: !!tab.ax,
        playwright: !!tab.playwright,
        domCua: !!tab.dom_cua,
        coordinateCua: !!tab.cua,
      },
      advertised: {
        browser: await this.capabilityIds(browser.capabilities),
        tab: await this.capabilityIds(tab.capabilities),
      },
      restrictedByBotmux: [
        'arbitrary JavaScript',
        'raw CDP',
        'cookies and local storage',
        'browser history',
        'clipboard',
        'secure credential collection',
      ],
    };
  }

  private async capabilityIds(collection: BrowserCapabilityCollection | undefined): Promise<Json> {
    if (!collection?.list) return { available: false, ids: [] };
    try {
      return { available: true, ids: await collection.list() };
    } catch (error) {
      return { available: true, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private locator(tab: BrowserTab, input: Json): BrowserLocator {
    const playwright = requireCapability(tab.playwright, 'Playwright');
    const factory = input.frameSelector === undefined
      ? playwright
      : playwright.frameLocator(requiredString(input.frameSelector, 'frameSelector', 16_384));
    const exact = input.exact === true;
    let locator: BrowserLocator;
    switch (input.locatorType ?? 'selector') {
      case 'selector':
        locator = factory.locator(requiredString(input.selector, 'selector', 16_384));
        break;
      case 'role':
        locator = factory.getByRole(requiredString(input.role, 'role', 256), {
          exact,
          name: optionalString(input.name, 'name', 10_000),
        });
        break;
      case 'text':
        locator = factory.getByText(this.locatorText(input), { exact });
        break;
      case 'label':
        locator = factory.getByLabel(this.locatorText(input), { exact });
        break;
      case 'placeholder':
        locator = factory.getByPlaceholder(this.locatorText(input), { exact });
        break;
      case 'test_id':
        locator = factory.getByTestId(this.locatorText(input));
        break;
      default:
        throw new Error('locatorType must be selector, role, text, label, placeholder, or test_id');
    }
    if (input.pick === 'first') return locator.first();
    if (input.pick === 'last') return locator.last();
    if (input.pick === 'nth') return locator.nth(requiredInteger(input.nth, 'nth'));
    if (input.pick !== undefined) throw new Error('pick must be first, last, or nth');
    return locator;
  }

  private locatorText(input: Json): string {
    return requiredString(input.text ?? input.value, 'text', 100_000);
  }

  private locatorClickOptions(input: Json): {
    button?: 'left' | 'right' | 'middle';
    modifiers?: string[];
    timeoutMs?: number;
  } {
    const button = input.button;
    if (button !== undefined && !['left', 'right', 'middle'].includes(button)) {
      throw new Error('button must be left, right, or middle');
    }
    return {
      button,
      modifiers: optionalStringArray(input.modifiers, 'modifiers', 4),
      timeoutMs: operationTimeout(input.timeoutMs),
    };
  }

  private keys(input: Json): string[] {
    const key = requiredString(input.key, 'key', 256);
    return [...(optionalStringArray(input.modifiers, 'modifiers', 4) ?? []), key];
  }

  private coordinateButton(value: unknown): number | undefined {
    if (value === undefined) return undefined;
    switch (value) {
      case 'left': return 1;
      case 'middle': return 2;
      case 'right': return 3;
      default: throw new Error('button must be left, right, or middle');
    }
  }

  private async locatorDownload(tab: BrowserTab, input: Json): Promise<string | null> {
    const playwright = requireCapability(tab.playwright, 'Playwright');
    const timeoutMs = operationTimeout(input.timeoutMs);
    const downloadPromise = playwright.waitForEvent('download', { timeoutMs });
    // Attach immediately: the waiter may reject before the click settles.
    void downloadPromise.catch(() => {});
    await this.locator(tab, input).click(this.locatorClickOptions(input));
    return (await downloadPromise).path({ timeoutMs });
  }

  private async locatorUpload(tab: BrowserTab, input: Json): Promise<void> {
    const playwright = requireCapability(tab.playwright, 'Playwright');
    // The browser plugin's implicit filechooser timeout is only a few seconds
    // in some installed versions. Uploads commonly need longer for a custom
    // input/label click to dispatch, so keep a safe explicit default while
    // still allowing callers to provide a bounded override.
    const timeoutMs = operationTimeout(input.timeoutMs) ?? DEFAULT_FILE_CHOOSER_TIMEOUT_MS;
    const files = requiredStringArray(input.files, 'files', 20);
    const locator = this.locator(tab, input);
    if (!await locator.isVisible()) {
      throw new Error(
        'upload locator is hidden; target the visible upload button or label that opens the file chooser instead of a hidden input[type=file]',
      );
    }
    const chooserPromise = playwright.waitForEvent('filechooser', { timeoutMs });
    void chooserPromise.catch(() => {});
    try {
      await locator.click({
        ...this.locatorClickOptions(input),
        timeoutMs,
      });
    } catch (error) {
      // A failed click leaves the plugin's waiter alive. Older browser plugin
      // builds reject that waiter later, which otherwise becomes an unhandled
      // rejection and can terminate the Codex App runner after the original
      // (useful) click error has already been returned.
      void chooserPromise.catch(() => {});
      throw error;
    }
    const chooser = await chooserPromise;
    if (!chooser.isMultiple() && files.length > 1) {
      throw new Error('the selected file input does not accept multiple files');
    }
    await chooser.setFiles(files.length === 1 ? files[0]! : files, { timeoutMs });
  }

  private async getBrowser(): Promise<BrowserBinding> {
    if (this.browser) return this.browser;
    const init = this.init ??= this.initialize();
    try {
      this.browser = await init;
      return this.browser;
    } catch (error) {
      // Extension/native-host availability can change after the first tool
      // call (for example when the user enables or reconnects the extension).
      // Do not permanently cache that transient discovery failure: the next
      // browser operation must perform a fresh discovery attempt.
      if (this.init === init) this.init = undefined;
      throw error;
    }
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

  private async requestBrowserApproval(
    request: BrowserElicitationRequest,
  ): Promise<BrowserElicitationResponse> {
    const key = sessionApprovalKey(request);
    if (key && this.sessionApprovals.has(key)) {
      return {
        action: 'accept',
        meta: {
          approval_channel: 'lark',
          approval_scope: 'session-cache',
          approved_by: 'authorized_user_session',
          persist: 'session',
        },
      };
    }

    const pending = key ? this.pendingApprovals.get(key) : undefined;
    if (pending) return pending;

    const handler = this.opts.requestApproval ?? requestLarkBrowserApproval;
    const approval = handler(request).then(response => {
      if (response.action !== 'accept' || !key) return response;
      this.sessionApprovals.add(key);
      return {
        ...response,
        meta: {
          ...(response.meta ?? {}),
          approval_scope: 'session-cache',
          // Preserve an explicit durable choice, otherwise make a normal
          // approval session-scoped for the browser plugin as well.
          persist: response.meta?.persist ?? 'session',
        },
      };
    });
    if (!key) return approval;

    this.pendingApprovals.set(key, approval);
    try {
      return await approval;
    } finally {
      if (this.pendingApprovals.get(key) === approval) this.pendingApprovals.delete(key);
    }
  }

  private createRuntimeShim(): Json {
    this.authenticatedFetch ??= new CodexBrowserAuthenticatedFetch({
      codexBin: this.opts.codexBin,
      readConfig: async () => {
        if (!this.opts.readConfig) throw new Error('Codex config reader is unavailable');
        return this.opts.readConfig({ cwd: process.cwd(), includeLayers: false });
      },
      requestMeta: () => this.runtimeShim?.requestMeta ?? {},
    });
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
        read: async (params?: { cwd?: unknown; includeLayers?: unknown }) => {
          if (!this.opts.readConfig) throw new Error('Codex config reader is unavailable');
          return this.opts.readConfig({
            cwd: typeof params?.cwd === 'string' ? params.cwd : process.cwd(),
            includeLayers: params?.includeLayers === true,
          });
        },
        readRequirements: async () => {
          if (!this.opts.readConfigRequirements) {
            throw new Error('Codex config requirements reader is unavailable');
          }
          return this.opts.readConfigRequirements();
        },
        readToml: async (path: string) => this.configStore.get(path) ?? {},
        writeToml: async (path: string, value: Json) => { this.configStore.set(path, value); },
      },
      createElicitation: (request: BrowserElicitationRequest) => this.requestBrowserApproval(request),
      setResponseMeta: () => {},
      addAfterSubmittedCodeHook: () => {},
      emitContentItem: () => {},
      fetch: this.authenticatedFetch.fetch,
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
  close(): Promise<void> {
    if ((globalThis as Json).nodeRepl === this.runtimeShim) {
      if (this.previousNodeRepl === undefined) delete (globalThis as Json).nodeRepl;
      else (globalThis as Json).nodeRepl = this.previousNodeRepl;
    }
    return this.authenticatedFetch?.close() ?? Promise.resolve();
  }
}
