// 「创建会话」跨页入口：侧边菜单等任意位置都可请求打开创建弹窗。
// 弹窗逻辑挂在 SessionsPage 上——已在会话页时监听事件直接打开；
// 不在会话页时先记 pending 再跳 #/sessions，SessionsPage 挂载后消费 pending 打开。
import { deploymentSupports } from './provider-roster.js';

export const OPEN_CREATE_SESSION_EVENT = 'botmux:open-create-session';

let pending = false;

export function requestOpenCreateSession(): void {
  // 部署不支持创建会话（已确认只有企业微信）时，任何入口都不打开飞书的创建弹窗。
  if (!deploymentSupports('createSession')) return;
  pending = true;
  window.dispatchEvent(new Event(OPEN_CREATE_SESSION_EVENT));
  if (!window.location.hash.startsWith('#/sessions')) window.location.hash = '#/sessions';
}

export function consumePendingCreateSession(): boolean {
  const wasPending = pending;
  pending = false;
  return wasPending;
}
