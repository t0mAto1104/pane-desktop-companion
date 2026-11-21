import type { ElementQuery, PixelRect, Target, UiElement, UiInspection, UiMatch, WindowGeometry } from '../shared';
import { UserError } from './native';

const roles: Record<number, string> = {
  50000: 'button', 50002: 'checkbox', 50003: 'combobox', 50004: 'edit', 50005: 'link',
  50006: 'image', 50007: 'listitem', 50008: 'list', 50010: 'menu', 50011: 'menuitem',
  50013: 'radio', 50014: 'scrollbar', 50015: 'slider', 50018: 'tab', 50019: 'tabitem',
  50020: 'text', 50023: 'tree', 50024: 'treeitem', 50025: 'custom', 50026: 'group',
  50028: 'grid', 50029: 'row', 50030: 'document', 50031: 'splitbutton', 50032: 'window',
  50033: 'pane', 50035: 'header', 50036: 'table', 50037: 'titlebar',
};

export const classify = (control: number) => roles[control] ?? 'control';
const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
const sensitive = /password|passcode|secret.?key|api.?key|access.?token|credential|密码|验证码|私钥|密钥|凭据/i;
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= 400;
export const positiveRect = (r: PixelRect) => r && [r.x, r.y, r.width, r.height].every(Number.isSafeInteger) &&
  Math.abs(r.x) < 100_000 && Math.abs(r.y) < 100_000 && r.width > 0 && r.height > 0 && r.width <= 30_000 && r.height <= 30_000;
export const sameRect = (a: PixelRect, b: PixelRect) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
export const contains = (area: PixelRect, r: PixelRect) => positiveRect(r) &&
  r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height;
export const sameGeometry = (a: WindowGeometry, b: WindowGeometry) => sameRect(a.bounds, b.bounds) && a.dpi === b.dpi;
export const visible = (item: UiElement, bounds: PixelRect) => !item.isOffscreen && contains(bounds, item.boundingRectangle);

type Raw = { geometry: WindowGeometry; tree: { elements: Array<Omit<UiElement, 'role'>>; truncated: boolean } };

export function sanitizeInspection(target: Target, raw: Raw): UiInspection {
  if (!raw?.geometry || !positiveRect(raw.geometry.bounds) || !Number.isInteger(raw.geometry.dpi) ||
      raw.geometry.dpi < 48 || raw.geometry.dpi > 768 || !Array.isArray(raw.tree?.elements)) {
    throw new UserError('Windows 返回了无效的界面控件布局。');
  }
  const pid = Number(target.id.split(':')[1]);
  const byId = new Map<string, UiElement>();
  for (const item of raw.tree.elements.slice(0, 180)) {
    if (!item || !isText(item.elementId) || !/^(:-?\d+)+$/.test(item.elementId) ||
        byId.has(item.elementId) || item.processId !== pid || !isText(item.name) ||
        !isText(item.automationId) || sensitive.test(item.name + ' ' + item.automationId) ||
        !Number.isInteger(item.controlType) || item.controlType === 50004) continue;
    byId.set(item.elementId, { elementId: item.elementId, name: item.name, automationId: item.automationId,
      controlType: item.controlType, role: classify(item.controlType), boundingRectangle: item.boundingRectangle,
      isEnabled: item.isEnabled === true, isOffscreen: item.isOffscreen !== false,
      processId: item.processId, parentId: typeof item.parentId === 'string' ? item.parentId : null, childrenIds: [] });
  }
  for (const item of byId.values()) {
    const parent = item.parentId ? byId.get(item.parentId) : undefined;
    if (parent && parent !== item) parent.childrenIds.push(item.elementId);
    else item.parentId = null;
  }
  const elements = [...byId.values()];
  const usable = elements.some(item => item.parentId && item.name && visible(item, raw.geometry.bounds));
  return { target, geometry: raw.geometry, elements, truncated: raw.tree.truncated || raw.tree.elements.length > 180,
    status: usable ? 'ready' : 'unavailable',
    reason: usable ? undefined : '此窗口没有暴露可用的 UI Automation 控件。可改用截图定位。' };
}

export function cleanQuery(query: ElementQuery): ElementQuery {
  if (!query || typeof query !== 'object' || Array.isArray(query) ||
      [query.name, query.automationId, query.role].some(value => value !== undefined && !isText(value)) ||
      ![query.name, query.automationId].some(value => value && normalize(value))) throw new UserError('请输入控件名称或自动化 ID。');
  return { name: query.name?.trim(), automationId: query.automationId?.trim(), role: query.role?.trim() };
}

export function matchElements(inspected: UiInspection, input: ElementQuery): UiMatch {
  const query = cleanQuery(input);
  const name = normalize(query.name ?? '');
  const id = normalize(query.automationId ?? '');
  const ranked = inspected.elements.flatMap(item => {
    if (!visible(item, inspected.geometry.bounds) || !item.parentId || (query.role && query.role !== item.role)) return [];
    const label = normalize(item.name);
    const automation = normalize(item.automationId);
    if (id && id !== automation) return [];
    const score = id ? 120 : label && label === name ? 100
      : label.length > 1 && (label.includes(name) || name.includes(label)) ? Math.min(70, 25 + Math.min(label.length, name.length)) : 0;
    return score ? [{ item, score: score + Number(item.isEnabled) }] : [];
  }).sort((a, b) => b.score - a.score || a.item.elementId.localeCompare(b.item.elementId));
  const candidates = ranked.slice(0, 6).map(entry => entry.item);
  const first = ranked[0];
  const unique = first && first.score >= 100 && (!ranked[1] || first.score - ranked[1].score >= 10);
  return { status: !candidates.length ? 'missing' : unique ? 'matched' : 'candidates', candidates };
}

export class ElementDetector {
  constructor(private readonly read: (target: Target, denied: string[], signal: AbortSignal) => Promise<Raw>) {}

  async inspect(target: Target, denied: string[], signal: AbortSignal): Promise<UiInspection> {
    signal.throwIfAborted();
    const raw = await this.read(target, denied, signal);
    signal.throwIfAborted();
    return sanitizeInspection(target, raw);
  }

  async get(target: Target, denied: string[], id: string, signal: AbortSignal) {
    if (!isText(id) || !/^(:-?\d+)+$/.test(id)) throw new UserError('无效的控件标识。');
    const inspected = await this.inspect(target, denied, signal);
    const element = inspected.elements.find(item => item.elementId === id);
    return element && visible(element, inspected.geometry.bounds) ? { element, geometry: inspected.geometry } : null;
  }
}
