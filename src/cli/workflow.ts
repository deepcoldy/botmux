/** Workflow command dispatch after the v2 runtime retirement. */

const LEGACY_TEMPLATE_RETIRED =
  'v2 workflow runtime 已下线；请先用 `botmux template migrate-v3` 迁移定义，' +
  '再用 `botmux workflow run <名称|workflowId>` 执行 Saved Workflow。';

const V3_HOST_SUBCOMMANDS = new Set([
  'new',
  'spec-finalize',
  'approve-spec',
  'revise-spec',
  'architect',
  'revise-dag',
  'approve-dag',
]);

const V3_SAVED_SUBCOMMANDS = new Set(['save', 'run', 'list', 'show']);
const RETIRED_TEMPLATE_SUBCOMMANDS = new Set([
  'run',
  'resume',
  'cancel',
  'ls',
  'list',
  'tail',
  'validate',
  'show',
]);

export async function cmdWorkflow(sub: string, rest: string[]): Promise<void> {
  if (V3_HOST_SUBCOMMANDS.has(sub)) {
    const { cmdWorkflowHost } = await import('../workflows/v3/host.js');
    await cmdWorkflowHost(sub, rest);
    return;
  }
  if (V3_SAVED_SUBCOMMANDS.has(sub)) {
    const { cmdSavedWorkflow } = await import('./saved-workflow.js');
    await cmdSavedWorkflow(sub, rest);
    return;
  }
  if (sub === 'help' || !sub) {
    printWorkflowHelp();
    return;
  }
  if (RETIRED_TEMPLATE_SUBCOMMANDS.has(sub)) {
    failRetired(`workflow ${sub}`);
  }
  console.error(`未知子命令: workflow ${sub}`);
  printWorkflowHelp();
  process.exit(1);
}

/**
 * `template` is now an offline retirement namespace only. It never reads or
 * drives legacy run state except through the explicit migration/archive tools.
 */
export async function cmdTemplate(sub: string, rest: string[]): Promise<void> {
  switch (sub) {
    case 'archive-runs': {
      const { cmdWorkflowRunArchive } = await import('./workflow-run-archive.js');
      await cmdWorkflowRunArchive(rest);
      return;
    }
    case 'migrate-v3': {
      const { cmdWorkflowMigration } = await import('./workflow-migration.js');
      await cmdWorkflowMigration(rest);
      return;
    }
    case 'help':
    case '':
      printTemplateHelp();
      return;
    default:
      if (RETIRED_TEMPLATE_SUBCOMMANDS.has(sub)) failRetired(`template ${sub}`);
      console.error(`未知子命令: template ${sub}`);
      printTemplateHelp();
      process.exit(1);
  }
}

function failRetired(command: string): never {
  console.error(`无法执行 \`botmux ${command}\`：${LEGACY_TEMPLATE_RETIRED}`);
  process.exit(1);
}

function printWorkflowHelp(): void {
  console.log(`用法: botmux workflow <目标控制|save|run|list|show|start|cancel|retry|grant> [...]

Saved Workflow:
  save [last|runId] [名称] [--workflow-id <chat-scope-id>]
  run <名称|workflowId> [--param key=value ...] [--param-json key=<json> ...]
  list [--json]
  show <名称|workflowId>

即兴 Workflow:
  new / spec-finalize / approve-spec / architect / approve-dag / start
  cancel <runId> [--reason <text>] [--bot <larkAppId>]

v2 资产离线处理: botmux template <migrate-v3|archive-runs>
`);
}

function printTemplateHelp(): void {
  console.log(`用法: botmux template <migrate-v3|archive-runs> [...]

子命令:
  migrate-v3 [workflowId|path ...] [--all] [--json]
      默认 dry-run；--commit 将可转换的 v2 定义固化为 v3 Saved Workflow。

  archive-runs [--commit] [--verify <archiveId|path>] [--json]
  archive-runs --retire <archiveId|path> --ack-daemon-stopped [--json]
      扫描、归档或校验已终态的 v2 历史运行；retire 仅在维护窗双验后原子迁入 quarantine。
      该命令不会执行 v2 workflow，也不会直接删除历史字节。

v2 run/resume/cancel/ls/tail/show/validate 已下线。
`);
}
