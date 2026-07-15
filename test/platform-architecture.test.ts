import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * Transitional dependency-edge allowlist for platform-neutral code that still
 * reaches directly into the legacy Lark implementation.
 *
 * Keep entries exact (repo-relative file + literal module specifier). During
 * the strangler migration, remove an entry as soon as the corresponding edge
 * is routed through a platform port/runtime. Exact comparison below makes a
 * newly introduced edge fail loudly instead of silently expanding the debt.
 * `src/core/types.ts` is intentionally absent: the core session model has a
 * stricter zero-Lark-types invariant asserted separately.
 */
const LEGACY_LARK_IMPORTS = new Set([
  'src/core/closed-session-card.ts -> ../im/lark/card-builder.js',
  'src/core/command-handler.ts -> ../im/lark/card-builder.js',
  'src/core/command-handler.ts -> ../im/lark/client.js',
  'src/core/command-handler.ts -> ../im/lark/doc-comment.js',
  'src/core/command-handler.ts -> ../im/lark/event-dispatcher.js',
  'src/core/command-handler.ts -> ../im/lark/lark-hosts.js',
  'src/core/command-handler.ts -> ../im/lark/relay-target-routing.js',
  'src/core/dashboard-command/groups.ts -> ../../im/lark/client.js',
  'src/core/dashboard-command/groups.ts -> ../../im/lark/groups-card.js',
  'src/core/dashboard-command/index.ts -> ../../im/lark/client.js',
  'src/core/dashboard-command/overview.ts -> ../../im/lark/client.js',
  'src/core/dashboard-command/overview.ts -> ../../im/lark/overview-card.js',
  'src/core/dashboard-command/schedules.ts -> ../../im/lark/client.js',
  'src/core/dashboard-command/schedules.ts -> ../../im/lark/schedules-card.js',
  'src/core/dashboard-command/sessions.ts -> ../../im/lark/client.js',
  'src/core/dashboard-command/sessions.ts -> ../../im/lark/sessions-card.js',
  'src/core/dashboard-command/settings.ts -> ../../im/lark/client.js',
  'src/core/dashboard-command/settings.ts -> ../../im/lark/settings-card.js',
  'src/core/dashboard-command/workflows.ts -> ../../im/lark/client.js',
  'src/core/dashboard-command/workflows.ts -> ../../im/lark/workflows-card.js',
  'src/core/dashboard-ipc-server.ts -> ../im/lark/card-builder.js',
  'src/core/dashboard-ipc-server.ts -> ../im/lark/client.js',
  'src/core/dashboard-ipc-server.ts -> ../im/lark/message-parser.js',
  'src/core/dashboard-rows.ts -> ../im/lark/identity-cache.js',
  'src/core/dashboard-rows.ts -> ../im/lark/lark-hosts.js',
  'src/core/session-manager.ts -> ../im/lark/card-builder.js',
  'src/core/session-manager.ts -> ../im/lark/card-handler.js',
  'src/core/session-manager.ts -> ../im/lark/client.js',
  'src/core/session-manager.ts -> ../im/lark/message-parser.js',
  'src/core/trigger-session.ts -> ../im/lark/card-handler.js',
  'src/core/trigger-session.ts -> ../im/lark/client.js',
  'src/core/worker-pool.ts -> ../im/lark/card-builder.js',
  'src/core/worker-pool.ts -> ../im/lark/client.js',
  'src/core/worker-pool.ts -> ../im/lark/doc-comment.js',
  'src/core/worker-pool.ts -> ../im/lark/lark-hosts.js',
  'src/core/worker-pool.ts -> ../im/lark/md-card.js',
]);

function sourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFilesUnder(full));
    } else if (/\.(?:[cm]?ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function filesInNeutralLayers(): string[] {
  return [
    ...sourceFilesUnder(join(REPO_ROOT, 'src/core')),
    join(REPO_ROOT, 'src/worker.ts'),
    ...sourceFilesUnder(join(REPO_ROOT, 'src/adapters/cli')),
    ...sourceFilesUnder(join(REPO_ROOT, 'src/adapters/backend')),
  ];
}

function literalText(node: ts.Node | undefined): string | undefined {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
    return node.text;
  }
  return undefined;
}

function importedSpecifiers(file: string): string[] {
  const source = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, kind);
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    // Static imports and `export ... from '...'` re-exports.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = literalText(node.moduleSpecifier);
      if (specifier) specifiers.push(specifier);
    }

    // TypeScript's `import foo = require('...')` static-import form.
    if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      const specifier = literalText(node.moduleReference.expression);
      if (specifier) specifiers.push(specifier);
    }

    // Runtime dynamic imports: `await import('...')`.
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = literalText(node.arguments[0]);
      if (specifier) specifiers.push(specifier);
    }

    // Type-position imports: `import('...').SomeType`.
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const specifier = literalText(node.argument.literal);
      if (specifier) specifiers.push(specifier);
    }

    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

function isDirectLarkImport(specifier: string): boolean {
  return /(?:^|\/)im\/lark(?:\/|$)/.test(specifier.replaceAll('\\', '/'));
}

function directLarkImportEdges(): Set<string> {
  const edges = new Set<string>();
  for (const file of filesInNeutralLayers()) {
    const repoRelative = relative(REPO_ROOT, file).replaceAll('\\', '/');
    for (const specifier of importedSpecifiers(file)) {
      if (isDirectLarkImport(specifier)) {
        edges.add(`${repoRelative} -> ${specifier}`);
      }
    }
  }
  return edges;
}

describe('platform architecture boundary', () => {
  it('does not add direct im/lark dependency edges to platform-neutral layers', () => {
    const actual = directLarkImportEdges();
    const unexpected = [...actual].filter(edge => !LEGACY_LARK_IMPORTS.has(edge)).sort();
    const staleAllowlist = [...LEGACY_LARK_IMPORTS].filter(edge => !actual.has(edge)).sort();

    expect({ unexpected, staleAllowlist }).toEqual({ unexpected: [], staleAllowlist: [] });
  });

  it('keeps the core session model free of Lark-specific types and imports', () => {
    const file = join(REPO_ROOT, 'src/core/types.ts');
    const source = readFileSync(file, 'utf8');
    const larkImports = importedSpecifiers(file).filter(isDirectLarkImport);

    expect(larkImports).toEqual([]);
    for (const forbidden of ['LarkAttachment', 'LarkMention', 'ResolvedSender']) {
      expect(source, `src/core/types.ts must not contain ${forbidden}`).not.toMatch(
        new RegExp(`\\b${forbidden}\\b`),
      );
    }
  });
});
