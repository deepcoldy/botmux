// src/dashboard/web/icon-tooltip.ts
//
// 全局图标 tooltip：会话卡片 / 详情 / 看板里的图标方按钮以前只靠原生 `title`
// （出现慢、样式不可控、且在 overflow:hidden 的看板 rail 里体验差）。这里用一个
// body 级的委托 tooltip：监听带 `data-tip` 的元素 hover/focus，把气泡渲染到
// document.body（逃出各容器的 overflow:hidden 裁剪），统一样式、即时出现。
//
// 用法：给按钮加 `data-tip="重启 CLI"`（配合已有的 aria-label 做无障碍）。无需每个
// 组件各自接一套 React 状态——一处初始化，全站图标按钮通用。

let initialized = false;
let tipEl: HTMLDivElement | null = null;
let currentTarget: Element | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;

function ensureTipEl(): HTMLDivElement {
  if (tipEl) return tipEl;
  const el = document.createElement('div');
  el.className = 'icon-tip';
  el.setAttribute('role', 'tooltip');
  el.style.display = 'none';
  document.body.appendChild(el);
  tipEl = el;
  return el;
}

function position(target: Element): void {
  const el = ensureTipEl();
  const r = target.getBoundingClientRect();
  // 先量气泡尺寸（display 已为 block）。
  const tw = el.offsetWidth;
  const th = el.offsetHeight;
  const margin = 8;
  // 默认放上方居中；靠近顶部时翻到下方。
  const below = r.top < th + margin + 4;
  let left = r.left + r.width / 2 - tw / 2;
  left = Math.min(Math.max(left, 6), window.innerWidth - tw - 6);
  const top = below ? r.bottom + margin : r.top - th - margin;
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.dataset.placement = below ? 'bottom' : 'top';
}

function hide(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = null; }
  currentTarget = null;
  if (tipEl) { tipEl.style.display = 'none'; tipEl.classList.remove('show'); }
}

function showFor(target: Element): void {
  const label = target.getAttribute('data-tip');
  if (!label) return;
  currentTarget = target;
  const el = ensureTipEl();
  el.textContent = label;
  el.style.display = 'block';
  el.classList.remove('show');
  // 量完尺寸再定位，然后下一帧加 .show 触发淡入。
  position(target);
  requestAnimationFrame(() => {
    if (currentTarget === target) el.classList.add('show');
  });
}

function resolveTipTarget(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  return node.closest('[data-tip]');
}

/** 初始化一次即可。委托监听 hover / focus，出现前有 120ms 延迟（避免划过闪烁）。 */
export function initIconTooltips(): void {
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  document.addEventListener('pointerover', (e) => {
    const target = resolveTipTarget(e.target);
    if (!target || target === currentTarget) return;
    if (showTimer) clearTimeout(showTimer);
    showTimer = setTimeout(() => showFor(target), 120);
  });
  document.addEventListener('pointerout', (e) => {
    const from = resolveTipTarget(e.target);
    if (!from) return;
    // 移到气泡自身或仍在同一按钮内不隐藏。
    const to = e.relatedTarget instanceof Element ? e.relatedTarget : null;
    if (to && (to === from || from.contains(to))) return;
    hide();
  });
  // 键盘可达：focus 显示，blur 隐藏。
  document.addEventListener('focusin', (e) => {
    const target = resolveTipTarget(e.target);
    if (target) showFor(target);
  });
  document.addEventListener('focusout', hide);
  // 点击后立即隐藏（多为触发了操作），滚动/尺寸变化重定位或隐藏。
  document.addEventListener('click', hide, true);
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}
