// 平台隧道客户端（跑在 dashboard 进程里，每台机器一个）。
// 对中心化平台保持一条出站控制 WebSocket；平台需要展示本机 dashboard 时，
// 下发 open-stream，本端拨一条数据连接回去、裸桥接到本地 dashboard 端口。
import net from 'node:net';
import { hostname } from 'node:os';
import { WebSocket, createWebSocketStream } from 'ws';
import { setPlatformTeams, type PlatformBinding, type PlatformTeam } from './binding.js';

/** 本机一个 botmux bot 的概要（上报给平台，供团队页「人→机器→bot」展示 + 拉群）。 */
export interface PlatformBotInfo {
  appId: string;
  openId: string | null;
  name: string;
  avatar?: string;
  cli?: string;
  /** 团队页是否展示这个 bot（默认 true，按 bot 配置 showInTeam 上报）。 */
  showInTeam?: boolean;
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
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

const HEARTBEAT_MS = 30_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const DATA_DIAL_TIMEOUT_MS = 10_000;

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
    const sock = new WebSocket(url);
    ws = sock;

    sock.on('open', () => {
      backoff = BACKOFF_MIN_MS;
      opts.log('隧道已连接平台');
      sendRegister(sock);
      heartbeat = setInterval(() => sendHeartbeat(sock), HEARTBEAT_MS);
    });

    sock.on('message', (data) => {
      let msg: { type?: string; streamId?: string; teamId?: string; teamName?: string };
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
      memberships: teams,
      bots: opts.getBots?.() ?? [],
    });
  }

  function sendHeartbeat(sock: WebSocket): void {
    safeSend(sock, {
      type: 'heartbeat',
      botmuxVersion: opts.getVersion(),
      dashboardToken: opts.getDashboardToken() || '',
      memberships: teams,
      bots: opts.getBots?.() ?? [],
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

  function persistTeams(): void {
    try {
      setPlatformTeams(teams);
    } catch (e) {
      opts.log('团队落盘失败', { err: String(e) });
    }
  }

  function openDataStream(streamId: string): void {
    const url = `${base}/tunnel/data?token=${tokenQ}&stream=${encodeURIComponent(streamId)}`;
    const data = new WebSocket(url);
    const dialTimer = setTimeout(() => {
      try {
        data.terminate();
      } catch {
        /* ignore */
      }
    }, DATA_DIAL_TIMEOUT_MS);

    data.on('open', () => {
      clearTimeout(dialTimer);
      const dup = createWebSocketStream(data);
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
    });
    data.on('error', (e) => {
      clearTimeout(dialTimer);
      opts.log('数据连接失败', { err: String(e) });
    });
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
