import { test } from 'node:test';
import { execSync } from 'node:child_process';
const ROUND_START_SHA = '9e24aa4';
test('anti-scope', () => { execSync(`git diff ${ROUND_START_SHA}..HEAD --name-only`); });
