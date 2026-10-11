/**
 * FROZEN v1 snapshot of the REAL botmux CLI's root dispatch for the turn-idle
 * channel — the version a v2 wrapper plugin can be mixed with.
 *
 * WHY this revision: the v2 protocol (`v === 2` + frozen identity) landed in
 * 6278cc59a; from then on the bare `turn-idle` subcommand refuses a payload that
 * does not carry a frozen turn. The last CLI whose `turn-idle` re-read the LIVE
 * marker/capability is 13f022b41 ("feat(dsh-tui): 结构化回合空闲上报通道"), and
 * THAT is the binary a v2 plugin can be mixed with after an in-place
 * update/rollback. (4260270a9 / 6a5f3cae6 already require `v === 2`, so they are
 * not the hazard; a v3.40.0 release predates the channel entirely.)
 *
 * PROVENANCE: every block below is copied VERBATIM out of
 *   `git show 13f022b41:src/cli.ts`
 * (mechanically extracted by line range, then checked byte-for-byte back into
 * the source), with the only deviations:
 *   1. module specifiers were rewritten from CLI-relative (`./core/…`,
 *      `./services/…`, `./utils/…`, `./global-config.js`) to repo-relative
 *      (`../../src/…`) paths — static imports in the header block and the three
 *      dynamic `await import('…')` calls inside the copied functions. Nothing
 *      else on those lines changed, and the imported helpers are the REAL
 *      modules still shipping in src/ (session-marker, managed-origin-
 *      capability, daemon-ipc-auth, loopback-fetch, daemon-discovery, ids,
 *      install-info, global-config, plugins/*, plugin-registry-store) — so the
 *      live-identity read below is the production code path, not a
 *      re-implementation;
 *   2. `PKG_ROOT` is derived from this file's location (test/fixtures/) instead
 *      of `dirname(__dirname)`;
 *   3. the root `switch` keeps only `case 'turn-idle'` and `default:` — every
 *      other branch of the old switch is unreachable for these argv[2] values,
 *      and none was rewritten. In particular `default:` still runs the REAL
 *      `runPluginCommandByName` (plugin lookup by exact command name) before
 *      `showHelp()`, which is what an unknown/versioned subcommand hits.
 * No branch was deleted from the copied functions, and no line of
 * `postSessionScopedSignal` / `cmdTurnIdle` / `runPluginCommandByName` was
 * modified: the "reports the LIVE (B) identity" bug under test is the real v1
 * behaviour, not a stand-in for it.
 *
 * Blocks (all verbatim, with their leading doc comments):
 *   readStdinWithTimeout 14952-14966 · resolveDataDir 3964-3971 ·
 *   listOnlineDaemons/findDaemon 6091-6105 · postSessionScopedSignal 14842-14904 ·
 *   cmdTurnIdle 14910-14929 · pluginRegistryCache/readPluginRegistryCached
 *   16647-16653 · loadPluginRegistryForCommand 16655-16659 ·
 *   printPluginUsage 16661-16676 · runPluginCommandByName 16974-17007 ·
 *   getVersion 16008-16021 · showHelp 6785-6996 ·
 *   `case 'turn-idle'` 17391-17396 · `default:` 17568-17570
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveBotmuxDataDir } from '../../src/core/data-dir.js';
import { fetchDaemonIpc, loadDaemonIpcSecret } from '../../src/core/daemon-ipc-auth.js';
import { loopbackFetch } from '../../src/core/loopback-fetch.js';
import { readManagedOriginCapability } from '../../src/core/managed-origin-capability.js';
import { resolveSessionContext } from '../../src/core/session-marker.js';
import { findOnlineDaemon, listOnlineDaemons as listOnlineDaemonsIn, resolveDaemonIpcPort, type OnlineDaemonInfo } from '../../src/utils/daemon-discovery.js';
import { normalizePluginIdList } from '../../src/core/plugins/ids.js';
import { bakedBinaryVersion } from '../../src/utils/install-info.js';
import { readGlobalConfig } from '../../src/global-config.js';

/** Deviation #2 (see header): this snapshot lives under test/fixtures/. */
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ─── botmux user-prompt-hook ─────────────────────────────────────────────────
//
// Claude 家族 UserPromptSubmit hook 客户端（#794 P1 方向 B）。按 stdin 里
// `prompt` 的内容指纹，经 daemon IPC 向宿主 claim/pop 该轮的 per-turn envelope
// （reminder/whiteboard），以 additionalContext 注入为该轮 system-reminder。
//
// 为什么走 IPC 而不是直接读文件（review HIGH-1/HIGH-2）：
// - HIGH-2：`prompt-ctx/<sid>` 在沙箱里是 read-only bind，hook 子进程在沙箱内
//   unlink 必失败，「读后消费」形同虚设。消费（pop）改到宿主 daemon 执行。
// - HIGH-1：宿主按 managedTurnOrigin.turnId 权威 turn 绑定精确取，不用 FIFO 猜。
//   某轮漏 claim 只孤儿化自己那条，不串轮到后续轮；上一轮的 stale sidecar 永远
//   不会被返回，因此也不需要 inline 文本启发式防双注入。
//
// 鉴权双路径（与 /close、/slash 同构）：能读 host secret（非沙箱）走 HMAC；
// 读不到（沙箱/read-isolation）带本会话 rotating per-turn capability。
//
// fail-open 铁律：任何失败（env 缺失 = 非 botmux 会话、daemon 不可达、未命中 =
// 用户手输或 inline 模式、403/404）都空输出 + exit 0。绝不 exit 2（会阻塞该轮
// prompt），绝不抛错（Claude 对 hook 失败的兜底是放弃注入，正合预期）。
/**
 * 自限时读完 stdin（原始字节）。Claude 写完 hook / statusline payload 会关 stdin，
 * 正常情况下立即结束；万一上游不关管道，也不能挂住子进程（settings.json 里的 hook
 * timeout 是第二道）。超时 / 读不到 ⇒ 返回已收到的部分（可能为空），从不抛错。
 * user-prompt-hook 与 statusline 共用。
 */
