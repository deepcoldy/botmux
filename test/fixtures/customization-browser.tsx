// 浏览器夹具：真实的「自定义」页（CustomizationPage）。平台名册由测试经 window.__CZ_ROSTER__ 给出
// （与看板快照发布名册的方式一致），测试还可以经 window.__publishRoster 在页面打开期间改名册（看板轮询
// 就是这样改的）；所有 /api/** 由测试里的 Playwright 路由交给真实的 handleCustomizationApi 应答
// （见 dashboard-customization-scope.e2e.ts）。确认弹窗的根挂在 #root 之外，和应用外壳一样。
import React from 'react';
import {createRoot} from 'react-dom/client';
import {CustomizationPage} from '../../src/dashboard/web/customization-page.js';
import {ConfirmModalRoot} from '../../src/dashboard/web/confirm-modal.js';
import {publishProviderRoster} from '../../src/dashboard/web/provider-roster.js';

const roster = (window as unknown as {__CZ_ROSTER__?: {lark?: number; wecom?: number}}).__CZ_ROSTER__ ?? {};
if (roster.lark !== undefined) publishProviderRoster('lark', roster.lark);
if (roster.wecom !== undefined) publishProviderRoster('wecom', roster.wecom);
(window as unknown as {__publishRoster: typeof publishProviderRoster}).__publishRoster = publishProviderRoster;
// 应用里的 main 带着给侧栏外壳用的宽度补偿，夹具没有外壳，这里把宽度与外边距复原。
createRoot(document.getElementById('root')!).render(<main style={{padding: 24, width: 'auto', marginRight: 0}}><CustomizationPage /></main>);
const modalRoot = document.body.appendChild(document.createElement('div'));
createRoot(modalRoot).render(<ConfirmModalRoot />);
