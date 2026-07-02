// 平台隧道客户端（跑在 dashboard 进程里，每台机器一个）。
// 对中心化平台保持一条出站控制 WebSocket；平台需要展示本机 dashboard 时，
// 下发 open-stream，本端拨一条数据连接回去、裸桥接到本地 dashboard 端口。
import net from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { WebSocket, createWebSocketStream } from 'ws';
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
//  - 单条超时 1s（好连接 90ms 就成，1s 足够判黑洞）；一波全黑洞才进下一波，最多 DATA_DIAL_MAX_WAVES 波。
//  - 用完即弃、不常驻空闲连接（区别于「预热连接池」，不随机器数堆连接，可扩展）。
//  - 平台对同一个 streamId 只 attach 第一条到的、其余自动 4004 关，协议无需改。
//  - 配合平台连接池：建好的好连接会被复用，拨号（赌）只在冷启动/扩容发生，不是每请求。
const DATA_DIAL_TIMEOUT_MS = 1_000;
const DATA_DIAL_PARALLEL = 3;
const DATA_DIAL_MAX_WAVES = 2;
const DATA_DIAL_WAVE_BACKOFF_MS = 150;
const DATA_DIAL_OVERALL_DEADLINE_MS = 6_000;

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
  let heartbeat: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let backoff = BACKOFF_MIN_MS;
  // 本机平台团队（成员关系下沉到部署本地）
  let teams: PlatformTeam[] = opts.binding.teams ? [...opts.binding.teams] : [];

  const base = wsBase(opts.binding.platformUrl);
  const tokenQ = encodeURIComponent(opts.binding.machineToken);

  function connect(): void {
    if (stopped) return;
    const url = `${base}/tunnel/control?token=${tokenQ}`;
    // 关掉 permessage-deflate：隧道是裸字节桥，承载的 HTTP 自己会 gzip，WS 层再压一遍既没收益、
    // 又会在经过中心化网关(TLB)时因压缩扩展协商被改写而触发 "Invalid WebSocket frame: RSV1 must
    // be clear"，整条数据流当场挂掉 → dashboard 的 CSS/JS 半路断供、页面掉样式。不 offer 扩展，
    // 中间任何一跳都不会给这条连接开压缩。
    const sock = new WebSocket(url, { perMessageDeflate: false });
    ws = sock;

    sock.on('open', () => {
      backoff = BACKOFF_MIN_MS;
      opts.log('隧道已连接平台');
      sendRegister(sock);
      heartbeat = setInterval(() => sendHeartbeat(sock), HEARTBEAT_MS);
    });

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

    sock.on('unexpected-response', (_req, res) => {
      opts.log('隧道握手被拒', { status: res.statusCode });
      if (res.statusCode === 401) opts.log('机器 token 失效，请重新 botmux bind');
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
      const dup = createWebSocketStream(winner);
      const tcp = net.connect(opts.getDashboardPort(), '127.0.0.1');
      const kill = () => {
        try { dup.destroy(); } catch { /* ignore */ }
        try { tcp.destroy(); } catch { /* ignore */ }
      };
      dup.on('error', kill);
      tcp.on('error', kill);
      tcp.on('close', kill);
      dup.pipe(tcp);
      tcp.pipe(dup);
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
      try {
        ws?.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function safeSend(sock: WebSocket, obj: unknown): void {
  try {
    if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

function wsBase(platformUrl: string): string {
  const u = new URL(platformUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  // 去掉末尾斜杠 / path
  return `${u.protocol}//${u.host}`;
}
