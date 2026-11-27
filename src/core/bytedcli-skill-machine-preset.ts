import { BYTEDCLI_OPERATION_CATALOG, BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION } from './bytedcli-operation-catalog.js';
import { parseBytedcliOperationPolicy, BYTEDCLI_OPERATION_POLICY_SCHEMA } from './bytedcli-operation-policy-config.js';
/** Attribution is documentation only. Authorization keys are exact catalog IDs,
 * never the caller's claimed Skill name. Shared commands have one policy row. */
export const MIX_MACHINE_COMMAND_SOURCES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'picko-item-in-package': ['bam.method.get', 'api-test.rpc-call.picko-troubleshoot', 'api-test.rpc-call.picko-troubleshoot-ticket', 'tcc.config.get.picko-rules', 'api-test.http-call.picko-tag-enum'],
  'picko-soutui-sync': ['rds.db.query', 'bam.method.get', 'api-test.rpc-call.picko-size', 'api-test.rpc-call.picko-size-ticket', 'api-test.rpc-call.picko-is-online', 'api-test.rpc-call.picko-is-online-ticket', 'api-test.rpc-call.picko-export-pids', 'api-test.rpc-call.picko-export-pids-ticket', 'api-test.rpc-call.assign-info', 'api-test.rpc-call.assign-info-ticket', 'cache.execute-command.picko-hget', 'iam.permission.apply.check-only'],
  'picko-es-tag-distribution': ['tcc.config.get.picko-rules', 'es.search.picko-tag-distribution'],
  'picko-tage-impact-report': ['tcc.config.get.picko-rules', 'rds.db.query', 'api-test.rpc-call.picko-user-email', 'api-test.rpc-call.picko-user-email-ticket'],
  'release-plan-owner-sync': ['bits.release.search', 'codebase.mr.files', 'skill-api.bits.release.get', 'skill-api.bits.release.tasks.list', 'skill-api.bits.release.owner.update'],
  'mix-troubleshooting': ['log.get-logid-log', 'log.search-psm-log', 'iam.permission.apply.check-only', 'iam.permission.apply.submit', 'bits.anywhere.share.get', 'slardar.web.data.list.mix-profile'],
  'mix-c4-tracker': ['slardar.web.analyze-url', 'slardar.web.chat.check-auth', 'slardar.web.chat.get', 'slardar.web.chat.send', 'slardar.web.data.list.mix-profile', 'slardar.web.data.get.mix-profile', 'slardar.web.data.session-list.mix-profile', 'libra.layer.get', 'libra.experiment.list', 'libra.experiment.get-batch', 'tos.upload-object.c4-report', 'codebase.repo.file'],
});
const selected = new Set(Object.values(MIX_MACHINE_COMMAND_SOURCES).flat());
for (const id of selected) if (!BYTEDCLI_OPERATION_CATALOG.some(row => row.id === id && ['read', 'write'].includes(row.effect))) throw new Error('MIX preset coverage drift: ' + id);
export const MIX_SKILL_MACHINE_PRESET = parseBytedcliOperationPolicy({ schema: BYTEDCLI_OPERATION_POLICY_SCHEMA,
  cliVersion: BYTEDCLI_AUDITED_RELEASE, catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION,
  rules: Object.fromEntries(BYTEDCLI_OPERATION_CATALOG.flatMap(row => selected.has(row.id) ? [[row.id, 'machine']]
    : ['read','write'].includes(row.effect) ? [[row.id, 'actor']] : [])),
})!;
export const MIX_MACHINE_WRITE_EXCEPTIONS = Object.freeze(BYTEDCLI_OPERATION_CATALOG.filter(row => row.effect === 'write' && selected.has(row.id)).map(row => row.id));
