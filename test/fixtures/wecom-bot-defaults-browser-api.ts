// wecom-bot-defaults-browser.tsx 夹具的 /api/** 应答：一个可编辑的企业微信机器人，配置里每个企业微信
// 专属格子都有内容（授权与额度、额度耗尽交接与它的下拉、/summary 总结范围），各分类页签都能铺满。
export const WECOM_FIXTURE_ID = 'fixture-connection';

export const wecomFixtureConnection = {
  id: WECOM_FIXTURE_ID,
  label: '企微项目助理',
  botIdHint: '…fixture',
  allowedUserCount: 1,
  coreMode: 'managed',
  configuration: 'ready',
  gateway: 'running',
  connection: 'connected',
  ownership: 'fleet',
  desired: 'running',
  canStart: false,
  canStop: true,
  canRestart: true,
};

export const wecomFixtureConfig = {
  editable: true,
  revision: 'r1',
  displayName: '企微项目助理',
  cli: 'codex',
  backend: 'pty',
  model: '',
  workingDirectory: '/workspace/demo',
  requiresRestart: true,
  sessionMode: {p2pMode: 'chat', regularGroupReplyMode: 'user', regularGroupMentionMode: 'never'},
  botConfig: {},
  allowedUsers: ['alice'],
  blockedUsers: [],
  role: {content: '', injectMode: 'every'},
  native: {
    p2pOpen: true,
    grantDefaultDurationMs: 28_800_000,
    canTalkDaemonCommands: ['/status', '/stop'],
    quotaFallbackBot: {enabled: true, peerId: 'b'.repeat(64), kinds: ['usage'], message: 'handed over'},
    summaryRange: {limit: 100},
    chatFeedbackPolicies: {'chat-a': {enabled: true, audience: 'reviewers', reviewers: ['bob'], allowReselect: true}},
    feedbackWebhooks: [{id: 'hook-a', url: 'https://hook.example.invalid/endpoint', enabled: true, eventTypes: ['turn.completed'], secretRef: ''}],
  },
};

/** 「额度耗尽交接」下拉：本机另一条会接受本连接的企业微信连接（只有 id 与名字）。 */
export const wecomFixtureFallbackPeers = {
  peers: [{id: 'b'.repeat(64), name: '企微备用助理'}],
  current: {id: 'b'.repeat(64), name: '企微备用助理', accepted: true},
  trusting: true,
};

const environment = {scope: 'bot', rows: [], reserved: {keys: [], prefixes: []}, conflicts: [], sessions: [], redactedHostKeys: [], inherit: {mode: 'inherit'}, canReveal: false};

/** 按路径应答；不认识的路径给空对象（页面对缺省数据有兜底），由调用方记下来排查。 */
export function wecomBotDefaultsApi(path: string): {body: unknown; known: boolean} {
  const base = `/api/wecom/connections/${WECOM_FIXTURE_ID}`;
  if (path === '/api/bots') return {body: {bots: []}, known: true};
  if (path === '/api/wecom/connections') return {body: {connections: [wecomFixtureConnection]}, known: true};
  if (path === `${base}/config`) return {body: wecomFixtureConfig, known: true};
  if (path === `${base}/environment` || path.endsWith('/session-env')) return {body: environment, known: true};
  if (path === `${base}/fallback-peers`) return {body: wecomFixtureFallbackPeers, known: true};
  if (path === `${base}/codex-profiles`) return {body: {connectionId: WECOM_FIXTURE_ID, status: 'empty', candidates: []}, known: true};
  if (path === '/api/cli-options') return {body: {options: [{id: 'codex', label: 'Codex', available: true, modelChoices: ['gpt-6.1']}], webSession: {status: 'scan_required'}}, known: true};
  if (path.includes('/cli-options/')) return {body: {available: true, status: 'available', models: []}, known: true};
  return {body: {}, known: false};
}
