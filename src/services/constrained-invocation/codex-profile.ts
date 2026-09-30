/** Codex-specific native configuration for the shared model-only contract. */
export const CONSTRAINED_CODEX_CONFIG = `
web_search="disabled"
project_doc_max_bytes=0
cli_auth_credentials_store="file"
[agents]
enabled=false
[orchestrator.skills]
enabled=false
[orchestrator.mcp]
enabled=false
[tools.update_plan]
enabled=false
[tools.experimental_request_user_input]
enabled=false
[features]
shell_tool=false
apps=false
multi_agent=false
multi_agent_v2=false
hooks=false
code_mode=false
code_mode_host=false
code_mode_only=false
view_image=false
image_generation=false
browser_use=false
computer_use=false
in_app_browser=false
sleep_tool=false
goals=false
remote_plugin=false
skill_search=false
skip_host_skill_discovery=true
memories=false
tool_suggest=false
workspace_dependencies=false
`;

export function assertConstrainedRuntime(cliId: string, platform = process.platform): void {
  if (cliId !== 'codex' || !['darwin', 'linux'].includes(platform)) {
    throw new Error('constrained_capability_unsupported');
  }
}
