import assert from 'node:assert/strict';
import test from 'node:test';
import { imageToScreen, regionUnits, screenToImage } from '../src/main/roi';

test('rejects coordinate overflow and reverses ROI/global coordinates on a negative-origin display', () => {
  assert.throws(() => regionUnits({ x: 0.9, y: 0.9, width: 0.2, height: 0.1 }));
  assert.throws(() => regionUnits({ x: 0, y: 0, width: 0.5, height: NaN }));
  const frame = { geometry: { bounds: { x: -1024, y: -30, width: 800, height: 600 }, dpi: 144, foreground: true },
    frameSize: { width: 800, height: 600 }, pixels: { x: 100, y: 50, width: 200, height: 100 } };
  const roi = { x: 0.25, y: 0.2, width: 0.5, height: 0.6 };
  const screen = imageToScreen(roi, frame);
  assert.deepEqual(screen, { x: -874, y: 40, width: 100, height: 60 });
  assert.deepEqual(screenToImage(screen!, frame), roi);
  assert.equal(imageToScreen(roi, { ...frame, frameSize: { width: 799, height: 600 } }), null);
});
