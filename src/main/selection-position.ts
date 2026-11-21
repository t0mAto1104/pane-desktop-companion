import type { Rectangle, Point } from 'electron';
import type { PixelRect } from '../shared';

const overlaps = (a: Rectangle, b: Rectangle) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export function selectionPosition(work: Rectangle, pointer: Point, rectangles: PixelRect[], tall: boolean): Rectangle | null {
  const width = Math.min(tall ? 328 : 180, work.width);
  const height = Math.min(tall ? 272 : 38, work.height);
  const anchor = rectangles.at(-1) ?? { ...pointer, width: 0, height: 0 };
  const fit = (x: number, y: number) => ({
    x: Math.max(work.x, Math.min(work.x + work.width - width, x)),
    y: Math.max(work.y, Math.min(work.y + work.height - height, y)), width, height,
  });
  const choices = [
    fit(anchor.x, anchor.y + anchor.height + 9), fit(anchor.x, anchor.y - height - 9),
    fit(anchor.x + anchor.width + 9, anchor.y), fit(anchor.x - width - 9, anchor.y),
    fit(pointer.x + 12, pointer.y + 15), fit(pointer.x - width - 12, pointer.y - height - 15),
    fit(work.x, work.y + work.height - height), fit(work.x + work.width - width, work.y),
  ];
  return choices.find(choice => !rectangles.some(rect => overlaps(choice, rect))) ?? null;
}
