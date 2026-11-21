import type { Rectangle, Point } from 'electron';
import type { PixelRect } from '../shared';

type Surface = 'badge' | 'compact' | 'card';
const sizes = { badge: [32, 32], compact: [180, 38], card: [328, 272] } as const;
const gap = 9;

const overlaps = (a: Rectangle, b: Rectangle) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export function selectionPosition(work: Rectangle, pointer: Point, rectangles: PixelRect[], surface: Surface): Rectangle | null {
  const [desiredWidth, desiredHeight] = sizes[surface];
  const width = Math.min(desiredWidth, work.width);
  const height = Math.min(desiredHeight, work.height);
  const anchor = rectangles.at(-1) ?? { ...pointer, width: 0, height: 0 };
  const right = anchor.x + anchor.width;
  const bottom = anchor.y + anchor.height;
  const fit = (x: number, y: number) => ({
    x: Math.max(work.x, Math.min(work.x + work.width - width, x)),
    y: Math.max(work.y, Math.min(work.y + work.height - height, y)), width, height,
  });
  const choices = [
    fit(right + gap, bottom + gap), fit(right + gap, anchor.y - height - gap),
    fit(right + gap, anchor.y), fit(anchor.x - width - gap, anchor.y),
    fit(pointer.x + 12, pointer.y + 15), fit(pointer.x - width - 12, pointer.y - height - 15),
    fit(work.x + work.width - width, work.y + work.height - height), fit(work.x, work.y + work.height - height),
  ];
  return choices.find(choice => !rectangles.some(rect => overlaps(choice, rect))) ?? null;
}
