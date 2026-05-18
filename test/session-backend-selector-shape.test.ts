import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('session backend selector shape', () => {
  it('does not expose dead tmuxBackend compatibility state', () => {
    const source = readFileSync(join(process.cwd(), 'src/adapters/backend/session-backend-selector.ts'), 'utf8');
    expect(source).not.toContain('tmuxBackend');
  });
});