async function readStdinWithTimeout(ms: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  try {
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.stdin.destroy(); } catch { /* */ } }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    for await (const chunk of process.stdin) {
      if (timedOut) break;
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    clearTimeout(timer);
  } catch { /* stdin 读不到 → 返回已收到的部分 */ }
  return Buffer.concat(chunks);
}

/**
 * Resolve the session data directory.
 * Priority: SESSION_DATA_DIR env > daemon breadcrumb (~/.botmux/.data-dir) > default (~/.botmux/data)
 */
function resolveDataDir(): string {
  return resolveBotmuxDataDir();
}

type DaemonDescriptorLite = OnlineDaemonInfo;

/** Daemon discovery is `utils/daemon-discovery`; the CLI used to carry its own
 *  copy of the descriptor parse and the 90s staleness cutoff. These two
 *  wrappers only pin it to THIS process's resolved data dir, so the liveness
 *  probe and the session store always read the same directory. */
function listOnlineDaemons(): DaemonDescriptorLite[] {
  return listOnlineDaemonsIn(resolveDataDir());
}

function findDaemon(larkAppId?: string): DaemonDescriptorLite | null {
  if (larkAppId) return findOnlineDaemon(larkAppId, resolveDataDir());
  return listOnlineDaemons()[0] ?? null;
}

