/**
 * `options.connectorWorkingDirectory` containment. In core-only mode
 * `/api/trigger` is public (no host HMAC), so realpath containment inside the
 * configured root is the only protection against an arbitrary directory.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveNativeGatewayWorkingDirectory } from '../src/core/trigger-session.js';

let base: string;
let root: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'native-gateway-wd-')));
  root = join(base, 'root');
  mkdirSync(join(root, 'project', 'nested'), { recursive: true });
  mkdirSync(join(base, 'outside'));
  mkdirSync(join(base, 'root-evil'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('resolveNativeGatewayWorkingDirectory', () => {
  it('accepts the root itself and directories below it', () => {
    expect(resolveNativeGatewayWorkingDirectory(root, root)).toBe(root);
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, 'project', 'nested'))).toBe(join(root, 'project', 'nested'));
  });

  it('normalises `..` that stays inside the root', () => {
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, 'project', 'nested', '..'))).toBe(join(root, 'project'));
  });

  it('rejects `..` escapes out of the root', () => {
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, '..'))).toBeUndefined();
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, 'project', '..', '..', 'outside'))).toBeUndefined();
  });

  it('rejects a sibling directory that only shares the root as a name prefix', () => {
    expect(resolveNativeGatewayWorkingDirectory(root, join(base, 'root-evil'))).toBeUndefined();
  });

  it('rejects a symlink inside the root that points outside it', () => {
    symlinkSync(join(base, 'outside'), join(root, 'escape'));
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, 'escape'))).toBeUndefined();
  });

  it('follows a symlink inside the root that stays inside it', () => {
    symlinkSync(join(root, 'project', 'nested'), join(root, 'shortcut'));
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, 'shortcut'))).toBe(join(root, 'project', 'nested'));
  });

  it('checks containment against the real root when the root itself is a symlink', () => {
    const linkedRoot = join(base, 'linked-root');
    symlinkSync(root, linkedRoot);
    expect(resolveNativeGatewayWorkingDirectory(linkedRoot, join(root, 'project'))).toBe(join(root, 'project'));
    expect(resolveNativeGatewayWorkingDirectory(linkedRoot, join(base, 'outside'))).toBeUndefined();
  });

  it('rejects a path that does not exist, and a file instead of a directory', () => {
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, 'missing'))).toBeUndefined();
    writeFileSync(join(root, 'file.txt'), 'x');
    expect(resolveNativeGatewayWorkingDirectory(root, join(root, 'file.txt'))).toBeUndefined();
  });
});
