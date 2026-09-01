// 平台隧道客户端（跑在 dashboard 进程里，每台机器一个）。
// 对中心化平台保持一条出站控制 WebSocket；平台需要展示本机 dashboard 时，
// 下发 open-stream，本端拨一条数据连接回去、裸桥接到本地 dashboard 端口。
import net from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { WebSocket, type RawData } from 'ws';
import { setPlatformTeams, clearPlatformBinding, type PlatformBinding, type PlatformTeam } from './binding.js';

/** 本机一个 botmux bot 的概要（上报给平台，供团队页「人→机器→bot」展示 + 拉群）。 */
export interface PlatformBotInfo {
  appId: string;
  openId: string | null;
  name: string;
  avatar?: string;
  cli?: string;
  /** 团队页是否展示这个 bot（默认 true，按 bot 配置 showInTeam 上报）。 */
  showInTeam?: boolean;
  /** bot 自己的租户稳定 union_id（自家消息回声学到，见 bot-union-ids-store）。
   *  平台按团队聚合成 roster 随 team-sync 下发，成员机器据此免 /grant 互信。 */
  unionId?: string;
  /** 团队维度 Agent 互查（additive，交接契约）：owner 预配的专长标签，
   *  发现/拉群的匹配依据。**agent 自报 → 仅展示、不可信**，绝不当能力凭据。
   *  不报 = 空默认值（平台侧 additive 接受）。 */
  specialties?: string[];
  /** 是否有飞书传输身份能被 @（core-only/apiOnly → false）。**自报 → 仅展示、不可信**。 */
  mentionable?: boolean;
  /** Release/debug hint only; compatibility is decided by a2aCapabilities. */
  botmuxVersion?: string;
  /** Machine-readable protocol set supported by the bot's deployment. */
  a2aCapabilities?: string[];
}

/** 平台 team-sync 下发的原始负载（校验/落盘在 platform-team-store）。 */
export interface PlatformTeamSyncMessage {
  rev: string;
  teams: unknown[];
}

