import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConnection, resolveIdentity } from './client.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const runtime = JSON.parse(await readFile(join(root, 'runtime.json'), 'utf8'));
const cwd = process.argv[2];
const connection = loadConnection(runtime.client_config);
const identity = resolveIdentity(connection, cwd);
// The optional capture adapter and every Agent's CLI use this same identity.
const connectionEnv = {
  OPENVIKING_URL: connection.url, OPENVIKING_ACCOUNT: identity.account,
  OPENVIKING_USER: identity.user, OPENVIKING_PEER_ID: identity.peer,
  OPENVIKING_API_KEY: connection.apiKey, OPENVIKING_CREDENTIAL_SOURCE: 'env',
  OPENVIKING_RECALL_PEER_SCOPE: 'actor',
};
process.stdout.write(JSON.stringify(connectionEnv) + '\n');
