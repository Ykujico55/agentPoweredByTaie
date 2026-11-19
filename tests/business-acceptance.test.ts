import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBusinessAcceptance } from '../src/business-acceptance.ts';

test('a Java business failure supplies only failing cases to the repair round', () => {
  assert.deepEqual(parseBusinessAcceptance(1, 'PASS named order\nFAIL empty order: expected 0, got 600\n1/2 passed\n'),
    { status: 'failed', failures: ['FAIL empty order: expected 0, got 600'] });
  assert.deepEqual(parseBusinessAcceptance(0, 'PASS empty order\n1/1 passed\n'), { status: 'passed' });
});

test('a Java compile error or an empty suite cannot produce a business verdict', () => {
  assert.throws(() => parseBusinessAcceptance(1, ''));
  assert.throws(() => parseBusinessAcceptance(0, '0/0 passed'));
});
