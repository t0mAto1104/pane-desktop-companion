import assert from 'node:assert/strict';
import test from 'node:test';
import { selectionPosition } from '../src/main/selection-position';
import { selectionText } from '../src/selection';

test('badge and hover actions start just below the lower-right edge of the selection', () => {
  const work = { x: 0, y: 0, width: 1440, height: 900 };
  const lines = [{ x: 100, y: 200, width: 460, height: 20 }, { x: 100, y: 222, width: 230, height: 20 }];
  const pointer = { x: 329, y: 241 };
  assert.deepEqual(selectionPosition(work, pointer, lines, 'badge'), { x: 339, y: 251, width: 32, height: 32 });
  assert.deepEqual(selectionPosition(work, pointer, lines, 'compact'), { x: 339, y: 251, width: 180, height: 38 });
});

test('toolbar stays on the selected monitor and leaves every selected line unobscured', () => {
  const work = { x: -1920, y: 0, width: 1920, height: 1040 };
  const lines = [{ x: -220, y: 940, width: 180, height: 20 }, { x: -220, y: 966, width: 180, height: 20 }];
  const placed = selectionPosition(work, { x: -130, y: 981 }, lines, 'compact')!;
  assert.ok(placed.x >= work.x && placed.x + placed.width <= 0);
  assert.ok(lines.every(line => placed.y + placed.height <= line.y || placed.y >= line.y + line.height ||
    placed.x + placed.width <= line.x || placed.x >= line.x + line.width));
  assert.equal(selectionPosition(work, { x: -1, y: 1 }, [work], 'compact'), null);
});

test('the limit counts Unicode characters and refuses instead of truncating', () => {
  const text = '🌏'.repeat(3000);
  assert.equal(selectionText(text), text);
  assert.throws(() => selectionText(text + '英'), /3000/);
  assert.equal(selectionText('  \n\t '), '');
});
