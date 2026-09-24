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
} from '../paths.js';

const TOKEN_BYTES = 32;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const assertPrivateStorageLayout = (pluginId: string, create: boolean): void => {
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

  const tokenPath = pluginCardActionTokenPath(pluginId);
  if (existsSync(tokenPath)) {
    const stat = lstatSync(tokenPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`unsafe_plugin_card_action_token:${pluginId}`);
    }
  }
};

export const readPluginCardActionToken = (pluginId: string): string => {
  const id = assertValidPluginId(pluginId);
  assertPrivateStorageLayout(id, false);
  const tokenPath = pluginCardActionTokenPath(id);
  let fd: number | undefined;
  try {
    fd = openSync(
      tokenPath,
      constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
    );
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`invalid_plugin_card_action_token:${id}`);
    if (process.platform !== 'win32' && (stat.mode & 0o777) !== 0o600) {
      fchmodSync(fd, 0o600);
    }
    const token = readFileSync(fd, 'utf8').trim();
    if (!TOKEN_RE.test(token)) throw new Error(`invalid_plugin_card_action_token:${id}`);
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`plugin_card_action_token_missing:${id}`);
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
};

export const getOrCreatePluginCardActionToken = (pluginId: string): string => {
  const id = assertValidPluginId(pluginId);
  assertPrivateStorageLayout(id, true);
  const tokenPath = pluginCardActionTokenPath(id);
  return withFileLockSync(tokenPath, () => {
    assertPrivateStorageLayout(id, true);
    if (existsSync(tokenPath)) return readPluginCardActionToken(id);
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    atomicWriteFileSync(tokenPath, token, {
      mode: 0o600,
      durable: true,
      followTargetSymlink: false,
    });
    return readPluginCardActionToken(id);
  }, { maxWaitMs: 30_000 });
};
