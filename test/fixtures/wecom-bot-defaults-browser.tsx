// 浏览器夹具：真实的 Bot 配置页（BotDefaultsPage），由测试按 `#/bot-defaults?provider=wecom&bot=<id>`
// 打开到一个企业微信机器人上；所有 /api/** 由测试里的 Playwright 路由应答（数据见 wecom-bot-defaults-browser-api.ts）。
import React from 'react';
import {createRoot} from 'react-dom/client';
import {BotDefaultsPage} from '../../src/dashboard/web/bot-defaults-page.js';
import {publishProviderRoster} from '../../src/dashboard/web/provider-roster.js';
publishProviderRoster('lark', 0);
publishProviderRoster('wecom', 1);
// 应用里的 main 带着给侧栏外壳用的宽度补偿（width: calc(100% + --chrome-x) 与负右外边距），夹具没有外壳，
// 这里把宽度与外边距复原，否则页面右缘会伸出视口。
createRoot(document.getElementById('root')!).render(<main style={{padding: 24, width: 'auto', marginRight: 0}}><BotDefaultsPage /></main>);
