import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Import boundaries of the WeCom integration.
 *
 * The WeCom code is split by process and by layer:
 *   im/wecom/protocol  — platform wire protocol (WSS frames, callbacks, QR HTTP)
 *   im/wecom/config    — paths, configuration parsing, runtime.json records
 *   im/wecom/contract  — DTOs shared by the gateway, the Dashboard and the CLI
 *   im/wecom/gateway   — the `botmux wecom` process
 *   dashboard/wecom, cli/wecom — the Dashboard and CLI entry points
 *
 * These layers used to form a value-level import cycle (bridge → native-peers →
 * config → bridge, discovery → config), so importing the path helper
 * `discovery.ts` evaluated ~340 modules, Feishu transport and the CLI adapter
 * registry included. Nothing failed when that happened: it only showed up as a
 * slow, order-sensitive module graph. The rules below are what keeps it from
 * coming back.
 */

const srcRoot = new URL('../src/', import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, srcRoot), 'utf8');

type EdgeKind = 'value' | 'type' | 'dynamic';
interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

// Same specifier grammar as index-dashboard-entry.test.ts's staticImportClosure, extended
// in two ways: the import clause is captured so `import type` and all-`type` named lists
// become type edges (erased at runtime) instead of being dropped, and dynamic import() is
// collected as its own edge kind.
const STATIC_SPECIFIER = /(?:^|;)\s*(?:import|export)\s+([^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;
const DYNAMIC_SPECIFIER = /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function isTypeOnlyClause(clause: string | undefined): boolean {
  if (!clause) return false; // side-effect import: always evaluated
  const bindings = clause.replace(/\sfrom\s+$/, '').trim();
  if (/^type\s/.test(bindings)) return true;
  const named = bindings.match(/^\{([\s\S]*)\}$/);
  if (!named) return false; // default or namespace binding
  const items = named[1].split(',').map(item => item.trim()).filter(Boolean);
  return items.length > 0 && items.every(item => /^type\s/.test(item));
}

function resolveSpecifier(from: string, specifier: string): string | undefined {
  const joined = posix.normalize(posix.join(posix.dirname(from), specifier));
  const candidates = [joined, joined.replace(/\.js$/, '.ts'), joined.replace(/\.js$/, '.tsx')];
  return candidates.find(candidate => existsSync(new URL(candidate, srcRoot)));
}

function collectEdges(): Edge[] {
  const files = (readdirSync(srcRoot, { recursive: true }) as string[])
    .map(file => file.split('\\').join('/'))
    .filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts'));
  const edges: Edge[] = [];
  for (const from of files) {
    const source = read(from);
    for (const match of source.matchAll(STATIC_SPECIFIER)) {
      const to = resolveSpecifier(from, match[2]);
      if (to) edges.push({ from, to, kind: isTypeOnlyClause(match[1]) ? 'type' : 'value' });
    }
    for (const match of source.matchAll(DYNAMIC_SPECIFIER)) {
      const to = resolveSpecifier(from, match[1]);
      if (to) edges.push({ from, to, kind: 'dynamic' });
    }
  }
  return edges;
}

const edges = collectEdges();
const describeEdge = (edge: Edge) => `${edge.from} -> ${edge.to} (${edge.kind})`;

const isWecomFile = (file: string) => /^(im\/wecom|dashboard\/wecom|cli\/wecom)\//.test(file);
const isRuntimeEdge = (edge: Edge) => edge.kind !== 'type';

/** Strongly connected components (Tarjan) of the graph made of `keep` edges. */
function stronglyConnected(keep: (edge: Edge) => boolean): string[][] {
  const next = new Map<string, string[]>();
  for (const edge of edges) {
    if (!keep(edge)) continue;
    const targets = next.get(edge.from) ?? [];
    targets.push(edge.to);
    next.set(edge.from, targets);
  }
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (node: string) => {
    index.set(node, counter);
    low.set(node, counter);
    counter++;
    stack.push(node);
    onStack.add(node);
    for (const target of next.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node)!, low.get(target)!));
      } else if (onStack.has(target)) {
        low.set(node, Math.min(low.get(node)!, index.get(target)!));
      }
    }
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== node);
      const selfLoop = component.length === 1 && (next.get(node) ?? []).includes(node);
      if (component.length > 1 || selfLoop) components.push(component.sort());
    }
  };
  for (const node of next.keys()) if (!index.has(node)) visit(node);
  return components;
}

/** Every module evaluated before `entry`'s body runs: static value edges only. */
function staticValueClosure(entry: string): Set<string> {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of edges) if (edge.from === file && edge.kind === 'value') pending.push(edge.to);
  }
  return seen;
}

