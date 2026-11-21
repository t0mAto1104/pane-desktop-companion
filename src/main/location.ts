import { randomUUID } from 'node:crypto';
import type { ElementQuery, LocatedCandidate, LocationResult, PixelRect, RegionCapture, ScreenRegion, Target, UiElement, WindowGeometry } from '../shared';
import { boundedText, object, type DesktopQuery } from './desktop-query';
import { cleanQuery, contains, matchElements, sameGeometry, sameRect, type ElementDetector } from './element-detector';
import { sameTarget, UserError } from './native';
import { FULL_REGION, imageToScreen, regionUnits } from './roi';

export type ToolScope = { target: Target; denied: string[]; signal: AbortSignal };
export type Evidence = { capture: RegionCapture; observationId?: string };
type VisualAnchor = { evidence: Evidence; checked: boolean };
type Anchor = { target: Target; candidate: LocatedCandidate } &
  ({ element: UiElement } | { visual: VisualAnchor; rect: PixelRect | null });

export function visualCandidates(value: unknown) {
  const decoded = object(value);
  const answer = boundedText(decoded?.answer, 420);
  const candidates: { label: string; region: ScreenRegion }[] = [];
  for (const value of Array.isArray(decoded?.candidates) ? decoded.candidates.slice(0, 3) : []) {
    const candidate = object(value);
    const label = boundedText(candidate?.label, 85);
    const rect = object(candidate?.region);
    if (!label || !rect) continue;
    const region = { x: rect.x, y: rect.y, width: rect.width, height: rect.height } as ScreenRegion;
    try { regionUnits(region); } catch { continue; }
    if (region.width * region.height > 0.55) continue;
    candidates.push({ label, region });
  }
  return { answer, candidates };
}

export class LocationEngine {
  private readonly anchors = new Map<string, Anchor>();
  private request?: AbortController;

  constructor(private readonly detector: ElementDetector,
              private readonly evidence: (scope: ToolScope, region: ScreenRegion) => Promise<Evidence>,
              private readonly query: DesktopQuery,
              private readonly validateObservation: (id: string, scope: ToolScope) => Promise<boolean>) {}

  clear() { this.request?.abort(); this.request = undefined; this.anchors.clear(); }

  async locate(scope: ToolScope, query: ElementQuery, allowVision: boolean, region?: ScreenRegion): Promise<LocationResult> {
    const lookup = cleanQuery(query);
    this.clear();
    const controller = new AbortController();
    this.request = controller;
    scope = { ...scope, signal: AbortSignal.any([scope.signal, controller.signal]) };
    let local: string | undefined;
    try {
      const inspected = await this.detector.inspect(scope.target, scope.denied, scope.signal);
      const found = matchElements(inspected, lookup);
      if (found.candidates.length) {
        const candidates = found.candidates.map(element => this.rememberElement(scope.target, element));
        return { status: found.status === 'matched' ? 'verified' : 'ambiguous', candidates,
          reason: found.status === 'matched' ? undefined : '有多个或部分匹配的控件，请核对后选择。' };
      }
      local = inspected.reason;
    } catch (error) {
      scope.signal.throwIfAborted();
      local = error instanceof UserError ? error.message : '无法读取目标窗口的 UI Automation 树。';
    }
    if (!allowVision) return { status: 'unavailable', candidates: [], reason: local ?? '没有可验证的控件。可明确启用图像定位。' };
    const evidence = await this.evidence(scope, region ?? FULL_REGION);
    const found = visualCandidates(await this.query(
      'Return {answer:string,candidates:[{label:string,region:{x:number,y:number,width:number,height:number}}]}. ' +
      'Use at most three candidates. Coordinates are normalized to the provided image; use [] if uncertain. Describe the control without claiming exact position.',
      JSON.stringify({ requestedControl: lookup }), evidence.capture.image, scope.signal));
    scope.signal.throwIfAborted();
    const visual = { evidence, checked: false };
    const candidates = found.candidates.map(item => {
      const rect = imageToScreen(item.region, evidence.capture);
      const candidate: LocatedCandidate = { id: randomUUID(), source: 'vision', name: item.label, region: item.region,
        canHighlight: !!rect && !!evidence.observationId };
      this.anchors.set(candidate.id, { target: scope.target, candidate, visual, rect });
      return candidate;
    });
    return { status: candidates.length ? 'visual' : 'unavailable', candidates,
      image: candidates.length ? evidence.capture : undefined, answer: found.answer || undefined,
      reason: candidates.length ? '图像定位是候选区域，请先核对截图。' : '没有可确认的图像候选区域。' };
  }

  private rememberElement(target: Target, element: UiElement): LocatedCandidate {
    const candidate: LocatedCandidate = { id: randomUUID(), source: 'uia', name: element.name || element.automationId,
      elementId: element.elementId, role: element.role, enabled: element.isEnabled, canHighlight: true };
    this.anchors.set(candidate.id, { target, element, candidate });
    return candidate;
  }

  async resolve(ids: string[], scope: ToolScope, geometry: WindowGeometry) {
    const anchors = ids.map(id => this.anchors.get(id));
    if (!geometry.foreground || anchors.some(anchor => !anchor || !sameTarget(anchor.target, scope.target))) return null;
    let inspected: Awaited<ReturnType<ElementDetector['inspect']>> | undefined;
    if (anchors.some(anchor => anchor && 'element' in anchor)) {
      inspected = await this.detector.inspect(scope.target, scope.denied, scope.signal);
      if (!inspected.geometry.foreground || !sameGeometry(geometry, inspected.geometry)) return null;
    }
    const resolved: { name: string; rect: PixelRect; source: LocatedCandidate['source'] }[] = [];
    for (const anchor of anchors) {
      if (!anchor) return null;
      if ('element' in anchor) {
        const item = inspected?.elements.find(node => node.elementId === anchor.element.elementId &&
          node.name === anchor.element.name && node.role === anchor.element.role &&
          (anchor.element.automationId === '' || node.automationId === anchor.element.automationId));
        if (!item || item.isOffscreen || !contains(geometry.bounds, item.boundingRectangle)) return null;
        resolved.push({ name: anchor.candidate.name, rect: item.boundingRectangle, source: 'uia' });
      } else {
        const { evidence } = anchor.visual;
        if (!anchor.rect || !evidence.observationId || !sameGeometry(geometry, evidence.capture.geometry) ||
            !await this.validateObservation(evidence.observationId, scope)) return null;
        if (!anchor.visual.checked) {
          // A prior low-resolution sample alone cannot prove the model saw the same ROI.
          const fresh = await this.evidence(scope, evidence.capture.region);
          if (fresh.observationId !== evidence.observationId || !fresh.capture.geometry.foreground ||
              !sameGeometry(geometry, fresh.capture.geometry) || !sameRect(fresh.capture.pixels, evidence.capture.pixels) ||
              fresh.capture.image !== evidence.capture.image) return null;
          scope.signal.throwIfAborted();
          anchor.visual.checked = true;
        }
        resolved.push({ name: anchor.candidate.name, rect: anchor.rect, source: 'vision' });
      }
    }
    scope.signal.throwIfAborted();
    return resolved;
  }

  eligible(ids: string[], target: Target) {
    return ids.every(id => {
      const anchor = this.anchors.get(id);
      return !!anchor?.candidate.canHighlight && sameTarget(anchor.target, target);
    });
  }
}
