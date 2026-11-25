import { resolveBotmuxAncestorContext, resolveCurrentActor } from './cli/current-actor.js';
import { parseArgs } from 'node:util';
import { CurrentExecutionIdentityError, resolveCurrentExecutionIdentity } from './cli/current-execution.js';
import { IDENTITY_ROUTE_TOOLS } from './services/trigger-user-auth.js';
import { isBytedcliOverseasRegion } from './platform/bytedcli-grant-regions.js';
import { identityRefusalLines } from './cli/identity-refusal-guidance.js';

// Governed tools plus the Codebase and Bits CLI companions that mirror bytedcli's
// identity; kept in sync with the companion tools in core/cli-identity.ts
// (a compile-entry test pins the runner wiring end to end).
const IDENTITY_TOOLS = IDENTITY_ROUTE_TOOLS;

let requestedTool = 'tool';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args[0] === '__cli-identity-runner') args.shift();
  if (args.length === 1 && args[0] === '--git-actor-email') {
    const { ipcPort, sessionId } = resolveBotmuxAncestorContext();
    const { actor } = await resolveCurrentActor({ ipcPort, sessionId });
    process.stdout.write(actor.email);
    return;
  }
  const { values } = parseArgs({ args, options: {
    'data-dir': { type: 'string' }, 'session-id': { type: 'string' },
    'app-id': { type: 'string' }, 'ipc-port': { type: 'string' }, tool: { type: 'string' }, region: { type: 'string' },
  } });
  const { tool, region } = values;
  if (tool && (IDENTITY_TOOLS as readonly string[]).includes(tool)) requestedTool = tool;
  if (!values['session-id'] || !values['app-id']
    || !(IDENTITY_TOOLS as readonly string[]).includes(tool ?? '')
    || (region !== undefined && (tool !== 'bytedcli' || !isBytedcliOverseasRegion(region)))) {
    throw new CurrentExecutionIdentityError('current_execution_route_unavailable', 'invalid_invocation');
  }
  const execution = await resolveCurrentExecutionIdentity({
    ipcPort: Number(values['ipc-port']), sessionId: values['session-id'], larkAppId: values['app-id'],
    tool: tool!, as: process.env.BOTMUX_AS || undefined, region,
  });
  // The daemon proved the caller's lineage and returns the identity env
  // ASSIGNMENTS themselves. Print only the body for the wrapper to eval. The
  // body is chosen by the daemon alone; the only path it may carry is the
  // per-person HOME the daemon derived (bytedcli), never one the session picks.
  process.stdout.write(execution.env);
}

await main().catch(error => {
  // The wrapper exits 77 on any failure here; these lines are all the person
  // and their agent get, so name the failing step and what to do about it.
  const lines = error instanceof CurrentExecutionIdentityError
    ? identityRefusalLines(requestedTool, error.code, error.reason)
    : [`botmux: ${error instanceof Error ? error.message : 'current_execution_unverified'}`];
  process.stderr.write(`${lines.join('\n')}\n`);
  process.exitCode = 77;
});
