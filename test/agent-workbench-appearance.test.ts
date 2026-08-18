import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKBENCH_SKIN,
  DEFAULT_WORKBENCH_TERM_STYLE,
  WORKBENCH_CLASSIC_TERM_THEME,
  WORKBENCH_ORCA_TERM_THEMES,
  WORKBENCH_SKIN_IDS,
  WorkbenchAppearanceStore,
  defaultWorkbenchAppearance,
  loadWorkbenchAppearance,
  normalizeWorkbenchAppearance,
  postWorkbenchTermAppearance,
  resolveWorkbenchSkin,
  saveWorkbenchAppearance,
  selectWorkbenchMode,
  selectWorkbenchSkin,
  selectWorkbenchTermStyle,
  workbenchSkinFamily,
  workbenchTermContainerClass,
  workbenchTermTheme,
  type WorkbenchAppearance,
  type WorkbenchAppearanceEnvironment,
  type WorkbenchAppearanceRoot,
} from '../src/dashboard/web/agent-workbench-appearance.js';
import type { WorkbenchStorage } from '../src/dashboard/web/agent-workbench-storage.js';

class MemoryStorage implements WorkbenchStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

/**
 * key 故意在测试里写死：它是存量数据的入口，改名就等于把所有人选过的配色清空。
 * 命名沿用工作台既有的 `botmux.agent-workbench.<域>.v<n>` 家族。
 */
const APPEARANCE_KEY = 'botmux.agent-workbench.appearance.v1';

function fakeRoot(initial: Record<string, string> = {}): WorkbenchAppearanceRoot {
  return { dataset: { ...initial } };
}

describe('工作台外观：默认值与持久化', () => {
  it('没有本地记录时给默认外观：蓝灰 + 经典终端 + 继承全站明暗', () => {
    const storage = new MemoryStorage();
    expect(loadWorkbenchAppearance(storage, 'system')).toEqual({
      skin: 'slate-blue',
      mode: 'system',
      termStyle: 'classic',
    });
    // 默认值本身也钉死：slate-blue 最接近现有品牌观感，classic 即现状渲染（存量零变化）。
    expect(DEFAULT_WORKBENCH_SKIN).toBe('slate-blue');
    expect(DEFAULT_WORKBENCH_TERM_STYLE).toBe('classic');
    expect(defaultWorkbenchAppearance('dark').mode).toBe('dark');
  });

  it('三个字段共用一条记录，写回的 JSON 不多不少', () => {
    const storage = new MemoryStorage();
    const appearance: WorkbenchAppearance = { skin: 'warm-graphite', mode: 'light', termStyle: 'orca' };
    expect(saveWorkbenchAppearance(storage, appearance)).toBe(true);
    const raw = storage.values.get(APPEARANCE_KEY)!;
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual(['mode', 'skin', 'termStyle']);
    expect(loadWorkbenchAppearance(storage, 'dark')).toEqual(appearance);
  });

  it('脏值逐字段回落默认，不抛错也不整份丢弃', () => {
    expect(normalizeWorkbenchAppearance({ skin: 'neon', mode: 'sunset', termStyle: 'ascii' }, 'light'))
      .toEqual({ skin: 'slate-blue', mode: 'light', termStyle: 'classic' });
    // 只有一个字段坏掉时，另外两个照旧留着。
    expect(normalizeWorkbenchAppearance({ skin: 'orca-ink', mode: 'dark', termStyle: 42 }, 'system'))
      .toEqual({ skin: 'orca-ink', mode: 'dark', termStyle: 'classic' });
    for (const junk of [null, undefined, 'orca-ink', 7, ['orca-ink']]) {
      expect(normalizeWorkbenchAppearance(junk, 'dark')).toEqual(defaultWorkbenchAppearance('dark'));
    }
  });

  it('坏 JSON / localStorage 抛异常时回落默认，不白屏', () => {
    const storage = new MemoryStorage();
    storage.values.set(APPEARANCE_KEY, '{not json');
    expect(loadWorkbenchAppearance(storage, 'dark')).toEqual(defaultWorkbenchAppearance('dark'));

    const hostile: WorkbenchStorage = {
      getItem() { throw new Error('denied'); },
      setItem() { throw new Error('denied'); },
    };
    expect(loadWorkbenchAppearance(hostile, 'system')).toEqual(defaultWorkbenchAppearance('system'));
    // 写失败只是「本次只在当前页生效」，不该冒泡成异常。
    expect(saveWorkbenchAppearance(hostile, defaultWorkbenchAppearance())).toBe(false);
    expect(saveWorkbenchAppearance(null, defaultWorkbenchAppearance())).toBe(false);
  });
});

