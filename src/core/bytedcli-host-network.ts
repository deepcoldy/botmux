/** Audited 0.199.0 native transport reads HTTP(S)_PROXY and NO_PROXY.
 * ALL_PROXY belongs to other CLI/companion adapters and is unsupported here. */
export const BYTEDCLI_HOST_NETWORK_KEYS = Object.freeze(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY',
  'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR'] as const);
export function bytedcliHostNetworkEnvironment(env: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  for (const key of ['ALL_PROXY', 'all_proxy']) if (env[key]) throw new Error('unsupported ByteCloud host proxy: ' + key);
  const network: NodeJS.ProcessEnv = {};
  for (const key of BYTEDCLI_HOST_NETWORK_KEYS) if (env[key]) {
    if (env[key]!.includes('\0')) throw new Error('invalid ByteCloud host network setting: ' + key);
    network[key] = env[key];
  }
  return Object.freeze(network);
}
