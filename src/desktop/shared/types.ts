export type RuntimeStatus =
  | 'not_configured'
  | 'stopped'
  | 'starting'
  | 'running'
  | 'degraded';

export type RuntimeSource = 'global-cli' | 'none';

export interface DesktopPaths {
  // User-owned CLI/dashboard state remains in ~/.botmux across app upgrades.
  botmuxHome: string;
  dataDir: string;
  logsDir: string;
  pm2Home: string;
}

export interface DesktopRuntimeState {
  status: RuntimeStatus;
  appVersion: string;
  runtimeVersion: string | null;
  runtimeSource: RuntimeSource;
  // false means the selected runtime cannot be safely controlled by this app.
  runtimeManaged: boolean;
  runtimePath: string | null;
  botCount: number;
  onlineDaemonCount: number;
  attentionCount: number;
  dashboardUrl: string | null;
  message?: string;
}

export interface LogTarget {
  id: string;
  label: string;
  files: string[];
}

export interface LogTail {
  targetId: string;
  text: string;
  truncated: boolean;
}

export type DashboardLocateResult =
  | { ok: true; url: string; source: 'current' | 'rotated' }
  | {
    ok: false;
    reason: 'not_running' | 'no_secret' | 'wrong_service' | 'unreachable' | 'incompatible' | 'unknown';
    message: string;
  };

export interface AttentionEvent {
  id: string;
  kind: 'runtime' | 'onboarding' | 'session' | 'workflow';
  title: string;
  body: string;
  createdAt: number;
}