describe('工作台外观：明暗族与色板规则', () => {
  it('light-frost 属浅色族，其余三套属深色族', () => {
    expect(WORKBENCH_SKIN_IDS).toEqual(['orca-ink', 'slate-blue', 'warm-graphite', 'light-frost']);
    expect(workbenchSkinFamily('light-frost')).toBe('light');
    for (const skin of ['orca-ink', 'slate-blue', 'warm-graphite'] as const) {
      expect(workbenchSkinFamily(skin)).toBe('dark');
    }
  });

  it('mode 决定明暗族，skin 只决定深色族里用哪一套', () => {
    const warm: WorkbenchAppearance = { skin: 'warm-graphite', mode: 'dark', termStyle: 'classic' };
    expect(resolveWorkbenchSkin(warm, false)).toBe('warm-graphite');
    expect(resolveWorkbenchSkin({ ...warm, mode: 'light' }, false)).toBe('light-frost');
    expect(resolveWorkbenchSkin({ ...warm, mode: 'light' }, true)).toBe('light-frost');
    // 跟随系统：在用户选定的深色代表与 light-frost 之间切。
    expect(resolveWorkbenchSkin({ ...warm, mode: 'system' }, true)).toBe('warm-graphite');
    expect(resolveWorkbenchSkin({ ...warm, mode: 'system' }, false)).toBe('light-frost');
    // 存量脏值把浅色那套留在 skin 上时，深色族回落默认而不是渲染成浅色。
    expect(resolveWorkbenchSkin({ skin: 'light-frost', mode: 'dark', termStyle: 'orca' }, false)).toBe('slate-blue');
  });

  it('跟随系统下点浅色 = 我要一直浅色；深色代表原样留着', () => {
    const base: WorkbenchAppearance = { skin: 'orca-ink', mode: 'system', termStyle: 'classic' };
    const light = selectWorkbenchSkin(base, 'light-frost');
    expect(light).toEqual({ skin: 'orca-ink', mode: 'light', termStyle: 'classic' });
    // 再切回深色，用户上次选的那套还在。
    expect(resolveWorkbenchSkin(selectWorkbenchMode(light, 'dark'), false)).toBe('orca-ink');
  });

  it('跟随系统下点深色只换代表色；浅色下点深色顺带切到深色', () => {
    const system: WorkbenchAppearance = { skin: 'slate-blue', mode: 'system', termStyle: 'classic' };
    expect(selectWorkbenchSkin(system, 'warm-graphite')).toEqual({
      skin: 'warm-graphite', mode: 'system', termStyle: 'classic',
    });
    const light: WorkbenchAppearance = { skin: 'slate-blue', mode: 'light', termStyle: 'orca' };
    expect(selectWorkbenchSkin(light, 'orca-ink')).toEqual({
      skin: 'orca-ink', mode: 'dark', termStyle: 'orca',
    });
  });

  it('选中已生效的项时返回同一份引用，不触发多余的写和重绘', () => {
    const current: WorkbenchAppearance = { skin: 'slate-blue', mode: 'light', termStyle: 'orca' };
    expect(selectWorkbenchMode(current, 'light')).toBe(current);
    expect(selectWorkbenchTermStyle(current, 'orca')).toBe(current);
    expect(selectWorkbenchSkin(current, 'light-frost')).toBe(current);
    expect(selectWorkbenchTermStyle(current, 'classic')).toEqual({ ...current, termStyle: 'classic' });
  });
});

