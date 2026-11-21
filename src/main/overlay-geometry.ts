import type { PixelRect } from '../shared';
import { contains, positiveRect } from './element-detector';

type Point = { x: number; y: number };
type Display = { id: number; bounds: PixelRect; scaleFactor: number };
type Coordinates = {
  toDip: (point: Point) => Point;
  toScreen: (point: Point) => Point;
  displayAt: (point: Point) => Display;
};

export function safeOverlayBounds(rect: PixelRect, dpi: number, coordinates: Coordinates) {
  if (!positiveRect(rect)) return null;
  const origin = { x: rect.x, y: rect.y };
  const end = { x: rect.x + rect.width, y: rect.y + rect.height };
  const a = coordinates.toDip(origin);
  const b = coordinates.toDip(end);
  const last = coordinates.toDip({ x: end.x - 1, y: end.y - 1 });
  const display = coordinates.displayAt(a);
  const convert = { x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y };
  const scale = display.scaleFactor;
  const roundTrip = (screen: Point, dip: Point) => {
    const mapped = coordinates.toScreen(dip);
    return Math.abs(mapped.x - screen.x) <= 2 && Math.abs(mapped.y - screen.y) <= 2;
  };
  if (scale <= 0 || Math.abs(scale - dpi / 96) > 0.03 || display.id !== coordinates.displayAt(last).id ||
      !contains(display.bounds, convert) || Math.abs(convert.width - rect.width / scale) > 2 ||
      Math.abs(convert.height - rect.height / scale) > 2 || !roundTrip(origin, a) || !roundTrip(end, b)) return null;
  return { bounds: convert, displayId: display.id };
}
