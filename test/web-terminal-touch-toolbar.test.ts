import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workerSource = readFileSync(join(process.cwd(), 'src/worker.ts'), 'utf8');

describe('web terminal touch shortcut toolbar', () => {
  it('renders an inverse-scaled screen-space shell with full-size targets', () => {
    expect(workerSource).toContain('id="toolbar-shell"');
    expect(workerSource).toContain('id="safe-area-probe"');
    expect(workerSource).toContain("tbShell.style.setProperty('--toolbar-scale',String(1/v.scale))");
    expect(workerSource).toContain('return collapsed?{width:48,height:48}:{width:compact?210:110,height:compact?160:260}');
    expect(workerSource).toContain('width:44px;height:44px;min-width:44px;min-height:44px');
    expect(workerSource).toContain('#toolbar.collapsed #toolbar-toggle{width:48px;height:48px');
  });

  it('keeps the collapse control visually inset without shrinking its hit target', () => {
    expect(workerSource).toContain('#toolbar-title{min-width:0;overflow:hidden');
    expect(workerSource).toContain('font:600 11px/16px -apple-system');
    expect(workerSource).toContain('<span id="toolbar-title" aria-hidden="true">\\u2328快捷键</span>');
    expect(workerSource).toContain('#toolbar-toggle{align-self:flex-end;display:grid;place-items:center;flex:0 0 44px;width:44px');
    expect(workerSource).toContain('padding:0!important;border:0!important;font-size:20px!important;background:transparent!important');
    expect(workerSource).toContain('#toolbar-collapse-icon{display:grid;place-items:center;width:32px;height:32px;border-radius:9px');
    expect(workerSource).toContain('#toolbar-collapse-icon svg{display:block;width:12px;height:20px;overflow:visible}');
    expect(workerSource).toContain('<svg viewBox="0 0 12 20" aria-hidden="true" focusable="false"><path d="M2 2l8 8-8 8"></path></svg>');
    expect(workerSource).toContain('#toolbar-grip{display:none;width:24px;height:16px}');
    expect(workerSource).toContain('#toolbar.collapsed #toolbar-grip{display:grid;place-items:center}');
    expect(workerSource).toContain('<svg viewBox="0 0 24 16" aria-hidden="true" focusable="false">');
  });

  it('uses the specified 2x4 and short-landscape 4x2 key layouts', () => {
    const keys = ['esc', 'ctrlc', 'tab', 'enter', 'up', 'down', 'left', 'right'];
    const actionsStart = workerSource.indexOf('<div id="toolbar-actions">');
    const actionsMarkup = workerSource.slice(actionsStart, workerSource.indexOf('</div>', actionsStart));
    const offsets = keys.map(key => actionsMarkup.indexOf(`data-k="${key}"`));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(workerSource).toContain('#toolbar-actions{display:grid;grid-template-columns:repeat(2,44px);gap:6px}');
    expect(workerSource).toContain('#toolbar.compact #toolbar-actions{grid-template-columns:repeat(4,44px)}');
    expect(workerSource).toContain('#toolbar.compact button[data-k="left"]{grid-column:1;grid-row:2}');
    expect(workerSource).toContain('var compact=v.height*v.scale<500');
  });

  it('stays on the right edge and persists only a per-orientation vertical ratio', () => {
    expect(workerSource).toContain("return v.width>=v.height?'landscape':'portrait'");
    expect(workerSource).toContain("localStorage.setItem(_toolbarPositionKey+':'+orientation");
    expect(workerSource).toContain('_toolbarYRatio=bounds.max===bounds.min?.5:_clamp((center-bounds.min)/(bounds.max-bounds.min),0,1)');
    expect(workerSource).toContain('var targetCenter=handleBounds.min+_toolbarYRatio*(handleBounds.max-handleBounds.min)');
    expect(workerSource).toContain("tbShell.style.left=(bounds.right-metrics.width)+'px'");
    expect(workerSource).not.toContain('nearer side');
  });

  it('uses pointer gestures once, with an 8pt drag threshold and no touchend/click double-send', () => {
    expect(workerSource).toContain("btn.addEventListener('pointerdown'");
    expect(workerSource).toContain("btn.addEventListener('pointerup'");
    expect(workerSource).not.toContain("btn.addEventListener('touchend',fire");
    expect(workerSource).not.toContain("btn.addEventListener('click',fire");
    expect(workerSource).toContain('if(!p.moved&&p.inside&&Math.hypot(e.clientX-p.x,e.clientY-p.y)*v.scale<8)fire()');
    expect(workerSource).toContain('Math.hypot(dx,dy)*v.scale>=8');
    expect(workerSource).toContain("_toolbarGesture.moved=true;tbToggle.classList.remove('pressed')");
    expect(workerSource).toContain('var projected=_clamp(gesture.velocity*.10,-96,96)/v.scale');
  });

  it('temporarily collapses when the visual viewport cannot fit the panel', () => {
    expect(workerSource).toContain('var usable=(v.height-Math.max(edge,safe.top)-Math.max(edge,safe.bottom))*v.scale');
    expect(workerSource).toContain('var temporary=!_toolbarUserCollapsed&&usable<expanded.height+24');
    expect(workerSource).toContain("window.visualViewport.addEventListener('resize',_scheduleToolbarLayout)");
    expect(workerSource).toContain('requestAnimationFrame(_layoutToolbarNow)');
  });

  it('drives interruptible state and projected-release motion inside the inverse-scale shell', () => {
    expect(workerSource).toContain("ghost.classList.remove('idle','dragging');ghost.classList.add('toolbar-motion-ghost')");
    expect(workerSource).toContain('transform:translateY(-50%);transform-origin:right center!important');
    expect(workerSource).toContain("{opacity:0,transform:'scale(.94)'},{opacity:1,transform:'scale(1)'}");
    expect(workerSource).toContain("duration:350,easing:'cubic-bezier(.22,1,.36,1)'");
    expect(workerSource).toContain('_animateToolbarSettle((releaseCenter-landed.center)*v.scale)');
    expect(workerSource.indexOf('_cancelToolbarStateMotion();\n    if(!tb.animate||_toolbarReducedMotion()||Math.abs(deltaScreen)<.5)return;')).toBeGreaterThan(-1);
    expect(workerSource).toContain(")))_pauseToolbarStateMotion();\n    else _cancelToolbarStateMotion()");
    expect(workerSource).toContain('if(reverse!==_toolbarMotionReversing)_toolbarStateAnimations[i].reverse()');
    expect(workerSource).toContain("window.matchMedia('(prefers-reduced-motion: reduce)').matches");
  });
});
