import { BYTEDCLI_OPERATION_CATALOG, BYTEDCLI_AUDITED_RELEASE, BYTEDCLI_OPERATION_CATALOG_VERSION } from '../../../src/core/bytedcli-operation-catalog.js';
import { parseBytedcliOperation } from '../../../src/core/bytedcli-operation-policy.js';
import { parseBytedcliOperationPolicy, resolveBytedcliOperationRule } from '../../../src/core/bytedcli-operation-policy-config.js';

const config = (rules: Record<string, string>) => ({ schema: 'botmux.bytedcli-operation-policy.v1',
  cliVersion: BYTEDCLI_AUDITED_RELEASE, catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION, rules });
const read = parseBytedcliOperation(['-j', 'codebase', '-R', 'team/service', 'pr', 'view', '--mr=42']);
const write = parseBytedcliOperation(['codebase', 'mr', 'close', '42', '--repo', 'team/service']);
const global = parseBytedcliOperationPolicy(config({ 'codebase.mr.get': 'actor', 'codebase.mr.close': 'deny' }));
const bot = parseBytedcliOperationPolicy(config({ 'codebase.mr.get': 'machine' }));
let invalidWriteRefused = false;
try { parseBytedcliOperationPolicy(config({ 'codebase.mr.close': 'machine' })); }
catch (error) { invalidWriteRefused = (error as Error).name === 'BytedcliOperationPolicyConfigError'; }
let unknownCommandRefused = false;
try { parseBytedcliOperation(['codebase', 'repo', 'delete', 'team/service']); }
catch (error) { unknownCommandRefused = (error as { code?: string }).code === 'unsupported_operation'; }
console.log(JSON.stringify({
  cliVersion: BYTEDCLI_AUDITED_RELEASE, catalogVersion: BYTEDCLI_OPERATION_CATALOG_VERSION,
  catalogEntries: BYTEDCLI_OPERATION_CATALOG.length,
  frozenCatalog: Object.isFrozen(BYTEDCLI_OPERATION_CATALOG) && BYTEDCLI_OPERATION_CATALOG.every(entry => Object.isFrozen(entry.aliases)),
  read: { id: read.id, effect: read.effect, argv: read.argv }, write: { id: write.id, effect: write.effect },
  effectiveRead: resolveBytedcliOperationRule(read.id, global, bot), effectiveWrite: resolveBytedcliOperationRule(write.id, global, bot),
  invalidWriteRefused, unknownCommandRefused,
}));