describe('工作台外观：终端双风格', () => {
  it('两套容器 class 与两套 xterm theme 一一对应', () => {
    expect(workbenchTermContainerClass('orca')).toBe('wb-term-orca');
    expect(workbenchTermContainerClass('classic')).toBe('wb-term-classic');
    expect(workbenchTermTheme('classic', 'warm-graphite')).toBe(WORKBENCH_CLASSIC_TERM_THEME);
    expect(workbenchTermTheme('orca', 'warm-graphite')).toBe(WORKBENCH_ORCA_TERM_THEMES['warm-graphite']);
  });

  it('classic = 终端页现有配色原样（存量零变化）', () => {
    const terminalPage = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const marker = terminalPage.indexOf('var term=new Terminal({');
    expect(marker).toBeGreaterThan(0);
    const themeBlock = terminalPage.slice(marker, marker + 400);
    for (const value of Object.values(WORKBENCH_CLASSIC_TERM_THEME)) {
      expect(themeBlock).toContain(value);
    }
  });

  it('orca 每套配色都给全 theme，且背景就是该套的终端画布色', () => {
    const termBg: Record<string, string> = {
      'orca-ink': '#030303',
      'slate-blue': '#030407',
      'warm-graphite': '#040402',
      // 浅色那套的终端画布仍是深色：彩色 ANSI 放浅底上不可读。
      'light-frost': '#16202B',
    };
    for (const skin of WORKBENCH_SKIN_IDS) {
      const theme = WORKBENCH_ORCA_TERM_THEMES[skin];
      expect(theme.background).toBe(termBg[skin]);
      expect(Object.keys(theme).sort()).toEqual(Object.keys(WORKBENCH_CLASSIC_TERM_THEME).sort());
      for (const value of Object.values(theme)) expect(value).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('下发给终端 iframe 时按 iframe 自己的 origin 定向，推不出来就放弃', () => {
    const sent: Array<{ data: unknown; origin: string }> = [];
    const frame = { contentWindow: { postMessage: (data: unknown, origin: string) => { sent.push({ data, origin }); } } };
    expect(postWorkbenchTermAppearance(frame, '/s/abc', 'orca', 'orca-ink', 'https://board.example/x')).toBe(true);
    expect(sent[0].origin).toBe('https://board.example');
    expect(sent[0].data).toMatchObject({
      type: 'botmux:wb-appearance',
      termStyle: 'orca',
      skin: 'orca-ink',
      theme: WORKBENCH_ORCA_TERM_THEMES['orca-ink'],
    });
    // 触屏的 viewToken 链接可能落在别的 host/port 上，origin 跟着链接走。
    expect(postWorkbenchTermAppearance(frame, 'http://box.local:8931/s/abc', 'classic', 'slate-blue')).toBe(true);
    expect(sent[1].origin).toBe('http://box.local:8931');
    // 解不出 origin（相对地址 + 没有基准页）时不发，绝不退化成 `*` 广播。
    expect(postWorkbenchTermAppearance(frame, '/s/abc', 'orca', 'orca-ink')).toBe(false);
    expect(postWorkbenchTermAppearance(frame, null, 'orca', 'orca-ink', 'https://board.example')).toBe(false);
    expect(postWorkbenchTermAppearance({ contentWindow: null }, '/s/abc', 'orca', 'orca-ink', 'https://board.example')).toBe(false);
    expect(sent).toHaveLength(2);
  });
});

describe('工作台外观 store：落到文档根 / 跨 tab / 跟随系统', () => {
  function harness(options: {
    storage?: WorkbenchStorage | null;
    root?: WorkbenchAppearanceRoot;
    inheritedMode?: WorkbenchAppearance['mode'];
    prefersDark?: boolean;
  } = {}) {
    const root = options.root ?? fakeRoot({ skin: 'default', theme: 'light' });
    let prefersDark = options.prefersDark ?? true;
    const systemListeners = new Set<() => void>();
    const storageListeners = new Set<(key: string | null, value: string | null) => void>();
    const env: WorkbenchAppearanceEnvironment = {
      storage: options.storage === undefined ? new MemoryStorage() : options.storage,
      root,
      inheritedMode: options.inheritedMode ?? 'dark',
      prefersDark: () => prefersDark,
      onSystemThemeChange: listener => {
        systemListeners.add(listener);
        return () => systemListeners.delete(listener);
      },
      onStorageChange: listener => {
        storageListeners.add(listener);
        return () => storageListeners.delete(listener);
      },
    };
    const store = new WorkbenchAppearanceStore();
    store.configure(env);
    return {
      store,
      root,
      env,
      setSystemDark(next: boolean) {
        prefersDark = next;
        for (const listener of systemListeners) listener();
      },
      pushStorage(key: string | null, value: string | null) {
        for (const listener of storageListeners) listener(key, value);
      },
      systemListenerCount: () => systemListeners.size,
    };
  }

  it('挂载期间把生效配色写进 data-skin / data-theme，卸载后原样还回去', () => {
    const h = harness({ inheritedMode: 'dark' });
    expect(h.root.dataset.skin).toBe('default');
    const unmount = h.store.mount();
    expect(h.root.dataset.skin).toBe('slate-blue');
    expect(h.root.dataset.theme).toBe('dark');
    unmount();
    // 4 套配色是工作台局部调色板，离开工作台不该继续盖着全站的 skin / 明暗。
    expect(h.root.dataset.skin).toBe('default');
    expect(h.root.dataset.theme).toBe('light');
    expect(h.systemListenerCount()).toBe(0);
  });

  it('两块工作台表面同时挂载时只接一次环境，最后一块卸载才还原', () => {
    const h = harness();
    const first = h.store.mount();
    const second = h.store.mount();
    expect(h.systemListenerCount()).toBe(1);
    first();
    expect(h.root.dataset.skin).toBe('slate-blue');
    second();
    expect(h.root.dataset.skin).toBe('default');
  });

  it('改外观即时落盘、即时重绘，并通知所有订阅者', () => {
    const storage = new MemoryStorage();
    const h = harness({ storage, inheritedMode: 'dark' });
    const unmount = h.store.mount();
    let notified = 0;
    h.store.subscribe(() => { notified += 1; });

    h.store.set(selectWorkbenchSkin(h.store.getSnapshot().appearance, 'warm-graphite'));
    expect(notified).toBe(1);
    expect(h.store.getSnapshot().skin).toBe('warm-graphite');
    expect(h.root.dataset.skin).toBe('warm-graphite');
    expect(JSON.parse(storage.values.get(APPEARANCE_KEY)!)).toEqual({
      skin: 'warm-graphite', mode: 'dark', termStyle: 'classic',
    });

    h.store.set(selectWorkbenchSkin(h.store.getSnapshot().appearance, 'light-frost'));
    expect(h.store.getSnapshot()).toMatchObject({ skin: 'light-frost', theme: 'light' });
    expect(h.root.dataset.theme).toBe('light');
    // 快照对象在没变化时保持同一引用（useSyncExternalStore 靠它避免多余重渲染）。
    const stable = h.store.getSnapshot();
    expect(h.store.getSnapshot()).toBe(stable);
    unmount();
  });

  it('跟随系统时随系统明暗切换，显式选了浅/深就不再跟', () => {
    const h = harness({ inheritedMode: 'system', prefersDark: true });
    const unmount = h.store.mount();
    expect(h.store.getSnapshot().skin).toBe('slate-blue');
    h.setSystemDark(false);
    expect(h.store.getSnapshot().skin).toBe('light-frost');
    expect(h.root.dataset.theme).toBe('light');
    h.setSystemDark(true);
    expect(h.store.getSnapshot().skin).toBe('slate-blue');

    h.store.set(selectWorkbenchMode(h.store.getSnapshot().appearance, 'light'));
    h.setSystemDark(true);
    expect(h.store.getSnapshot().skin).toBe('light-frost');
    unmount();
  });

  it('别的 tab 改了外观就跟着变；别的 key 和脏值都不打扰', () => {
    const storage = new MemoryStorage();
    const h = harness({ storage, inheritedMode: 'dark' });
    const unmount = h.store.mount();

    h.pushStorage(APPEARANCE_KEY, JSON.stringify({ skin: 'orca-ink', mode: 'dark', termStyle: 'orca' }));
    expect(h.store.getSnapshot().appearance).toEqual({ skin: 'orca-ink', mode: 'dark', termStyle: 'orca' });
    expect(h.root.dataset.skin).toBe('orca-ink');

    h.pushStorage('botmux.agent-workbench.rail.v1', '{"railWidth":420}');
    expect(h.store.getSnapshot().appearance.skin).toBe('orca-ink');

    h.pushStorage(APPEARANCE_KEY, '{not json');
    expect(h.store.getSnapshot().appearance).toEqual(defaultWorkbenchAppearance('dark'));

    // key=null 是「整份 localStorage 被清空」，回去重读一遍即可（读回默认）。
    storage.values.set(APPEARANCE_KEY, JSON.stringify({ skin: 'warm-graphite', mode: 'dark', termStyle: 'orca' }));
    h.pushStorage(null, null);
    expect(h.store.getSnapshot().appearance.skin).toBe('warm-graphite');
    unmount();
  });

  it('全站明暗仲裁改过 data-theme 之后，工作台把自己的解析结果盖回去且不白重绘', () => {
    const h = harness({ inheritedMode: 'dark' });
    const unmount = h.store.mount();
    let notified = 0;
    h.store.subscribe(() => { notified += 1; });

    // ui.ts 那套全站仲裁在系统明暗变化时也会写这个属性；工作台在场时以工作台为准。
    h.root.dataset.theme = 'light';
    h.store.reapply();
    expect(h.root.dataset.theme).toBe('dark');
    expect(h.root.dataset.skin).toBe('slate-blue');
    // 内容没变就不该通知订阅者，否则每来一次全站事件工作台都要重绘一遍。
    expect(notified).toBe(0);

    // 跨 tab 推来一份内容相同的记录同理：不换快照身份、不通知。
    const stable = h.store.getSnapshot();
    h.pushStorage(APPEARANCE_KEY, JSON.stringify(stable.appearance));
    expect(h.store.getSnapshot()).toBe(stable);
    expect(notified).toBe(0);
    unmount();
  });

  it('没有 localStorage / 没有文档根也照常工作，只是不落盘', () => {
    const h = harness({ storage: null, root: fakeRoot() });
    const unmount = h.store.mount();
    h.store.set(selectWorkbenchTermStyle(h.store.getSnapshot().appearance, 'orca'));
    expect(h.store.getSnapshot().appearance.termStyle).toBe('orca');
    unmount();
    expect(h.root.dataset.skin).toBeUndefined();
  });
});
