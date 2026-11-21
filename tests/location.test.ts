import assert from 'node:assert/strict';
import test from 'node:test';
import { LocationEngine, visualCandidates } from '../src/main/location';
import { ElementDetector } from '../src/main/element-detector';

const target = { id: '1:20:3', title: 'Custom application', executable: 'Fixture.exe' };
const geometry = { bounds: { x: -800, y: 20, width: 600, height: 400 }, dpi: 144, foreground: true };
const scope = { target, denied: [], signal: new AbortController().signal };
const region = { x: .1, y: .2, width: .3, height: .2 };

test('visual parser excludes invalid or oversized locations', () => {
  const response = visualCandidates({ answer: 'A candidate', candidates: [
    { label: 'Valid', region }, { label: 'Out of range', region: { ...region, x: -.1 } },
    { label: 'Too broad', region: { x: 0, y: 0, width: 1, height: 1 } },
  ] });
  assert.deepEqual(response.candidates, [{ label: 'Valid', region }]);
});

test('vision requires opt-in, then a verified geometry and current observation before physical display', async () => {
  let queries = 0;
  let current = true;
  let jpeg = 'jpeg';
  const detector = new ElementDetector(async () => ({ geometry, tree: { elements: [], truncated: false } }));
  const engine = new LocationEngine(detector, async () => ({
    observationId: 'obs', capture: { target, geometry, id: 'region', region,
      frameSize: { width: 600, height: 400 }, pixels: { x: 0, y: 0, width: 600, height: 400 },
      capturedAt: 1, image: jpeg },
  }), async (_instructions, _input, image) => {
    assert.equal(image, 'jpeg');
    queries++;
    return { candidates: [{ label: 'Button', region }] };
  }, async () => current);
  assert.equal((await engine.locate(scope, { name: 'Button' }, false)).status, 'unavailable');
  assert.equal(queries, 0);
  const located = await engine.locate(scope, { name: 'Button' }, true);
  assert.equal(located.status, 'visual');
  const ids = [located.candidates[0].id];
  assert.equal(engine.eligible(ids, target), true);
  jpeg = 'different JPEG';
  assert.equal(await engine.resolve(ids, scope, geometry), null);
  jpeg = 'jpeg';
  const displayed = await engine.resolve(ids, scope, geometry);
  assert.deepEqual(displayed?.[0].rect, { x: -740, y: 100, width: 180, height: 80 });
  current = false;
  assert.equal(await engine.resolve(ids, scope, geometry), null);
  engine.clear();
  assert.equal(engine.eligible(ids, target), false);
});
