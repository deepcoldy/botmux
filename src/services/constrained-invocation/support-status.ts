import type { CliId } from '../../adapters/cli/types.js';

export interface ModelOnlyAssessment {
  group: string;
  status: 'implemented' | 'verification_required' | 'interface_gap';
  reason: string | null;
  detail: string;
}

/** A closed Record forces every newly registered CLI to get an explicit
 * assessment. Unverified means pending work, not an upstream impossibility. */
export const modelOnlyAssessments: Readonly<Record<CliId, ModelOnlyAssessment>> = {
  'claude-code': { group: 'claude-print', status: 'implemented', reason: null, detail: '原生 print/stream-json、空 tools、安全模式；原生合成服务测试通过，真实订阅认证待验证。' },
  seed: { group: 'claude-print', status: 'verification_required', reason: 'fork_auth_and_protocol_unverified', detail: '使用独立的 byted-cloud-auth.json；缺少可运行的 Seed，未验证空 tools、安全模式和隔离登录，不能直接继承 Claude 支持。' },
  relay: { group: 'claude-print', status: 'verification_required', reason: 'fork_auth_and_protocol_unverified', detail: 'Relay 的登录目录和迁移行为不同于 Claude；缺少可运行的 Relay，未验证原生工具关闭及独立身份。' },
  aiden: { group: 'native-print', status: 'verification_required', reason: 'native_auth_isolation_unverified', detail: '原生帮助确认有 --no-tools、--stream-json；原生登录涉及多种 token 文件，尚未完成无配置、无插件的独立认证验证。' },
  coco: { group: 'trae-app-server', status: 'verification_required', reason: 'native_tool_isolation_unverified', detail: '检查到的旧原生接口只有 print/json 和自动批准 allowed-tool；新版与 TraeX 共用实现，但零工具目录和认证适配尚未验证。' },
  codex: { group: 'codex-app-server', status: 'implemented', reason: null, detail: '独立 app-server、空工具和临时线程；原生合成服务测试及 Linux 真实订阅外部 loop 通过。' },
  'codex-app': { group: 'codex-app-server', status: 'implemented', reason: null, detail: '复用同一 Codex 可执行文件和隔离 app-server 通道；独立 IPC 路由测试通过，不连接既有服务或实例池。' },
  cursor: { group: 'native-print', status: 'interface_gap', reason: 'read_only_is_not_model_only', detail: '原生 help 的 ask/plan 仍是只读 Agent，print 明确保留工具；本次核查未发现可验证的空工具目录接口。' },
  gemini: { group: 'policy-headless', status: 'implemented', reason: null, detail: 'headless stream-json、空 core 工具和全部拒绝策略；原生合成服务测试通过，OAuth 登录待真实账号验证。' },
  genius: { group: 'claude-print', status: 'verification_required', reason: 'fork_auth_and_protocol_unverified', detail: '使用 Genius 自己的凭证和状态目录；缺少原生程序，未验证 Claude 风格参数是否提供相同隔离保证。' },
  opencode: { group: 'policy-headless', status: 'implemented', reason: null, detail: 'run/json、pure 模式、全部工具拒绝，关闭标题与压缩子调用；原生合成服务测试通过。' },
  opencode2: { group: 'policy-headless', status: 'verification_required', reason: 'fork_protocol_unverified', detail: '仓库适配器明确使用 V2 插件、配置和服务接口；缺少 opencode2 原生程序，不能以 OpenCode 的测试替代。' },
  antigravity: { group: 'native-print', status: 'verification_required', reason: 'matching_native_executable_unavailable', detail: '仓库目标是 Agent CLI；本次找到的同名 agy 是编辑器启动器，无法验证目标 Agent 的 print 和工具隔离协议。' },
  mtr: { group: 'policy-headless', status: 'verification_required', reason: 'matching_native_executable_unavailable', detail: '仓库目标是 OpenCode 衍生 Agent；本次找到的同名 mtr 是网络诊断工具，缺少目标程序做原生验证。' },
  hermes: { group: 'native-print', status: 'verification_required', reason: 'native_runtime_unavailable', detail: '官方源码有单次调用和 toolsets 入口；未获得可运行的 Hermes 环境，空工具集、认证及 hooks 隔离未完成原生验证。' },
  mira: { group: 'remote-agent', status: 'interface_gap', reason: 'remote_loop_control_unproven', detail: '当前接入是云端 chat/completion；tool_list 只体现检索配置，尚无证据证明可禁用整个服务端工具与 Agent loop。' },
  mir: { group: 'native-print', status: 'verification_required', reason: 'native_bridge_isolation_unverified', detail: '现有 print runner 依赖原生本地 MCP bridge；缺少 mircli，未验证关闭 bridge 和宿主工具后仍可推理。' },
  traex: { group: 'trae-app-server', status: 'verification_required', reason: 'native_tool_isolation_unverified', detail: '已确认原生 app-server 和工具禁用选项；TRAE_HOME、认证和工具目录与 Codex 不同，尚未证明完整空工具调用。' },
  pi: { group: 'native-print', status: 'implemented', reason: null, detail: '原生 --no-tools、禁用扩展与上下文、print/json；原生合成服务测试通过，拒绝可执行凭证 helper。' },
  copilot: { group: 'native-print', status: 'verification_required', reason: 'native_auth_isolation_unverified', detail: '原生帮助有 available-tools；OAuth 优先存入系统凭证库，文件回退混在配置中，尚未证明专用 Bot 认证不会回退宿主身份。' },
  'oh-my-pi': { group: 'native-print', status: 'verification_required', reason: 'mixed_auth_database_isolation_unverified', detail: '原生 --no-tools 可用，但认证、设置等共存于 agent.db 并支持 auth broker；不能复制整个数据库或直接套用 Pi auth.json。' },
  ebsd: { group: 'service-agent', status: 'verification_required', reason: 'service_identity_isolation_unverified', detail: '仓库使用固定 HOME 下的 service 身份和 botmux 子命令，禁止 per-bot HOME 覆盖；未验证独立身份和零工具协议。' },
  kimi: { group: 'agent-profile', status: 'verification_required', reason: 'native_profile_unverified', detail: '官方源码提供自定义 agent 文件及 tools 列表；缺少可运行的 Kimi，空列表、OAuth 目录和非交互输出未原生验证。' },
  grok: { group: 'native-print', status: 'interface_gap', reason: 'always_on_meta_tools_unverified', detail: '官方 headless 文档说明工具筛选后仍保留常驻 MCP meta-tools；尚未找到并验证完全关闭这些能力的方法。' },
  'kiro-cli': { group: 'agent-profile', status: 'verification_required', reason: 'native_profile_unverified', detail: '官方 agent 配置区分 tools 与 allowedTools；缺少原生程序，tools 空列表及自动内置能力、认证隔离尚未验证。' },
  riff: { group: 'remote-agent', status: 'interface_gap', reason: 'remote_loop_control_unproven', detail: '现有后端提交远端 Agent 任务并使用远端工具；当前接口没有已核实的纯模型、无服务端 loop 契约。' },
  reasonix: { group: 'native-print', status: 'verification_required', reason: 'native_runtime_unavailable', detail: '仓库目前接入 TUI 和本地 transcript；缺少原生程序及已验证的非交互零工具入口。' },
  dsh: { group: 'agent-profile', status: 'verification_required', reason: 'native_profile_unverified', detail: '现有 runner 使用 profile 认证和 ACP session/prompt；缺少 dsh 程序，profile 的空工具和无定制加载未验证。' },
  'dsh-tui': { group: 'agent-profile', status: 'verification_required', reason: 'native_profile_unverified', detail: '这是独立 TUI 入口，配置和登录关联 dsh；未验证可复用的原生 model-only 协议，不能退回 PTY 提示词限制。' },
  mojo: { group: 'remote-agent', status: 'interface_gap', reason: 'remote_loop_control_unproven', detail: '现有 CLI 管理后台远端 Agent session；session cancel 能控制任务生命周期，但没有已核实的禁用远端工具和 loop 参数。' },
  minimax: { group: 'native-print', status: 'implemented', reason: null, detail: '原生 text chat/json，不传任何 tool；原生合成服务测试通过，使用原生 config.json 维护区域和认证。' },
};
