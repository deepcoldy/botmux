import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const HAN = /[\u3400-\u9fff]/u;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function isLoggerCall(node: ts.CallExpression): boolean {
  if (!ts.isPropertyAccessExpression(node.expression)) return false;
  const receiver = node.expression.expression;
  return (ts.isIdentifier(receiver) && receiver.text === 'logger')
    || (ts.isPropertyAccessExpression(receiver) && receiver.name.text === 'logger');
}

describe('runtime log language', () => {
  it('keeps all static logger copy in English', () => {
    const violations: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const sourceText = readFileSync(file, 'utf8');
      const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node) && isLoggerCall(node)) {
          const args = node.arguments.map(arg => arg.getText(source)).join(' ');
          if (HAN.test(args)) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            violations.push(`${file.slice(SOURCE_ROOT.length + 1)}:${line}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(violations).toEqual([]);
  });
});
