import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { atomicWriteFileSync } from '../../../utils/atomic-write.js';
import { withFileLockSync } from '../../../utils/file-lock.js';
import { assertValidPluginId } from '../ids.js';
import {
  pluginCardActionTokenPath,
  pluginHome,
  pluginPrivateDir,
  pluginWebhookTokenPath,
} from '../paths.js';

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const assertPrivateStorageLayout = (
  pluginId: string,
  tokenPath: string,
  tokenErrorKey: string,
  create: boolean,
): void => {
  const home = pluginHome(pluginId);
  if (existsSync(home)) {
    const stat = lstatSync(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe_plugin_home:${pluginId}`);
    }
  } else if (create) {
    mkdirSync(home, { recursive: true, mode: 0o700 });
  }

  const privateDir = pluginPrivateDir(pluginId);
  if (existsSync(privateDir)) {
    const stat = lstatSync(privateDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe_plugin_private_dir:${pluginId}`);
    }
    chmodSync(privateDir, 0o700);
  } else if (create) {
    mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    chmodSync(privateDir, 0o700);
  }

  if (existsSync(tokenPath)) {
    const stat = lstatSync(tokenPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`unsafe_${tokenErrorKey}:${pluginId}`);
    }
  }
};

const readPrivatePluginToken = (
  pluginId: string,
  tokenPathFor: (id: string) => string,
  tokenErrorKey: string,
): string => {
  const id = assertValidPluginId(pluginId);
  const tokenPath = tokenPathFor(id);
  assertPrivateStorageLayout(id, tokenPath, tokenErrorKey, false);
  let fd: number | undefined;
  try {
    fd = openSync(
      tokenPath,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`invalid_${tokenErrorKey}:${id}`);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      fchmodSync(fd, 0o600);
    }
    const token = readFileSync(fd, 'utf8').trim();
    if (!TOKEN_RE.test(token)) throw new Error(`invalid_${tokenErrorKey}:${id}`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${tokenErrorKey}_missing:${id}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

const getOrCreatePrivatePluginToken = (
  pluginId: string,
  tokenPathFor: (id: string) => string,
  tokenErrorKey: string,
): string => {
  const id = assertValidPluginId(pluginId);
  const tokenPath = tokenPathFor(id);
  assertPrivateStorageLayout(id, tokenPath, tokenErrorKey, true);
  return withFileLockSync(tokenPath, () => {
    assertPrivateStorageLayout(id, tokenPath, tokenErrorKey, true);
    if (existsSync(tokenPath)) return readPrivatePluginToken(id, tokenPathFor, tokenErrorKey);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    atomicWriteFileSync(tokenPath, token, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
    return readPrivatePluginToken(id, tokenPathFor, tokenErrorKey);
  }, { maxWaitMs: 30_000 });
};

export const readPluginCardActionToken = (pluginId: string): string =>
  readPrivatePluginToken(pluginId, pluginCardActionTokenPath, 'plugin_card_action_token');

export const getOrCreatePluginCardActionToken = (pluginId: string): string =>
  getOrCreatePrivatePluginToken(pluginId, pluginCardActionTokenPath, 'plugin_card_action_token');

export const readPluginWebhookToken = (pluginId: string): string =>
  readPrivatePluginToken(pluginId, pluginWebhookTokenPath, 'plugin_webhook_token');

export const getOrCreatePluginWebhookToken = (pluginId: string): string =>
  getOrCreatePrivatePluginToken(pluginId, pluginWebhookTokenPath, 'plugin_webhook_token');
