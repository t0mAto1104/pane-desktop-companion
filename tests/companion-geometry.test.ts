import assert from 'node:assert/strict';
import test from 'node:test';
import { companionOptions } from '../src/shared';
import { mascotBounds, panelBounds, savedPoint } from '../src/main/companion-geometry';

test('existing profiles default to the robot and invalid saved positions are ignored', () => {
  assert.deepEqual(companionOptions({}), { companionEnabled: true, companionSkin: 'orbit' });
  assert.deepEqual(companionOptions({ companionEnabled: false, companionSkin: 'fox' }), { companionEnabled: false, companionSkin: 'fox' });
  assert.equal(savedPoint({ x: -625, y: 30 })?.x, -625);
  assert.equal(savedPoint({ x: Infinity, y: 0 }), undefined);
});

test('mascot and chat stay within a negative-origin work area', () => {
  const area = { x: -1920, y: 70, width: 1600, height: 1000 };
  const wrapped = mascotBounds(area, { x: 999, y: 1900 });
  assert.equal(wrapped.x + wrapped.width, area.x + area.width);
  assert.equal(wrapped.y + wrapped.height, area.y + area.height);
  assert.ok(panelBounds(area, wrapped).x < wrapped.x);
  const left = mascotBounds(area, { x: -3000, y: 10 });
  assert.equal(left.x, area.x);
  assert.equal(left.y, area.y);
  assert.ok(panelBounds(area, left).x >= left.x + left.width);
  const narrow = { x: 0, y: 0, width: 350, height: 470 };
  assert.equal(panelBounds(narrow, mascotBounds(narrow)).width, narrow.width);
});
