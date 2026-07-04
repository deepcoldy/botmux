/**
 * 飞书中国版 (Feishu) ↔ 国际版 (Lark) 的 host 单一事实源。
 *
 * brand 是**应用/租户的固有属性**，不是可在运行时切换的偏好：feishu app
 * (open.feishu.cn) 和 lark app (open.larksuite.com) 是两个平台上的两个独立
 * 应用，AppID / 扫码各自独立。所以 botmux 把 brand 做成**每个 bot 一个字段**
 * (BotConfig.brand，持久化进 bots.json)，缺省 / 旧配置 → 'feishu'，向后兼容。
 * 一个部署因此可以同时挂飞书 bot + Lark bot。
 *
 * 所有需要区分品牌的 host 都从这里派生，杜绝散落各处的
 * `brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'` 三元表达式。
 */

export type Brand = 'feishu' | 'lark';

export interface LarkHosts {
  /**
   * open-apis 基址 + 开放平台控制台 (`/app/...` 深链)。也是传给 SDK
   * `Lark.Client({ domain })` / `Lark.WSClient({ domain })` 的值
   * （见 {@link sdkDomain}）。
   */
  openApi: string;
  /** OAuth authorize host (`accounts.*`)——`/login` 用户授权码流程用。 */
  accounts: string;
  /** 客户端 AppLink host（不含 scheme）——拼"打开群聊"等深链用。 */
  applink: string;
}

const FEISHU: LarkHosts = {
  openApi: 'https://open.feishu.cn',
  accounts: 'https://accounts.feishu.cn',
  applink: 'applink.feishu.cn',
};

const LARK: LarkHosts = {
  openApi: 'https://open.larksuite.com',
  accounts: 'https://accounts.larksuite.com',
  applink: 'applink.larksuite.com',
};

/**
 * 把任意配置值收敛成合法 {@link Brand}。只有精确等于 `'lark'` 才判国际版，
 * 其余（undefined / '' / 旧配置 / 非字符串 / 大小写不符）一律 → `'feishu'`，
 * 保证旧 bots.json 行为不变。
 */
export function normalizeBrand(v: unknown): Brand {
  return v === 'lark' ? 'lark' : 'feishu';
}

/** 取指定 brand 的 host 三元组，缺省 feishu。 */
export function larkHosts(brand: Brand = 'feishu'): LarkHosts {
  return brand === 'lark' ? LARK : FEISHU;
}

/**
 * 传给 `new Lark.Client({ domain })` / `new Lark.WSClient({ domain })` 的 domain。
 *
 * SDK 的 `formatDomain` 对已知枚举返回固定 URL，对未知字符串走
 * `default: return domain`——所以直接给 openApi URL 字符串与给
 * `Domain.Lark` 枚举完全等价，且本模块无需依赖 SDK（也让单测无需 mock SDK）。
 */
export function sdkDomain(brand: Brand = 'feishu'): string {
  return larkHosts(brand).openApi;
}

/** 构造"在客户端打开群聊"的 AppLink，按 brand 选 applink host。 */
export function chatAppLink(chatId: string, brand: Brand = 'feishu'): string {
  return `https://${larkHosts(brand).applink}/client/chat/open?openChatId=${encodeURIComponent(chatId)}`;
}