export interface TunnelClientOptions {
  binding: PlatformBinding;
  /** 实际绑定的 dashboard 端口（探测后可能与配置不同） */
  getDashboardPort: () => number;
  /** 当前 dashboard token（会轮转，每次读最新） */
  getDashboardToken: () => string | null;
  getVersion: () => string;
  /** Protocol capabilities supported by this deployment. */
  getA2ACapabilities?: () => readonly string[];
  /** 本机的 bot 清单（每次读最新；随心跳上报） */
  getBots?: () => PlatformBotInfo[];
  /** 本机已应用的 team-sync rev（每次读最新；随 register/heartbeat 上报，平台
   *  据此做版本比对：不一致才下发全量 team-sync）。 */
  getTeamSyncRev?: () => string;
  /** 平台下发 team-sync（团队 bot roster + 团队群清单）时回调；落盘与公告由
   *  dashboard 侧处理，tunnel-client 只做传输。 */
  onTeamSync?: (payload: PlatformTeamSyncMessage) => void;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const HEARTBEAT_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// 数据流拨号：并行拨号（happy-eyeballs）。某些部署到平台 LB 某几个 VIP 的链路对新流 ~50% 丢——
// 坏的 ECMP 分支「静默黑洞」（不回包、抓包实锤 ClientHello 无响应），好连接 ~90ms 就回。串行「拨一条
// →黑洞等满超时→再拨」冷启动要赌好几秒；改成每波**并行拨几条、谁先到用谁、其余丢弃**：
//  - 每波并行 DATA_DIAL_PARALLEL 条：~50% 单条成功率下，3 条里有 1 条好的概率 ~87.5% → 通常 ~90ms 就建好。
//  - 单条超时 3s（生产 TLB/TLS 握手可到 ~1.2s，需留足余量）；一波全黑洞才进下一波，最多 DATA_DIAL_MAX_WAVES 波。
//  - 用完即弃、不常驻空闲连接（区别于「预热连接池」，不随机器数堆连接，可扩展）。
//  - 平台对同一个 streamId 只 attach 第一条到的、其余自动 4004 关，协议无需改。
//  - 配合平台连接池：建好的好连接会被复用，拨号（赌）只在冷启动/扩容发生，不是每请求。
const DATA_DIAL_TIMEOUT_MS = 3_000;
const DATA_DIAL_PARALLEL = 3;
const DATA_DIAL_MAX_WAVES = 2;
const DATA_DIAL_WAVE_BACKOFF_MS = 150;
const DATA_DIAL_OVERALL_DEADLINE_MS = 8_000;

// 桥接的 WebSocket 侧背压水位：本地 dashboard 读得比平台链路发得快时（下载、长日志），
// 未确认送达的字节超过这个水位就暂停 TCP 读取，等确认后继续。`pipe()` 原来替我们管背压，
// 手写事件桥接（见 bridgeDataChannel()：Bun 不支持 createWebSocketStream）就必须自己管，
// 否则大响应会在内存里堆帧。
const WS_BACKPRESSURE_BYTES = 4 * 1024 * 1024;

// 背压确认用的 ping 间隔：超水位后每隔这么久探一次「平台真的收下了吗」。
// 取值权衡：太小则空转 ping，太大则恢复迟钝、拉长大响应的总时长。
const WS_BACKPRESSURE_PROBE_MS = 20;

// 本地 dashboard FIN 后，等 WebSocket 把已排队的帧刷完并收到对端 close 的上限；
// 到点仍未收到就硬收尾，别把 socket 永久挂着。
const WS_CLOSE_FLUSH_TIMEOUT_MS = 30_000;

// 控制连接并行拨号（happy-eyeballs）：一轮并行拨几条、谁先握手成功用谁，兜住入口 VIP 对新建连接
// ~35% 的黑洞。单条超时给足 TLS 握手时间（好连接 ~40ms，黑洞则等满超时判负）。
const CONTROL_DIAL_PARALLEL = 3;
const CONTROL_DIAL_TIMEOUT_MS = 5_000;
// 控制连接 WS 层保活：空闲时也定时 ping（保持链路有流量，避免被 LB/NAT idle 掐成半开）；
// 一个周期内没等到 pong 就判半死、terminate 触发重连（不用干等几分钟 TCP 超时）。
const CONTROL_PING_MS = 30_000;

// 本机可供平台服务端「直连反代」的候选地址（内网 IPv4:dashboardPort）。平台够得着就直连本机
// dashboard、绕过隧道（省掉 daemon 拨号/ECMP 赌/跨 pod 转发）；够不着自动退回隧道。仅内网地址、
// 服务端到服务端 HTTP，不涉浏览器 mixed content。
function localDirectHosts(port: number): string[] {
  const out: string[] = [];
  try {
    for (const list of Object.values(networkInterfaces())) {
      for (const ni of list || []) {
        if (ni.family === 'IPv4' && !ni.internal && ni.address) out.push(`${ni.address}:${port}`);
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

export interface TunnelClientHandle {
  stop(): void;
}

export function startPlatformTunnelClient(opts: TunnelClientOptions): TunnelClientHandle {
  let stopped = false;
  let ws: WebSocket | null = null;
  // 当前一轮控制连接并行拨号中「在拨/在等」的候选（胜出/停止时用于清理）。
  let controlDials: Set<WebSocket> | null = null;
  let heartbeat: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoff = BACKOFF_MIN_MS;
  // 本机平台团队（成员关系下沉到部署本地）
  let teams: PlatformTeam[] = opts.binding.teams ? [...opts.binding.teams] : [];

  const base = wsBase(opts.binding.platformUrl);
  const tokenQ = encodeURIComponent(opts.binding.machineToken);

  // 控制连接并行拨号（happy-eyeballs）。入口 VIP 对「新建连接」丢包很高（实测 ~35%，TLS 握手黑洞、
  // 非 SYN 层），单发+退避会反复撞黑洞、迟迟连不上 → 用户以为「连不上要 restart」。改成一轮并行拨
  // CONTROL_DIAL_PARALLEL 条、谁先握手成功用谁、其余 terminate；一整轮全败才按 backoff 重连。
  // ~60% 单条成功率下，3 条并行一轮成功率 ~94%，把「连不上」窗口从「撞黑洞×退避」压到一轮内。
  // 数据流早已这么做（openDataStream），这里给控制连接补上。
  function connect(): void {
    if (stopped) return;
    const url = `${base}/tunnel/control?token=${tokenQ}`;

    let settled = false; // 本轮已有胜者或已判负
    let pending = CONTROL_DIAL_PARALLEL;
    const dials = new Set<WebSocket>();
    controlDials = dials;

    const dropLosers = (winner: WebSocket | null): void => {
      for (const c of dials) {
        if (c === winner) continue;
        try { c.removeAllListeners(); } catch { /* ignore */ }
        // 关键：补一个吞异常的 error handler。对仍在 CONNECTING 的 ws 调 terminate() 会「异步」emit('error')
        //（"WebSocket was closed before the connection was established"）；上面刚把 error listener 摘了，
        // 没 handler 就成未捕获 'error' 事件把 dashboard 进程打挂 → 无限重连、平台侧 machine_offline。
        c.on('error', () => { /* swallow */ });
        try { c.terminate(); } catch { /* ignore */ }
      }
      dials.clear();
    };

    const onDialFail = (): void => {
      if (settled) return;
      if (--pending > 0) return; // 本轮还有在拨的，等它们
      settled = true; // 一整轮都没连上才判负，按 backoff 重连
      dropLosers(null);
      scheduleReconnect();
    };

    for (let k = 0; k < CONTROL_DIAL_PARALLEL; k++) {
      // 关掉 permessage-deflate：隧道是裸字节桥，承载的 HTTP 自己会 gzip，WS 层再压一遍既没收益、
      // 又会在经过中心化网关(TLB)时因压缩扩展协商被改写而触发 "RSV1 must be clear" 断流。
      const sock = new WebSocket(url, { perMessageDeflate: false });
      dials.add(sock);
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        dials.delete(sock);
        try { sock.terminate(); } catch { /* ignore */ }
        onDialFail();
      }, CONTROL_DIAL_TIMEOUT_MS);

      sock.on('open', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (settled) { try { sock.terminate(); } catch { /* ignore */ } return; } // 已有胜者 → 弃掉
        settled = true;
        dials.delete(sock);
        dropLosers(sock);
        // 摘掉建连期临时 listener，换上正式收发 handler
        try { sock.removeAllListeners('open'); } catch { /* ignore */ }
        try { sock.removeAllListeners('error'); } catch { /* ignore */ }
        try { sock.removeAllListeners('unexpected-response'); } catch { /* ignore */ }
        adoptControl(sock);
      });

      sock.on('unexpected-response', (_req, res) => {
        opts.log('隧道握手被拒', { status: res.statusCode });
        if (res.statusCode === 401) opts.log('机器 token 失效，请重新 botmux bind');
        if (done) return;
        done = true;
        clearTimeout(timer);
        dials.delete(sock);
        try { sock.terminate(); } catch { /* ignore */ }
        onDialFail();
      });

      sock.on('error', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        dials.delete(sock);
        try { sock.terminate(); } catch { /* ignore */ }
        // 建连期错误不逐条刷屏（撞黑洞是常态）；一整轮全败才由 scheduleReconnect 侧体现。
        onDialFail();
      });

      sock.on('close', () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        dials.delete(sock);
        // 建连期 close 可能不伴随 error；仍应把这条拨号计为失败，否则整轮会卡到超时。
        onDialFail();
      });
    }
  }

