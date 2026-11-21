import type { PixelRect, RegionCapture, ScreenRegion } from '../shared';
import { UserError } from './native';
import { contains } from './element-detector';

export const REGION_SCALE = 1_000_000;

export function regionUnits(region: ScreenRegion): [number, number, number, number] {
  if (!region || typeof region !== 'object') throw new UserError('请选择有效的截图区域。');
  const { x, y, width, height } = region;
  if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 ||
      width < 0.001 || height < 0.001 || x + width > 1.000000001 || y + height > 1.000000001) {
    throw new UserError('截图区域为空或超出目标窗口。');
  }
  const left = Math.round(x * REGION_SCALE);
  const top = Math.round(y * REGION_SCALE);
  const right = Math.min(REGION_SCALE, Math.round((x + width) * REGION_SCALE));
  const bottom = Math.min(REGION_SCALE, Math.round((y + height) * REGION_SCALE));
  return [left, top, right - left, bottom - top];
}

export function imageToScreen(region: ScreenRegion, capture: Pick<RegionCapture, 'frameSize' | 'pixels' | 'geometry'>): PixelRect | null {
  let units: ReturnType<typeof regionUnits>;
  try { units = regionUnits(region); } catch { return null; }
  const { bounds } = capture.geometry;
  const { pixels, frameSize } = capture;
  // WGC window frames can differ from DWM's physical bounds. Do not infer an offset.
  if (bounds.width !== frameSize.width || bounds.height !== frameSize.height ||
      !contains({ x: 0, y: 0, ...frameSize }, pixels)) return null;
  const [x, y, width, height] = units;
  const left = Math.floor(pixels.x + pixels.width * x / REGION_SCALE);
  const top = Math.floor(pixels.y + pixels.height * y / REGION_SCALE);
  const right = Math.ceil(pixels.x + pixels.width * (x + width) / REGION_SCALE);
  const bottom = Math.ceil(pixels.y + pixels.height * (y + height) / REGION_SCALE);
  const rect = { x: bounds.x + left, y: bounds.y + top, width: right - left, height: bottom - top };
  return contains(bounds, rect) ? rect : null;
}
export const FULL_REGION: ScreenRegion = { x: 0, y: 0, width: 1, height: 1 };

export function screenToImage(rect: PixelRect, capture: Pick<RegionCapture, 'frameSize' | 'pixels' | 'geometry'>): ScreenRegion | null {
  const full = imageToScreen(FULL_REGION, capture);
  return full && contains(full, rect) ? {
    x: (rect.x - full.x) / full.width, y: (rect.y - full.y) / full.height,
    width: rect.width / full.width, height: rect.height / full.height,
  } : null;
}
