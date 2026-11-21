import assert from 'node:assert/strict';
import test from 'node:test';
import { matchElements, sanitizeInspection } from '../src/main/element-detector';

const target = { id: '11:22:33', title: 'Terminal', executable: 'Example.exe' };
const geometry = { bounds: { x: -500, y: 80, width: 600, height: 360 }, dpi: 144, foreground: true };
const rawButton = (id: string, name: string, extra = {}) => ({
  elementId: id, name, automationId: '', controlType: 50000,
  boundingRectangle: { x: -430, y: 155, width: 120, height: 37 },
  isEnabled: true, isOffscreen: false, processId: 22, parentId: ':1', childrenIds: [], ...extra,
});

test('matches normalized labels, marks equal names as ambiguous, filters stale and foreign elements', () => {
  const inspection = sanitizeInspection(target, { geometry, tree: { truncated: false, elements: [
    rawButton(':1', 'Root', { parentId: null, controlType: 50032 }), rawButton(':2', '买入 开仓'),
    rawButton(':3', '查看详情'), rawButton(':4', '查看详情'),
    rawButton(':5', '买入开仓', { isOffscreen: true }),
    rawButton(':6', '买入开仓', { processId: 99 }),
    rawButton(':7', 'API Key'), rawButton(':8', 'Value in a field', { controlType: 50004 }),
  ] } });
  assert.equal(inspection.status, 'ready');
  assert.equal(inspection.elements.find(item => item.elementId === ':2')?.role, 'button');
  assert.deepEqual(matchElements(inspection, { name: '买入开仓' }).candidates.map(item => item.elementId), [':2']);
  assert.equal(matchElements(inspection, { name: '查看详情' }).status, 'candidates');
  assert.deepEqual(inspection.elements.find(item => item.elementId === ':1')?.childrenIds, [':2', ':3', ':4', ':5']);
});