  // 采纳某条已握手成功的控制连接：重置重连退避、挂正式收发 handler、发 register、起心跳。
  function adoptControl(sock: WebSocket): void {
    ws = sock;
    controlDials = null;
    backoff = BACKOFF_MIN_MS;
    opts.log('隧道已连接平台');
    sendRegister(sock);
    heartbeat = setInterval(() => sendHeartbeat(sock), HEARTBEAT_MS);

    // WS ping/pong 保活 + 半开探测。心跳是 daemon→平台的单向应用消息，掩盖不了「平台→daemon 方向
    // 被 idle 掐断」；WS ping 由平台自动回 pong，双向都有流量→防 idle 掐断，且丢 pong 能快速判半开。
    let pongAlive = true;
    sock.on('pong', () => { pongAlive = true; });
    pingTimer = setInterval(() => {
      if (sock.readyState !== WebSocket.OPEN) return;
      if (!pongAlive) {
        // 上一周期的 ping 没等到 pong → 连接多半半开了，主动断开触发重连。
        opts.log('控制连接 ping 无 pong，判定半开，重连');
        try { sock.terminate(); } catch { /* ignore */ } // → 'close' → cleanupSock + scheduleReconnect
        return;
      }
      pongAlive = false;
      try { sock.ping(); } catch { /* ignore */ }
    }, CONTROL_PING_MS);

    sock.on('message', (data) => {
      let msg: { type?: string; streamId?: string; teamId?: string; teamName?: string; rev?: string; teams?: unknown[] };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (msg.type === 'open-stream' && msg.streamId) {
        openDataStream(msg.streamId);
      } else if (msg.type === 'join-team' && msg.teamId) {
        joinTeam(msg.teamId, msg.teamName || msg.teamId, sock);
      } else if (msg.type === 'leave-team' && msg.teamId) {
        leaveTeam(msg.teamId, sock);
      } else if (msg.type === 'team-sync' && typeof msg.rev === 'string') {
        opts.log('收到 team-sync', { rev: msg.rev, teams: Array.isArray(msg.teams) ? msg.teams.length : 0 });
        try {
          opts.onTeamSync?.({ rev: msg.rev, teams: Array.isArray(msg.teams) ? msg.teams : [] });
        } catch (e) {
          opts.log('team-sync 应用失败', { err: String(e) });
        }
        // 立即回一拍心跳带上新 rev，平台好知道已收敛（否则等下个 30s 周期）。
        sendHeartbeat(sock);
      } else if (msg.type === 'unbound') {
        handleUnbound(sock);
      }
    });

    sock.on('close', () => {
      cleanupSock();
      scheduleReconnect();
    });
    sock.on('error', (e) => {
      opts.log('隧道错误', { err: String(e) });
      // close 会接着触发 reconnect
    });
  }

