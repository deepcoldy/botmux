/**
 * Web 终端页用的 xterm 浏览器组件，由 botmux 自己提供，不再从外部 CDN 拉。
 *
 * 为什么：终端页（worker 直出）和控制台的 v3 终端回放原来都从公共 CDN 加载 xterm
 * 与插件。浏览器那一侧连不上 CDN 时（公司网络、内网策略、CDN 抖动），`xterm.js`
 * 加载失败，紧接着 `new Terminal` 抛 ReferenceError，终端整页空白——服务器本身完全
 * 正常、WebSocket 也通，用户却什么都看不到。现在这些文件跟页面同源、由同一个进程
 * 发出：页面能打开，组件就能加载。
 *
 * 版本是 #1940 固定的那一组，**不要**换成 package.json 里控制台用的 6.x：混用主版本
 * 会在安卓 WebView 上白屏（#1940）。要升级就整组一起换，跑
 * `bun scripts/vendor-xterm-assets.ts` 重新生成内嵌数据（会按下面钉住的 npm
 * integrity 校验 tarball），再在各端实测。
 *
 * 本模块只放清单和路径，不碰 node API —— 控制台前端（浏览器打包）也要 import 它
 * 拼回放页的 URL。文件内容在生成的 `xterm-vendor-assets-data.ts` 里，只由服务端
 * （`xterm-vendor-serve.ts`）按需动态加载，不会被打进前端包。
 */

export interface XtermVendorPackage {
  readonly name: string;
  readonly version: string;
  /** npm 发布的 tarball integrity（`npm view <name>@<version> dist.integrity`）。 */
  readonly integrity: string;
}

export const XTERM_VENDOR_PACKAGES = {
  xterm: {
    name: '@xterm/xterm',
    version: '5.5.0',
    integrity: 'sha512-hqJHYaQb5OptNunnyAnkHyM8aCjZ1MEIDTQu1iIbbTD/xops91NB5yq1ZK/dC2JDbVWtF23zUtl9JE2NqwT87A==',
  },
  fit: {
    name: '@xterm/addon-fit',
    version: '0.10.0',
    integrity: 'sha512-UFYkDm4HUahf2lnEyHvio51TNGiLK66mqP2JoATy7hRZeXaGMRDr00JiSF7m63vR5WKATF605yEggJKsw0JpMQ==',
  },
  webLinks: {
    name: '@xterm/addon-web-links',
    version: '0.11.0',
    integrity: 'sha512-nIHQ38pQI+a5kXnRaTgwqSHnX7KE6+4SVoceompgHL26unAxdfP6IPqUTSYPQgSwM56hsElfoNrrW5V7BUED/Q==',
  },
  unicode11: {
    name: '@xterm/addon-unicode11',
    version: '0.8.0',
    integrity: 'sha512-LxinXu8SC4OmVa6FhgwsVCBZbr8WoSGzBl2+vqe8WcQ6hb1r6Gj9P99qTNdPiFPh4Ceiu2pC8xukZ6+2nnh49Q==',
  },
  webgl: {
    name: '@xterm/addon-webgl',
    version: '0.18.0',
    integrity: 'sha512-xCnfMBTI+/HKPdRnSOHaJDRqEpq2Ugy8LEj9GiY4J3zJObo3joylIFaMvzBwbYRg8zLtkO0KQaStCeSfoaI2/w==',
  },
  canvas: {
    name: '@xterm/addon-canvas',
    version: '0.7.0',
    integrity: 'sha512-LF5LYcfvefJuJ7QotNRdRSPc9YASAVDeoT5uyXS/nZshZXjYplGXRECBGiznwvhNL2I8bq1Lf5MzRwstsYQ2Iw==',
  },
} as const satisfies Record<string, XtermVendorPackage>;

export type XtermVendorPackageKey = keyof typeof XTERM_VENDOR_PACKAGES;

export interface XtermVendorAsset {
  readonly packageKey: XtermVendorPackageKey;
  /** tarball 里 `package/` 下的原始文件，内容逐字节不改。 */
  readonly file: string;
  /** 挂在 {@link XTERM_VENDOR_MARKER} 之后的路径：包名 + 版本 + 文件名，换版本 URL 就变。 */
  readonly path: string;
  readonly contentType: string;
}

const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';

function asset(packageKey: XtermVendorPackageKey, file: string, contentType: string): XtermVendorAsset {
  const pkg = XTERM_VENDOR_PACKAGES[packageKey];
  const dir = `${pkg.name.slice(pkg.name.indexOf('/') + 1)}-${pkg.version}`;
  return { packageKey, file, path: `${dir}/${file.slice(file.lastIndexOf('/') + 1)}`, contentType };
}

// 用的是 npm 包里的原始文件（lib/*.js、css/xterm.css）。CDN 上的 `*.min.js` 是它按需
// 生成的：xterm 与插件的 lib/*.js 本身已压缩，CDN 原样返回（响应头注明 "Skipped
// minification … Original file: …/lib/xterm.js"）；xterm.min.css 只是 xterm.css 的压缩版。
export const XTERM_VENDOR_ASSETS = {
  css: asset('xterm', 'css/xterm.css', CSS),
  xterm: asset('xterm', 'lib/xterm.js', JS),
  fit: asset('fit', 'lib/addon-fit.js', JS),
  webLinks: asset('webLinks', 'lib/addon-web-links.js', JS),
  unicode11: asset('unicode11', 'lib/addon-unicode11.js', JS),
  webgl: asset('webgl', 'lib/addon-webgl.js', JS),
  canvas: asset('canvas', 'lib/addon-canvas.js', JS),
} as const satisfies Record<string, XtermVendorAsset>;