// 源码结构护栏(K1)：import 图只存在于源码里——值级环不会让任何调用失败，只表现为模块求值顺序
// 敏感（TDZ / undefined import）和 import 一个路径小工具就拉起整个 gateway + 飞书 transport。
// 这里守的是企微分层的依赖方向：protocol 不依赖仓库其它模块，config 不依赖 gateway / dashboard / cli，
// discovery 的静态闭包不碰飞书与 CLI 注册表，core 不依赖企微，前端只经 config / contract 取类型。
describe('WeCom import boundaries', () => {
  it('sees the edges it is meant to judge (scanner sanity)', () => {
    const has = (from: string, to: string, kind: EdgeKind) =>
      edges.some(edge => edge.from === from && edge.to === to && edge.kind === kind);
    expect(has('im/wecom/gateway/command.ts', 'im/wecom/gateway/bridge.ts', 'value')).toBe(true);
    expect(has('cli.ts', 'cli/wecom/identify.ts', 'dynamic')).toBe(true);
    expect(has('im/wecom/gateway/core-client.ts', 'im/wecom/gateway/bridge.ts', 'type')).toBe(true);
    expect(has('dashboard/web/overview.ts', 'im/wecom/contract/dashboard-dto.ts', 'type')).toBe(true);
    expect(has('cli.ts', 'im/wecom/gateway/command.ts', 'dynamic')).toBe(true);
    expect(has('core/fleet-wecom-members.ts', 'im/wecom/config/fleet-members.ts', 'value')).toBe(true);
  });

  it('has no value-level import cycle through any WeCom module', () => {
    const cycles = stronglyConnected(isRuntimeEdge).filter(component => component.some(isWecomFile));
    expect(cycles.map(component => component.join(' <-> '))).toEqual([]);
  });

  it('keeps im/wecom/protocol free of imports outside protocol', () => {
    const offending = edges.filter(edge => edge.from.startsWith('im/wecom/protocol/')
      && !edge.to.startsWith('im/wecom/protocol/'));
    expect(offending.map(describeEdge)).toEqual([]);
  });

  it('keeps im/wecom/config off the gateway, the Dashboard and the CLI (types included)', () => {
    const forbidden = /^(im\/wecom\/gateway\/|dashboard\/|cli\/)|^(dashboard|cli)\.ts$/;
    const offending = edges.filter(edge => edge.from.startsWith('im/wecom/config/') && forbidden.test(edge.to));
    expect(offending.map(describeEdge)).toEqual([]);
  });

  it('keeps Feishu, bot-registry and the CLI adapter registry out of discovery.ts\'s static closure', () => {
    const closure = staticValueClosure('im/wecom/config/discovery.ts');
    expect(closure).toContain('utils/atomic-write.ts');
    const forbidden = [...closure].filter(file =>
      file.startsWith('im/lark/') || file === 'bot-registry.ts' || file === 'adapters/cli/registry.ts');
    expect(forbidden).toEqual([]);
  });

  // The fleet (src/core) resolves WeCom connections as members, so it may read
  // WeCom configuration and the shared contract — but only through modules that
  // never load WeCom process code: the supervisor must not evaluate the gateway,
  // the Dashboard's WeCom routes or the WeCom CLI just to list connections.
  it('lets src/core reach WeCom only through config / contract modules that load no WeCom process code', () => {
    const coreEdges = edges.filter(edge => edge.from.startsWith('core/') && isWecomFile(edge.to));
    const outsideLayers = coreEdges.filter(edge => !/^im\/wecom\/(config|contract)\//.test(edge.to));
    expect(outsideLayers.map(describeEdge)).toEqual([]);
    const processModule = /^(im\/wecom\/gateway|dashboard\/wecom|cli\/wecom)\//;
    const reachesProcessCode = coreEdges
      .filter(isRuntimeEdge)
      .flatMap(edge => [...staticValueClosure(edge.to)]
        .filter(file => processModule.test(file))
        .map(file => `${describeEdge(edge)} reaches ${file}`));
    expect(reachesProcessCode).toEqual([]);
  });

  it('lets the Dashboard frontend reach WeCom only through config / contract types', () => {
    const offending = edges.filter(edge => edge.from.startsWith('dashboard/web/') && isWecomFile(edge.to)
      && (edge.kind !== 'type' || !/^im\/wecom\/(config|contract)\//.test(edge.to)));
    expect(offending.map(describeEdge)).toEqual([]);
  });

  // The Dashboard and CLI processes reach the gateway only through its wire
  // contracts (im/wecom/contract, the native gateway contract in core); a value
  // or dynamic import would load `botmux wecom` process code into them.
  it('keeps the Dashboard and CLI WeCom code off gateway process modules at runtime', () => {
    const offending = edges.filter(edge => /^(dashboard|cli)\/wecom\//.test(edge.from)
      && edge.to.startsWith('im/wecom/gateway/') && isRuntimeEdge(edge));
    expect(offending.map(describeEdge)).toEqual([]);
  });

  // dashboard.ts is the Feishu Dashboard's entry script: WeCom enters it through
  // one seam module, so its wiring stays at the call sites that module exposes.
  it('lets dashboard.ts import WeCom only through dashboard/wecom/index.ts', () => {
    const wecomTargets = edges.filter(edge => edge.from === 'dashboard.ts' && isWecomFile(edge.to)).map(edge => edge.to);
    expect([...new Set(wecomTargets)]).toEqual(['dashboard/wecom/index.ts']);
  });
});