  function cleanupSock(): void {
    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, backoff);
    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
  }

  function sendRegister(sock: WebSocket): void {
    safeSend(sock, {
      type: 'register',
      name: opts.binding.name || hostname(),
      botmuxVersion: opts.getVersion(),
      a2aCapabilities: opts.getA2ACapabilities?.() ?? [],
      dashboardToken: opts.getDashboardToken() || '',
      dashboardPort: opts.getDashboardPort(),
      directHosts: localDirectHosts(opts.getDashboardPort()),
      memberships: teams,
      bots: opts.getBots?.() ?? [],
      teamSyncRev: opts.getTeamSyncRev?.() ?? '',
    });
  }

  function sendHeartbeat(sock: WebSocket): void {
    safeSend(sock, {
      type: 'heartbeat',
      botmuxVersion: opts.getVersion(),
      a2aCapabilities: opts.getA2ACapabilities?.() ?? [],
      dashboardToken: opts.getDashboardToken() || '',
      directHosts: localDirectHosts(opts.getDashboardPort()),
      memberships: teams,
      bots: opts.getBots?.() ?? [],
      teamSyncRev: opts.getTeamSyncRev?.() ?? '',
    });
  }

  function joinTeam(teamId: string, teamName: string, sock: WebSocket): void {
    if (!teams.some((t) => t.teamId === teamId)) {
      teams = [...teams, { teamId, teamName }];
    } else {
      teams = teams.map((t) => (t.teamId === teamId ? { teamId, teamName } : t));
    }
    persistTeams();
    opts.log('加入团队', { teamId, teamName });
    sendHeartbeat(sock); // 立即上报新成员关系
  }

  function leaveTeam(teamId: string, sock: WebSocket): void {
    teams = teams.filter((t) => t.teamId !== teamId);
    persistTeams();
    opts.log('退出团队', { teamId });
    sendHeartbeat(sock);
  }

  // 平台侧 owner 在「我的机器」点了解绑：清掉本地绑定文件并彻底停止隧道（不再重连）。
  // 平台同时已吊销该 machine token，故即便这条消息没送达、旧 token 重连也会被握手拒掉（401）。
  // dashboard 进程本身不退出——本机 bot 照常跑，只是不再对平台暴露；下次 `botmux bind` 即可重新绑定。
  function handleUnbound(sock: WebSocket): void {
    opts.log('平台已解绑本机，清除本地绑定并停止隧道');
    stopped = true; // 必须先置位：下面 close 会触发 scheduleReconnect，stopped 让它早退、不再重连
    cleanupSock();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    clearPlatformBinding();
    try {
      sock.close(4005, 'unbound');
    } catch {
      /* ignore */
    }
  }

  function persistTeams(): void {
    try {
      setPlatformTeams(teams);
    } catch (e) {
      opts.log('团队落盘失败', { err: String(e) });
    }
  }

  function openDataStream(streamId: string): void {
    const url = `${base}/tunnel/data?token=${tokenQ}&stream=${encodeURIComponent(streamId)}`;
    const startedAt = Date.now();
    let won = false;               // 本 stream 是否已有连接胜出并桥接
    let wave = 0;
    const inflight = new Set<WebSocket>(); // 当前在拨/在等的连接（胜出后除胜者外全 terminate）

    // 胜者：桥接到本地 dashboard，并把本 stream 其余在拨的连接全部关掉（用完即弃）。
    const bridge = (winner: WebSocket): void => {
      won = true;
      for (const ws of inflight) {
        if (ws === winner) continue;
        try { ws.terminate(); } catch { /* ignore */ }
      }
      inflight.clear();
      // 数据流必须关 permessage-deflate（连接创建时已设），否则大文件帧经网关压缩协商错位 → RSV1 断流。
      bridgeDataChannel(winner, opts.getDashboardPort());
    };

    // 每波并行拨 DATA_DIAL_PARALLEL 条，谁先 open 谁胜出；一波全黑洞/失败才进下一波（有界）。
    const dialWave = (): void => {
      if (won) return;
      wave++;
      let pending = DATA_DIAL_PARALLEL;
      const onFail = (): void => {
        if (won) return;
        if (--pending > 0) return; // 本波还有在拨的，等它们
        // 本波全军覆没：预算内进下一波，否则放弃。
        if (wave < DATA_DIAL_MAX_WAVES && Date.now() - startedAt < DATA_DIAL_OVERALL_DEADLINE_MS) {
          setTimeout(dialWave, DATA_DIAL_WAVE_BACKOFF_MS);
        } else {
          opts.log('数据连接失败', { waves: wave, parallel: DATA_DIAL_PARALLEL });
        }
      };
      for (let k = 0; k < DATA_DIAL_PARALLEL; k++) {
        const data = new WebSocket(url, { perMessageDeflate: false });
        inflight.add(data);
        let done = false;
        const timer = setTimeout(() => {
          if (done) return;
          done = true;
          inflight.delete(data);
          try { data.terminate(); } catch { /* ignore */ }
          onFail();
        }, DATA_DIAL_TIMEOUT_MS);
        data.on('open', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          inflight.delete(data);
          if (won) { try { data.terminate(); } catch { /* ignore */ } return; } // 已有胜者 → 弃掉
          bridge(data);
        });
        data.on('error', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          inflight.delete(data);
          onFail();
        });
      }
    };

    dialWave();
  }

  connect();

  return {
    stop(): void {
      stopped = true;
      cleanupSock();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      // 干掉本轮还在并行拨号中的候选连接（stop 可能发生在握手成功之前）。
      if (controlDials) {
        for (const c of controlDials) {
          try { c.removeAllListeners(); } catch { /* ignore */ }
          c.on('error', () => { /* swallow：同 dropLosers，terminate CONNECTING 态会异步 emit('error') */ });
          try { c.terminate(); } catch { /* ignore */ }
        }
        controlDials = null;
      }
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * 把一条胜出的数据通道 WebSocket 裸桥接到本地 dashboard 的 TCP 端口。
 *
 * 手动事件桥接，不用 `ws` 的 `createWebSocketStream()`：那个 API 在 **Bun 里直接抛
 * `Error("Not supported yet in Bun")`**（实测 bun 1.4.0 抛、node v22.21.1 正常）。
 * 而编译版单文件二进制跑的就是 Bun —— 于是控制通道连上了（`new WebSocket` 在 Bun 下
 * 正常，日志照打「隧道已连接平台」、平台侧显示机器在线），但每次真要转发请求都崩在桥接
 * 那一行，数据通道永远建不起来：平台侧 Dashboard 整站打不开，而本地直连不经隧道故一切
 * 正常。这个「dev 模式能开、二进制不能开」的分裂就是它。
 *
 * ⚠️ 背压信号为什么不用 `bufferedAmount`：**Bun 下它恒为 0**。实测（bun 1.4.0 客户端
 * + 真 Node `ws` 服务端、对端停读）：连发 400MB 后 `bufferedAmount` 一直是 0、
 * `pause()` 只打印 `[bun] Warning: ... not implemented in bun` 且暂停期间 400/400 条
 * 照送、`send(data, cb)` 的回调在「交给内部队列」时就结算（对端应用层实收 0.0MB 时
 * 400 个回调已全部回来，所以自计数也恒为 0）、`ws` shim 无 `_socket` 可看
 * `writableLength`、Bun 原生 `globalThis.WebSocket` 的 `bufferedAmount` 同样恒 0。
 * ⟹ **ws 层没有任何可用的已缓冲量信号**。
 *
 * 所以改用**协议层确认**：超水位后 `ping()`，只有收到 `pong` 才继续读 TCP。pong 必须由
 * 对端真的读到我们的字节后才可能回来，因此它是「平台确实在消费」的证据，且在 Node 与
 * Bun 下行为一致（两个运行时都实测：对端停读期间 0 个 pong，恢复后收到）。
 *
 * 导出而非内联在 `openDataStream` 里，是为了让测试能 import 到**生产这一份**——
 * 早先测试自己复制了一份桥接，结果删掉整段背压/改成发文本都不报红。
 */
export function bridgeDataChannel(winner: WebSocket, dashboardPort: number): void {
  const tcp = net.connect(dashboardPort, '127.0.0.1');
  // 交互式终端关 Nagle：终端输出常被拆成「回显字符 + 光标/颜色控制序列」这类分帧小包，
  // Nagle 会把紧随其后的小包扣到对端 delayed-ACK(~40ms)才发出。网页终端经平台隧道中转时
  // 这条桥接 socket 串在链路中间，用户就感到每隔一下卡 ~40ms；本机直连不经隧道故不卡。
  tcp.setNoDelay(true);
  let killed = false;
  let ending = false;
  // 「已发出但未被 pong 确认的字节数」——反向背压水位，同时是 finish() 判断排空的依据。
  // 声明在 kill/finish 之前：它们会读这个变量，别让顺序变成 TDZ 隐患。
  let unacked = 0;
  let probing = false;
  /**
   * 硬收尾：双向都会触发 close/error，去重避免重复 destroy。
   *
   * 优雅关闭路径不需要在这里额外让路：finish() 已经等到 `unacked` 归零才 `close()`，
   * 到 winner 'close' 回来时队列本就是空的，此时 terminate 无数据可丢。
   * （实测过一个「ending 时跳过 terminate」的额外分支：Bun 下 64MB × 4 次、以及平台永不
   *   回 close 的场景，加与不加逐字同结果 ⟹ 是没有牙的复杂度，删掉。）
   */
  const kill = (): void => {
    if (killed) return;
    killed = true;
    try { winner.terminate(); } catch { /* ignore */ }
    try { tcp.destroy(); } catch { /* ignore */ }
  };
  /**
   * 本地 dashboard 写完并 FIN 时的收尾：**先等排空、再 `close()`**，绝不 `terminate()`。
   *
   * ⚠️ 这里实测会真丢数据，且踩了两层：
   * 1. `terminate()` 直接掐断 socket，Bun 内部队列里没发出去的帧全丢。64MB 响应 A/B
   *    （本地写满 64MB 后 FIN，平台侧统计实收）：`terminate()` → 只收到 50.2MB。
   * 2. 光换成 `close()` 也不够：仍有 `unacked > 0`（帧已交给队列但对端未确认）时
   *    close 会抢在排空前生效，实测 4 次里 2 次丢 4~5MB。
   * 所以先用 ping/pong 等到 `unacked` 归零（pong 证明对端真读到了我们的字节），再 close。
   * 实测该顺序 64MB × 5 次全部零丢失。原先 `pipe()` 的 `end:true` 免费提供了这个语义。
   *
   * ⚠️⚠️ 别把上面的字节数当成「凑够这个量就能测出来」：丢多少、乃至丢不丢，取决于 FIN 那一
   * 刻 Bun 队列里恰好压着多少字节（灌速 × 平台消费节奏 × 调度的竞态），**不是尺寸阈值**。
   * 两次独立测量就不一致：一处 64MB 丢 14~27MB、24MB 不丢；另一处 64MB 在快/限速平台都零丢。
   * ⟹ 这条不能靠行为断言守，回归防线是测试里那条**源码形态守卫**（别删它）。
   */
  const finish = (): void => {
    if (killed || ending) return;
    ending = true;
    const closeWhenDrained = (): void => {
      if (killed) return;
      if (winner.readyState !== winner.OPEN) { kill(); return; }
      if (unacked <= 0) { try { winner.close(); } catch { kill(); } return; }
      try { winner.ping(); } catch { kill(); return; }
      setTimeout(closeWhenDrained, WS_BACKPRESSURE_PROBE_MS);
    };
    closeWhenDrained();
    // 关闭帧发出后对端会回 close，届时 winner 的 'close' 走 kill() 收 tcp。
    // 兜底：对端不回（或迟迟排不空）时别把 socket 永久挂着。
    setTimeout(kill, WS_CLOSE_FLUSH_TIMEOUT_MS);
  };

  // ── 平台 → 本地 ──
  // TCP 侧写不动时暂停 WebSocket 读取，drain 后恢复。
  // ⚠️ `winner.pause()` 在 Bun 下是 no-op（见函数注释），所以**这个方向在编译版里仍然没有
  // 闸门**：平台灌得比本地 dashboard 收得快时，帧会堆在进程里。下面反向那条 ping 闸门只管
  // 「本地 → 平台」，**不解决这一侧**，别把它读成这一侧的兜底。保留 pause/resume 是因为它
  // 在 Node（源码/npm 形态）下真实有效且在 Bun 下无害。编译态这一侧待 follow-up。
  winner.on('message', (data: RawData) => {
    const buf = toBuffer(data);
    if (!buf.length) return;
    if (!tcp.write(buf)) {
      try { winner.pause(); } catch { /* ignore */ }
    }
  });
  tcp.on('drain', () => { try { winner.resume(); } catch { /* ignore */ } });

  // ── 本地 → 平台 ──
  // 水位变量见函数开头（unacked/probing）。不用 bufferedAmount：Bun 下恒为 0。
  const onPong = (): void => {
    unacked = 0;                       // 对端读到了我们此前写的字节
    if (killed) return;
    tcp.resume();
  };
  winner.on('pong', onPong);

  const probeUntilDrained = (): void => {
    if (killed) return;
    if (unacked <= WS_BACKPRESSURE_BYTES) { probing = false; tcp.resume(); return; }
    try { winner.ping(); } catch { /* 连接已废，kill 会收尾 */ }
    setTimeout(probeUntilDrained, WS_BACKPRESSURE_PROBE_MS);
  };

  tcp.on('data', (chunk: Buffer) => {
    if (winner.readyState !== winner.OPEN) return;
    // binary:true 是显式声明，不是必需的保险：实测 ws 对 Buffer 入参本就发二进制帧
    // （不加也是 isBinary=true、字节逐字不变）。写出来是为了让「这是裸字节桥、
    // 不许按文本处理」这件事在代码里可见，避免日后有人换成 string 载荷。
    winner.send(chunk, { binary: true });
    unacked += chunk.length;
    if (unacked > WS_BACKPRESSURE_BYTES && !probing) {
      probing = true;
      tcp.pause();                     // 停读本地，直到 pong 证明平台已消费
      setTimeout(probeUntilDrained, WS_BACKPRESSURE_PROBE_MS);
    }
  });

  winner.on('close', kill);
  winner.on('error', kill);
  // ⚠️ 不要在 tcp 'close' 上直接 kill：'end'（对端 FIN）之后紧跟就是 'close'，
  // 那会立刻 terminate 掉正在刷出的 WebSocket，把 finish() 的排空又变回截断。
  // 本地 socket 关掉后由 finish()/winner 的 close 事件负责收尾。
  tcp.on('close', () => { if (!ending) kill(); });
  tcp.on('error', kill);
  // 本地 dashboard 读完即关：半关会让隧道另一头一直等，所以收尾。走 finish() 而非 kill()，
  // 否则 Bun 内部队列里未发出的尾部会被丢掉（见 finish() 上的实测数据）。
  tcp.on('end', finish);
}

function safeSend(sock: WebSocket, obj: unknown): void {
  try {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

/**
 * 把 `ws` 的 message 负载归一成一个 Buffer。
 *
 * `RawData` 可能是 Buffer、Buffer[]（分片未合并）或 ArrayBuffer，取决于 ws 的
 * 配置与运行时；桥接要往 TCP 写的是连续字节，所以三种都得收敛。原先
 * `createWebSocketStream()` 内部替我们做了这件事。
 */
function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data as ArrayBuffer);
}

function wsBase(platformUrl: string): string {
  const u = new URL(platformUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // 去掉末尾斜杠 / path
  return `${u.protocol}//${u.host}`;
}
