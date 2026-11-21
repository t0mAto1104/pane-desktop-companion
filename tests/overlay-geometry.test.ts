import assert from 'node:assert/strict';
import test from 'node:test';
import { safeOverlayBounds } from '../src/main/overlay-geometry';

test('converts a verified rectangle on a negative-origin 150% display and rejects an ambiguous boundary', () => {
  const left = { id: 1, bounds: { x: -800, y: 0, width: 800, height: 500 }, scaleFactor: 1.5 };
  const right = { id: 2, bounds: { x: 0, y: 0, width: 1000, height: 700 }, scaleFactor: 1 };
  const coords = {
    toDip: ({ x, y }: { x: number; y: number }) => x < 0 ? { x: Math.round(x / 1.5), y: Math.round(y / 1.5) } : { x, y },
    toScreen: ({ x, y }: { x: number; y: number }) => x < 0 ? { x: Math.round(x * 1.5), y: Math.round(y * 1.5) } : { x, y },
    displayAt: ({ x }: { x: number }) => x < 0 ? left : right,
  };
  assert.deepEqual(safeOverlayBounds({ x: -300, y: 150, width: 150, height: 75 }, 144, coords),
    { displayId: 1, bounds: { x: -200, y: 100, width: 100, height: 50 } });
  assert.equal(safeOverlayBounds({ x: -300, y: 150, width: 150, height: 75 }, 120, coords), null);
  assert.equal(safeOverlayBounds({ x: -30, y: 150, width: 60, height: 75 }, 144, coords), null);
});