// ─── 会话作用域信号投递（session-ready / turn-idle 共用） ──────────────────────
//
// 两条信号同构：会话归属只靠子进程继承的 env（worker spawn 时设的
// BOTMUX_SESSION_ID / BOTMUX_LARK_APP_ID）。鉴权双路径：能读 host secret（非沙箱）
// 走 HMAC；读不到（沙箱 / read-isolation）带本会话 rotating per-turn capability。
//
// Host sessions discover the owning daemon through its descriptor. Linux bwrap /
// read-isolated sessions deliberately cannot read that directory, so use the
// worker-injected loopback port as a fallback. The port is not a credential: the
// route still verifies the rotating per-turn capability carried below.
//
// fail-open 铁律：env 缺失（adopt / 非 botmux 会话）、daemon 不可达、未授权一律
// 静默返回 —— 绝不挂死 CLI 的启动或回合结算（worker 侧各有兜底）。
//
// payload 是路由专属字段；sessionId 与 origin* 凭据/身份由本函数统一填。origin*
// 同 session-ready：turnId 取 worker 发布的 active-turn marker（不可读时回落 env），
// 它是**上报者声明的**回合身份，不是凭据 —— capability 才是凭据。
async function postSessionScopedSignal(
  route: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const sessionId = process.env.BOTMUX_SESSION_ID;
  const larkAppId = process.env.BOTMUX_LARK_APP_ID;
  if (!sessionId || !larkAppId) return;
  try {
    let discoveredPort: number | undefined;
    try { discoveredPort = findDaemon(larkAppId)?.ipcPort; } catch { /* masked/unreadable registry */ }
    const ipcPort = resolveDaemonIpcPort(
      discoveredPort,
      process.env.BOTMUX_DAEMON_IPC_PORT,
    );
    if (!ipcPort) return;
    const relayDir = process.env.BOTMUX_SEND_RELAY;
    const originCapability = readManagedOriginCapability(
      resolveDataDir(),
      sessionId,
      relayDir,
      process.env.BOTMUX_ORIGIN_CHANNEL_ID,
    )?.capability;
    const liveOrigin = resolveSessionContext(resolveDataDir(), sessionId);
    const envAttempt = Number(process.env.BOTMUX_DISPATCH_ATTEMPT);
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        originCapability,
        originTurnId: liveOrigin?.turnId ?? process.env.BOTMUX_TURN_ID,
        originDispatchAttempt: liveOrigin?.dispatchAttempt
          ?? (Number.isSafeInteger(envAttempt) && envAttempt > 0 ? envAttempt : undefined),
        ...payload,
      }),
    } satisfies RequestInit;
    let hostSecret: string | undefined;
    if (!relayDir) {
      try { hostSecret = loadDaemonIpcSecret(); } catch { /* Seatbelt/read-isolated CLI */ }
    }
    if (!hostSecret) {
      await loopbackFetch(`http://127.0.0.1:${ipcPort}${route}`, init);
    } else {
      await fetchDaemonIpc(ipcPort, route, init, hostSecret);
    }
  } catch { /* daemon 不可达 → 放弃，worker 走超时兜底 */ }
}

// ─── botmux turn-idle ─────────────────────────────────────────────────────────
//
// CLI 进程内的**结构化回合空闲**上报客户端。当前唯一调用方是 dsh-tui 的 cordis
// wrapper 插件：`agent/status` 落到 idle（一个回合真正结束）时执行
// BOTMUX_TURN_IDLE_COMMAND，即本子命令。插件把小 JSON（seq/pid，纯诊断）写在
// stdin 上；本命令把「上报者读到的活动回合」与 rotating per-turn capability 一起
// POST 给 owning daemon，daemon 再转给 worker —— worker 侧用 turn/代际 fence 决定
// 是否 fireIdle()（见 utils/turn-idle-report.ts）。
//
// 与 session-ready 同一条 fail-open 铁律：env 缺失 / daemon 不可达 / 未授权都静默
// exit 0，绝不产生用户可见输出，也绝不阻塞回合结算。丢一次上报只是让这一轮退回既有
// 兜底路径，绝不误判成空闲。
async function cmdTurnIdle(): Promise<void> {
  const payloadText = (await readStdinWithTimeout(2000)).toString('utf-8');
  let seq: number | undefined;
  let pid: number | undefined;
  try {
    const parsed = JSON.parse(payloadText);
    if (parsed && Number.isSafeInteger(parsed.seq) && parsed.seq > 0) seq = parsed.seq;
    if (parsed && Number.isSafeInteger(parsed.pid) && parsed.pid > 0) pid = parsed.pid;
  } catch { /* 无 payload / 非 JSON → 只上报回合身份 */ }
  await postSessionScopedSignal('/api/turn-idle', { seq, pid });
  process.exit(0);
}

let pluginRegistryCache: import('./core/plugins/types.js').PluginRegistryFile | null = null;
function readPluginRegistryCached(): import('../../src/core/plugins/types.js').PluginRegistryFile {
  if (pluginRegistryCache) return pluginRegistryCache;
  // Synchronous top-level dynamic import is not available; this function is
  // only used after cmdPlugin has loaded the registry into the cache.
  throw new Error('plugin_registry_cache_not_loaded');
}

async function loadPluginRegistryForCommand(): Promise<import('../../src/core/plugins/types.js').PluginRegistryFile> {
  const { readPluginRegistry } = await import('../../src/services/plugin-registry-store.js');
  pluginRegistryCache = readPluginRegistry();
  return pluginRegistryCache;
}

function printPluginUsage(): void {
  console.log(`用法:
  botmux plugin list
  botmux plugin init <plugin-id|botmux-plugin-id|@botmux-ai/plugin-id>
  botmux plugin install <npm-package|local-dir> [--link]
  botmux plugin uninstall <plugin-id> [--force]
  botmux plugin enable <plugin-id> [--bot <name|index|all>]
  botmux plugin disable <plugin-id> [--bot <name|index|all>]
  botmux plugin emit <plugin-id> --bot <process-name|app-id>  # JSON 从 stdin 读取
  botmux <plugin-command> [args...]
  botmux plugin service status
  botmux plugin service start [plugin-id|--all]
  botmux plugin service stop [plugin-id|--all]
  botmux plugin service restart [plugin-id|--all]
`);
}

