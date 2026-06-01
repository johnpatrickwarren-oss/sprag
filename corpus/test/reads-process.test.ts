import { test } from 'node:test';
import { readFileSync } from 'node:fs';
test('hygiene', () => { readFileSync('coordination/MEMORIAL.md', 'utf8'); });