/** worker 终端页：样式在 <head>，脚本按依赖顺序（xterm 先于各插件）。 */
export const WEB_TERMINAL_VENDOR_STYLES: readonly XtermVendorAsset[] = [XTERM_VENDOR_ASSETS.css];
export const WEB_TERMINAL_VENDOR_SCRIPTS: readonly XtermVendorAsset[] = [
  XTERM_VENDOR_ASSETS.xterm,
  XTERM_VENDOR_ASSETS.fit,
  XTERM_VENDOR_ASSETS.webLinks,
  XTERM_VENDOR_ASSETS.unicode11,
  XTERM_VENDOR_ASSETS.webgl,
  XTERM_VENDOR_ASSETS.canvas,
];

/**
 * 路由标记。worker 侧它可以出现在任意前缀之后（`/`、`/s/<会话>/`、自建反代加的前缀），
 * 控制台侧只认根路径 `/__botmux/vendor/…`。
 */
export const XTERM_VENDOR_MARKER = '/__botmux/vendor/';

const ASSET_BY_PATH: ReadonlyMap<string, XtermVendorAsset> = new Map(
  Object.values(XTERM_VENDOR_ASSETS).map((a) => [a.path, a]),
);

/** 控制台（总在源站根路径）引用这些文件用的绝对路径。 */
export function xtermVendorRootUrl(a: XtermVendorAsset): string {
  return `${XTERM_VENDOR_MARKER}${a.path}`;
}

/**
 * 判断一个请求路径是不是 vendor 资源请求。
 *  - `null`：不是，交给原有路由；
 *  - `{ asset: null }`：落在 vendor 路由下但不是清单里的文件（如浏览器开发者工具要的
 *    `*.js.map`），应答 404，不能落回终端页；
 *  - `{ asset }`：清单里的文件。
 * 只做清单精确匹配，不碰文件系统，所以不存在路径穿越。
 */
export function matchXtermVendorPath(
  pathname: string,
  mode: 'root' | 'anyPrefix',
): { asset: XtermVendorAsset | null } | null {
  const at = mode === 'root'
    ? (pathname.startsWith(XTERM_VENDOR_MARKER) ? 0 : -1)
    : pathname.lastIndexOf(XTERM_VENDOR_MARKER);
  if (at < 0) return null;
  return { asset: ASSET_BY_PATH.get(pathname.slice(at + XTERM_VENDOR_MARKER.length)) ?? null };
}

/**
 * worker 终端页里的内联脚本源码：按**页面自己的路径**拼出资源地址，再用
 * `document.write` 写出 `<link>` / `<script src>`。
 *
 * 为什么由浏览器拼、不由服务端拼：同一个页面会经不同的门进来，worker 看到的路径和
 * 浏览器地址栏里的不一样——平台和控制台前门原样转发 `/s/<会话>/…`，daemon 的终端代理
 * 会剥掉 `/s/<会话>` 前缀、还把有无结尾斜杠都归一成 `/`，自建反代可能再加一段前缀。
 * 服务端因此无从得知浏览器那边的前缀，相对路径也会因结尾斜杠的有无落到不同目录。
 * WebSocket 早就用「页面路径去掉结尾斜杠 + `/`」这条规则连回 worker，资源沿用同一条
 * 规则，能连上 WebSocket 的入口就一定能取到资源。
 *
 * 为什么用 `document.write`：它写出的是**解析器插入**的元素，和直接写在 HTML 里的标签
 * 语义一致——脚本按顺序同步执行完，后面的主脚本才运行（主脚本顶层就要 `new Terminal`）；
 * 样式表照样阻塞后续脚本，xterm 量字宽时样式已就位。用 DOM 动态插入则两条都不成立。
 * 同源脚本不受 Chrome 对 document.write 跨站脚本的拦截。
 *
 * 安全：
 *  - 地址前面显式拼 `protocol//host`。直接拼 `location.pathname` 时，`//evil.example/`
 *    这种路径会变成协议相对地址，从别的站点加载脚本。
 *  - 路径里的 `& < > " '` 全部转成数字实体再写进双引号属性，属性值解码后与原地址逐字
 *    相同，路径里夹带的 `&quot;` 之类无法闭合属性。
 *  - 脚本源码里不出现字面的 `</script`（拆成 `'<'+'/script>'`），否则会提前结束这段
 *    内联脚本。资源路径以 JSON 嵌入，并把 `<` 转义成 <。
 */
export function xtermVendorDocumentWriteSource(assets: readonly XtermVendorAsset[]): string {
  const paths = JSON.stringify(assets.map((a) => a.path)).replace(/</g, '\\u003c');
  const marker = JSON.stringify(XTERM_VENDOR_MARKER);
  return '(function(paths){'
    + 'var dir=location.pathname;'
    + "while(dir.charAt(dir.length-1)==='/')dir=dir.slice(0,-1);"
    + "var base=location.protocol+'//'+location.host+dir+" + marker + ';'
    + 'var esc=function(s){return s.replace(/[&<>"\']/g,function(c){return \'&#\'+c.charCodeAt(0)+\';\';});};'
    + "var html='';"
    + 'for(var i=0;i<paths.length;i++){'
    + 'var url=esc(base+paths[i]);'
    + "html+=/\\.css$/.test(paths[i])"
    + "?'<link rel=\"stylesheet\" href=\"'+url+'\">'"
    + ":'<script src=\"'+url+'\"><'+'/script>';"
    + '}'
    + 'document.write(html);'
    + '})(' + paths + ');';
}