async function runPluginCommandByName(rawCommand: string, commandArgs: string[]): Promise<boolean> {
  const sessionId = process.env.BOTMUX_SESSION_ID?.trim();
  const { readSessionPluginManifest } = await import('../../src/core/plugins/session-manifest.js');
  const pluginIds = sessionId
    ? readSessionPluginManifest(sessionId)?.pluginIds ?? []
    : normalizePluginIdList(readGlobalConfig().plugins) ?? [];
  if (pluginIds.length === 0) return false;
  const { collectPluginCliCommands } = await import('../../src/core/plugins/runtime.js');
  const commands = await collectPluginCliCommands(pluginIds);
  const matches = commands.filter(command => command.name === rawCommand);
  if (matches.length === 0) return false;
  if (matches.length > 1) {
    console.error(`❌ 插件 CLI 命令冲突: ${rawCommand}`);
    console.error(`   冲突插件: ${matches.map(command => command.pluginId).join(', ')}`);
    console.error('   请禁用其中一个插件，或让插件作者改用唯一 command 名称。');
    process.exit(1);
  }
  const command = matches[0];
  const registry = await loadPluginRegistryForCommand();
  const record = registry.plugins[command.pluginId];
  const { pluginRuntimeDir } = await import('../../src/core/plugins/paths.js');
  const result = await command.run({
    runtime: 'cli',
    pluginId: command.pluginId,
    pluginDir: pluginRuntimeDir(command.pluginId),
    packageName: record?.packageName ?? command.pluginId,
    version: record?.version ?? '0.0.0',
    manifest: record?.manifest ?? { schemaVersion: 1, id: command.pluginId },
    args: commandArgs,
  });
  if (typeof result === 'string') console.log(result);
  if (typeof result === 'number') process.exitCode = result;
  return true;
}

