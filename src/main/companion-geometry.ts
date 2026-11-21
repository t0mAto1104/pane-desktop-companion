import type { Point, Rectangle } from 'electron';

export const mascotSize = { width: 94, height: 96 };
export const panelSize = { width: 404, height: 536 };
const margin = 12;

export function fittedWindow(work: Rectangle, size: { width: number; height: number }, position: Point): Rectangle {
  const width = Math.min(size.width, work.width);
  const height = Math.min(size.height, work.height);
  return {
    x: Math.max(work.x, Math.min(work.x + work.width - width, position.x)),
    y: Math.max(work.y, Math.min(work.y + work.height - height, position.y)),
    width, height,
  };
}

export function mascotBounds(work: Rectangle, position?: Point): Rectangle {
  return fittedWindow(work, mascotSize, position ?? {
    x: work.x + work.width - mascotSize.width - 22,
    y: work.y + work.height - mascotSize.height - 24,
  });
}

export function panelBounds(work: Rectangle, mascot: Rectangle): Rectangle {
  const left = mascot.x - panelSize.width - margin;
  const right = mascot.x + mascot.width + margin;
  const x = right + panelSize.width <= work.x + work.width ? right : left;
  const fitsSide = x >= work.x;
  return fittedWindow(work, panelSize, {
    x: fitsSide ? x : mascot.x,
    y: fitsSide ? mascot.y + mascot.height - panelSize.height : mascot.y - panelSize.height - margin,
  });
}

export function savedPoint(value: unknown): Point | undefined {
  if (typeof value !== 'object' || value === null || !('x' in value) || !('y' in value)) return;
  const { x, y } = value;
  if (typeof x === 'number' && typeof y === 'number' && Number.isInteger(x) && Number.isInteger(y)
      && Math.abs(x) < 200_000 && Math.abs(y) < 200_000) return { x, y };
}
