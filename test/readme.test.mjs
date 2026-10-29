// README.md and README.it.md say the same things in two languages. A test
// cannot check a translation, but it can check the shape: the same headings
// at the same levels, the same tables with the same number of rows, the same
// code blocks in the same order. A section added to one and not the other
// fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function shape(file) {
  const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const out = [];
  let fence = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      fence = !fence;
      out.push(fence ? `code ${line.slice(3)}` : 'end');
    } else if (fence) {
      continue;
    } else if (/^#+ /.test(line)) {
      out.push(line.match(/^#+/)[0]);
    } else if (line.startsWith('|')) {
      out.push('row');
    }
  }
  return out;
}

test('the English and Italian READMEs have the same shape', () => {
  assert.deepEqual(shape('README.it.md'), shape('README.md'));
});