function getVersion(): string {
  // The compiled single-file executable has no package.json on disk (the module
  // graph is in the virtual read-only /$bunfs), so this read always failed there
  // and `--version` printed `unknown`. The build bakes the version in instead.
  const baked = bakedBinaryVersion();
  if (baked) return baked;
  const pkgPath = join(PKG_ROOT, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const SEND_HELP_BODY = [
  '  send [content]                       发消息到当前话题（支持 stdin / --content-file）',
  '       --help, -h                      打印本帮助并退出',
  '       --images <path>                 内联图片（可重复）',
  '       --image-mode <mode>             独立单图：fit_horizontal（默认）|medium|small|tiny',
  '                                      medium/small/tiny 等比占宽 1/2、1/3、1/4，完整显示不裁剪',
  '       --files <path>                  附件（可重复）',
  '       --videos <path>                 视频预览 MP4（可重复，需配套 --video-covers）',
  '       --video-covers <path>           视频封面图片（可重复，按顺序对应 --videos）',
  '       --card-file <path>              直接发送飞书/Lark interactive 卡片 JSON',
  '       --card-json <json>              直接发送飞书/Lark interactive 卡片 JSON 字符串',
  '       --dry-run                       不发送：把正文按卡片渲染后输出 JSON 与告警，用于发送前自查',
  '                                      （只渲染正文；不上传图片/附件、不解析 @、不加页脚）',
  '    图表：正文里的 ```vega-lite 代码块会渲染成飞书原生图表（柱/条/折线/面积/散点/饼）。',
  '      只接受 data.values 内联数据（≤500 行）；url/transform/expr/params 等会被拒绝。',
  '      不支持的写法降级为一行说明 + 原始数据表，并在 stderr 给出原因。',
  '       --plugin-card-action <plugin-id>',
  '                                       显式允许该已启用插件声明的 callback action',
  '       --layout result|progress|risk|blocked|handoff',
  '                                       可选回复卡卡头薄壳；只在关键结果/进度/风险/阻塞/交接节点显式使用',
  '       --response-kind progress|final|auxiliary  可选；未声明按 progress/非 final，只有 final 挂反馈与页脚签名',
  '       --expected-link <url>           要求最终渲染正文原样包含该 URL（可重复）；缺失时在任何外部副作用前拒发',
  '       --as independent|suggestion     对方任务正在跑时声明处理方式：另开任务 / 留给当前任务',
  '       --mention <id:name>             @提及（可重复）。id 默认是 open_id；bot 配置开启',
  '                                       allowArbitraryMention 后也可传完整邮箱/手机号/union_id，',
  '                                       自动解析并校验其为目标群成员，否则拒发',
  '       --mention-back                  @回本轮触发消息的发送者（open_id 自动取自会话）',
  '       --no-mention                    明确声明本条不@任何人',
  '       --quote <message_id>            指定引用某条消息（普通群，默认引用本轮触发消息）',
  '       --no-quote                      不引用，发独立消息（普通群）',
  '       --voice "<口语文字>"            合成语音气泡发出（需先 botmux voice 配置 TTS）',
  '       --top-level                     发顶层消息（不回复进当前话题）',
  '       --chat-id <oc_xxx>              指定目标群（默认当前话题所在群）',
  '       --attention[=kind]              举手：发消息的同时把本会话标进 dashboard',
  '                                       「需要你」列并通知你——撞到只有你能解的硬阻碍',
  '                                       （授权/拍板/缺权限）无法继续时用。消息正文即看板',
  '                                       原因。kind=authz|decision|blocked(默认)|help。',
  '                                       仅限回复当前会话，不能与 --top-level/--chat-id/--into',
  '                                       /--voice 混用；用户回复后自动撤下。',
  '       --urgent[=app|sms|phone]        加急本轮触发者，须与 --mention-back 同用。',
  '                                       默认 app（应用内）；sms/phone 会消耗租户额度。',
  '                                       主消息已发出后加急失败不会重发消息。',
  '       --anyway                        跳过「@ 到活跃子 bot」护栏强发（见下）',
  '    @ 硬门：每条回复须三选一 --mention/--mention-back/--no-mention，否则报错不发。',
  '    按内容价值选：有实质结论要对方看/确认/决策→--mention-back(或--mention点名)；',
  '    纯记录/低优先级进度/简短确认→--no-mention；没信息量的"收到"不如不发。',
  '    Bot→Bot 默认进入 Queue；要显式调整对方活跃的 Codex App turn，把 @steer 写成',
  '    正文首个语义行（可放在收件人 @ 行之后）。接收端会消费该指令，不交给模型。',
  '    （可设 BOTMUX_REQUIRE_MENTION_DECISION=false 关闭硬门）',
].join('\n');

function showHelp(): void {
  console.log(`
botmux v${getVersion()} — IM ↔ AI 编程 CLI 桥接

命令:
  setup       交互式配置（首次使用 / 添加机器人）
              默认使用 botmux 内置 Feishu Web QR 登录尝试自动导入权限/redirect/发布版本；可加 --no-open-platform-auto 跳过
  clone <机器人名> [--name <新名称>]
              创建新应用并复制该机器人的行为配置；留空名称自动使用 源名称-copy-时间戳
  start       启动 daemon，并启动 mode=auto 的插件 service
              可用 --companion-secret-file <绝对路径> --companion-bot <appId> 开启封闭本机 Companion API
  stop        停止 daemon（默认不停止插件 service；--with-plugin 显式停止 mode=auto 的插件 service）
  restart     重启 daemon（同样接受 --companion-secret-file / --companion-bot；--with-plugin 显式先停再启动 auto service）
  logs        查看/跟随 daemon 日志（--lines N, --bot <0-based-index|name|appId>, --no-follow 只打印不跟随）
  sandbox-network-policy check <JSON文件> | set <appId> <JSON文件> | clear <appId>
              配置 Linux 本地 PTY oncall 公网/内网目标 IP 策略，下个新会话生效
  model-proxy serve --config <path>
              启动有鉴权的本机模型协议入口（Chat Completions 子集）
  env-policy get|set <JSON>|unset [--bot <name|appId>]
              查看或配置本 bot 的进程环境继承（仅显示模式/变量名）
  status      查看 daemon 状态
  upgrade     升级到最新版本（别名：update）
              支持可选 target：canary / beta / rc 等频道，或具体版本号（默认 latest）
  dashboard current
              获取当前 Web Dashboard 登录 URL（裸 \`dashboard\` 同义；没有则创建）
  dashboard rotate
              显式轮换 token，并打印新的登录 URL
  device enroll|status|logout
              在宿主终端注册、查看或清除 desktop device 凭证（AI CLI 会话内拒绝）
  actor current --json
              返回当前 BotMux turn 的已验证企业用户名，不暴露 open_id/邮箱；脱离当前进程树时拒绝
  execution current --json
              只读核验当前进程所属的 bot/session/turn、执行尝试和 Worker 代次
  auth request [--scope "<scope1 scope2,...>"] [--json]
              为本轮发起人生成飞书授权链接，返回 JSON；由 Agent 将链接发给用户
  auth wait --request-id <id> [--json]
              等待当前授权请求就绪，最多 5 分钟；成功后可重试原操作
  mojo-containment list|revoke
              查看 / 显式撤销无法自证静止的 mojo containment handle（设备隔离
              blocker 的可审计操作员出口；revoke 需 --yes，存活证据需 --force）
  turn-send-ledger inspect|resolve
              查看文档评论分块投递账本；人工核实 provider 响应未知的分块后，
              用 resolve --outcome delivered|not-delivered --yes 恢复后续重试
  list        列出活跃会话（交互式选择并连接 tmux）
              --plain  纯文本表格输出（管道/脚本场景）
  observe [--session <id>] [--lark-app <appId>] [--include-raw]
              通过 daemon 实时 IPC 输出 canonical worker/session JSON；失败保持 unknown，不回退缓存
  interaction-context --bot <appId> --session <id> [--actor <openId>]
              宿主只读查询真实会话来源及当前回答权限（不恢复会话）
  delete <id>      关闭指定会话（支持 ID 前缀匹配）
  delete all       关闭所有活跃会话
  delete stopped   清理所有进程已退出的僵尸会话
  resume <id>      恢复一个已关闭的会话（支持 ID 前缀匹配）— 远程后端立即启动恢复，
                   本地后端在下条消息时以 --resume 重新拉起 CLI 进程
  suspend <id|all>     挂起活跃会话：杀 CLI/pane 但会话保持 active，下条消息冷启动续上下文
       --bot <appId>   挂起该 bot 的全部活跃会话
       --isolated      挂起所有读隔离 bot（凭证轮换后用；下次冷启动自动同步最新凭证）
       --dry-run       只列出目标，不执行
  slash "<斜杠命令>"   会话空闲后向本会话 CLI 注入一条原生斜杠命令（需 bots.json 配 tuiSlashAllow；/cd 恒被拒）
  role switch <目录>  （会话内）切换本话题到角色库内的角色目录——角色切换用；
                   目录必须位于 ~/botmux-roles 之下
  term-link [id]   获取活跃会话的「可操作终端」（带写 token）。不回显链接，改由
                   daemon 把可操作卡片私密发给 owner（群内仅你可见，话题/单聊回退 DM）。
                   单个活跃会话可省略 id
  preview <port>   （会话内）注册当前会话已启动的本机 Web 服务；Dashboard 登录后通过
                   同源 /preview/<sessionId>/ 访问，不暴露本机地址或任何 token。
                   端口必须由本会话的进程持有（在会话内直接启动，别 setsid/nohup
                   脱离进程树）；换代/关闭后需重新注册，远端 sandbox 后端不支持
  tabs list|add|update|remove|sort
                   查看和管理当前飞书群标签页；add 按 URL 幂等，适合后台自动化调用
  continuation start
                   （实验性）功能开关启用时，TraeX 普通用户轮默认自动开启授权继承续跑；
                   start 可在取消后重新开启，并设置 --ttl-minutes N / --max-continuations N，
                   另有 await-user / cancel
  autostart enable     注册开机自启（macOS launchd / Linux user systemd / Windows Task Scheduler，无需 sudo）
  autostart disable    注销开机自启
  autostart status     查看自启状态
  worker-budget status 查看 worker 内存准入来源、阈值与 session scope 能力
       set             设置 --memory-admission-enabled true|false / --min-available-mib /
                       --max-memory-full-avg10 / --session-memory-max-mib
       unset           清除 worker 内存策略覆盖
  lang [zh|en]         切换 UI 语言（无参 = 查看当前设置）
       --bot N         仅改 bots.json 中第 N 个 bot 的 lang
       --unset         清除（global 或 --bot N 配合）
  voice                配置语音总结（高级功能，独立于 setup）— 交互式填 TTS 引擎+凭证
       voice status    查看当前语音配置（凭证打码）
       voice disable   关闭语音功能（移除配置）
       voice asr       配置语音识别（飞书语音消息→文字驱动会话）
       voice asr status|disable   查看 / 关闭 ASR
  vc-agent tat-gate|poll
                       飞书会议智能体 P0：校验 TAT 会中事件读取、轮询会议事件并触发 workflow
  plugin              管理 botmux 插件
       plugin init <id>
                       基于官方模板创建 botmux 插件仓库
       plugin install <npm-package|local-dir>
                       安装并校验 botmux 插件；不执行插件代码、不启动 service
       plugin enable <id>
                       启用插件给指定 bot 或全局默认；不影响 host service
       plugin disable <id>
                       禁用插件引用；不影响 host service
       插件 CLI 命令使用一级命令形式：botmux <command> [args...]
                       只从全局 enabled 插件中查找
       plugin service status|start|stop [id|--all]
                       查看/管理插件 host service
  whiteboard status|enable|disable
                       本地项目白板（默认关闭；enable 只打开能力，不创建白板）
       current --create / list / read / update / write --yes

定时任务（可在 CLI 会话内自动推断 chat）:
  schedule list                        列出所有任务
  schedule add <schedule> <prompt>     添加任务（ex: "30m" / "every 2h" / "每日9:00" / "0 9 * * *"）
       --calendar <name>               绑定内置或自定义工作日历；手动执行绕过
       --calendar-day-type <type>      workday 仅工作日（默认）；restday 仅休息日
       --model <id>                    本任务用指定模型跑（如 gpt-5.6-sol），不改 bot 配置
       --reasoning-effort <level>      low|medium|high|xhigh|max|ultra（模型支持才生效）
                                       两者都只在本任务新建会话那次执行生效；配 --new-topic 则每次生效
       --top-level                     在群消息顶层执行（后续会话形态跟随普通群会话模式）
       --topic --root-msg-id <om_...>  固定在指定话题下执行
       --follow-active                 上次落点话题没关就投那里；关了投本群里人最近说话的话题；都没有就新开顶层话题（起点＝当前话题或 --root-msg-id）
       --new-topic [--topic-title ...] 每次创建新话题和独立会话
       --silent                        静默执行：不发「执行中」提示，模型判断是否 botmux send 报警
  schedule update <id> --prompt-file FILE  原地更新提示词，保留任务与执行安排
  schedule remove <id>                 删除任务
  schedule pause|resume <id>           暂停/恢复
  schedule run <id>                    标记立即执行

飞书消息（在 CLI 会话内自动推断 session）:
  chat rename <新群名称>               修改当前会话所在群的名称
       --proactive                    标记为 AI 主动改名（应用 10 分钟防抖）
${SEND_HELP_BODY}
  card patch --message-id <om_xxx> (--card-file <path> | --card-json <json>)
                       原地更新之前用 send --card-file/--card-json 发出的自定义卡片
                       （不发新消息、不换群/话题）；messageId 取自 send 成功输出的 .messageId，
                       卡片安全校验与 send 相同；[--session-id <sid>] 可手动指定会话
  card stream open|write|snapshot|reanchor|bind-runtime|unbind-runtime|finish ...
                       CardKit 原生文本流式更新与 daemon 运行状态绑定；详见 botmux card stream --help
  bots list                            列出当前群聊中的机器人（含 open_id）
  bots invite --chat <chatId> --team <id> --agent <appId>...
                                       往「已存在的团队群」补人：把同团队、已 opt-in 的 agent + 各自 owner 一起拉进；
                                       详见 \`botmux bots invite --help\`
  history [--limit N] [--scope session|thread|chat|ambient] [--with-card-json]
                                       拉取当前会话的消息历史 (JSON)。默认按 session scope：话题/话题群 → 话题内，普通群 → 整群；
                                       thread 会话里可用 --scope ambient 读取 thread 外的群聊上下文；
                                       --with-card-json 为每张卡片附原始结构化 JSON（消息均带 resources 附件 key）
  quoted <message_id> [--raw]          按消息 id 拉取单条消息 (JSON) 并下载附件到本地；id 取自引用提示行或 history 输出，
                                       --raw 附原始内容（卡片 → cardJson，其它 → rawContent）
  input-capture register|inspect|revoke|revoke-set --bot <appId> --session <id> ...
  ask buttons --questions-file <file>   多题卡片，支持 defaultSelectedKeys 预选；底部提交，返回 JSON
  ask buttons [--multi] --options "a,b" "<问题>"
                                       把选择题做成按钮卡片抛给飞书；--multi 返回逗号分隔的多个 key
                                       （无 hook 的 CLI 用它把决策引到人；也可省略 buttons 走裸别名）
  skill list                           列出本会话可用的技能（用户自定义 + botmux 内置）及其描述
  skill show <name>                    读取某技能的完整 SKILL.md 说明（prompt 注入模式下按需拉取内置技能全文）

编排 / workflow（v3）:
  goal run <goal> [--run-id <id>] [--bot <id|name>] [--working-dir <dir>]
                  [--timeout <seconds>] [--json]
                                       在现有 v3 沙箱/worker 路径运行一个 headless goal；
                                       同一 run-id 可安全重放终态或接续崩溃运行
  workflow save [last|runId] [名称]
                                       把成功 run 固化为 chat scope Saved Workflow；
                                       发布当前 Bot 全局版本 / 确认 unsafe lint 请由用户在飞书显式发送 /workflow save ...
  workflow run <名称|workflowId> [--param key=value ...]
  workflow list [--json] | show <名称|workflowId>
                                       运行 / 查看 Saved Workflow
  workflow new|spec-finalize|approve-spec|revise-spec|architect|revise-dag [...]
  workflow approve-dag|start [...]     创建、修订并运行一次性即兴 Workflow
  workflow cancel <runId> [--reason <text>] [--bot <larkAppId>]
                                       持久化取消 v3 run 并中断活动节点
  workflow retry|grant [...]           处理受阻节点 / loop
  template migrate-v3 [id|path ...] [--all] [--commit ...]
                                       v2 定义迁移：默认 dry-run，写入需显式 owner/app/scope
  template archive-runs [--commit|--verify <archive>|--retire <archive> --ack-daemon-stopped]
                                       v2 历史 run 私有静态归档；retire 在维护窗双验后原子迁入 quarantine
  （完整参数见 \`botmux workflow help\` / \`botmux template help\`）
  session create|start|run|send|wait|result|list|bind|publish
                                       自动化会话接口：后台运行、查询结果、
                                       并按需发布/绑定到群或话题
  dispatch --bot <name> [...]          多话题编排：开子话题并把 bot 派进去（详见 \`botmux dispatch --help\`）
  report [...]                         交接 Review / 进展 / 结果并继承会话位置（详见 \`botmux report --help\`）
  project init|status|update|close|resume [...]
                                       普通群项目控制面与置顶进度卡（详见 \`botmux project --help\`）

新建飞书群:
  create-group --bot <name> [--bot ...] [--name "群名"] [--chat-mode group|topic]
                                       用指定 bot 起新群（--chat-mode topic 建话题群）；详见 \`botmux create-group --help\`

精确群对话授权（talk-only）:
  grant chat --bot <receiver> --chat-id <oc_...> --subject-bot <larkAppId>
                                       授权群内 Bot 与 receiver 对话，不授管理命令权；
                                       revoke/readback 详见 \`botmux grant chat --help\`

预设分享（导出某 bot 的可分享配置给同事，绝不含密钥）:
  preset export <bot> [--from-chat <chatId>] [--out <file>] [--yes]
                                       导出 cliId/model/角色/能力标签 + 接入指引；
                                       默认 team 级角色，--from-chat 取某群角色内容；
                                       缺省写 ./<name或appid>.botmux-preset.json，--out - 走 stdout

botmux skills 注入方式（仅影响 codex/gemini/opencode 等只支持全局 skills 目录的 CLI）:
  skills injection [global|prompt|off]  查看/设置机器级默认（无参=查看）
       prompt（默认）  不落全局盘，把技能目录注入进会话 prompt，按需 \`botmux skill show\`——
                       不会泄漏到你手动跑的 codex/gemini
       global          装进 CLI 全局 skills 目录（体验原生，但独立 CLI 也会看到）
       off             只留路由提示 + \`botmux --help\`，让模型自行摸索
  （per-bot 可在 bots.json 用 "skillInjection" 字段覆盖机器级默认）

提示: 多数子命令支持 \`botmux <子命令> --help\` 查看完整参数。

配置目录: ~/.botmux/
文档: https://deepcoldy.github.io/botmux/
`);
}

// ─── Root dispatch — verbatim `case 'turn-idle'` and `default:` branches ──────
const command = process.argv[2];

switch (command) {
  case 'turn-idle': {
    // `botmux turn-idle` — CLI 进程内结构化回合空闲上报客户端（dsh-tui 的 cordis
    // wrapper 插件在 agent/status 落到 idle 时执行）；worker 侧做回合 fence。
    await cmdTurnIdle();
    break;
  }
  default:
    if (!await runPluginCommandByName(command, process.argv.slice(3))) showHelp();
    break;
}
