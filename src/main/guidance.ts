import { randomUUID } from 'node:crypto';
import type { ElementQuery, GuidanceState, GuidanceStep, ScreenRegion } from '../shared';
import { boundedText, object, type DesktopQuery } from './desktop-query';
import { matchElements, visible, type ElementDetector } from './element-detector';
import type { Evidence, ToolScope } from './location';
import { sameTarget, UserError } from './native';
import { FULL_REGION } from './roi';

function queryFrom(value: unknown): ElementQuery | null {
  const raw = object(value);
  const name = boundedText(raw?.name, 110);
  const automationId = boundedText(raw?.automationId, 110);
  const role = boundedText(raw?.role, 25);
  return name || automationId ? { name: name || undefined, automationId: automationId || undefined, role: role || undefined } : null;
}

export function parseGuidance(value: unknown): GuidanceState {
  const plan = object(value);
  const title = boundedText(plan?.title, 110);
  const steps: GuidanceStep[] = [];
  for (const item of Array.isArray(plan?.steps) ? plan.steps.slice(0, 8) : []) {
    const raw = object(item);
    const stepTitle = boundedText(raw?.title, 95);
    const explanation = boundedText(raw?.explanation, 600);
    const expectedState = boundedText(raw?.expectedState, 220);
    if (!stepTitle || !explanation || !expectedState) continue;
    const targetElement = queryFrom(raw?.targetElement);
    const evidence = queryFrom(raw?.verifyElement);
    const sameControl = evidence && targetElement && (['automationId', 'name'] as const).some(key =>
      evidence[key] && evidence[key]?.toLocaleLowerCase() === targetElement[key]?.toLocaleLowerCase());
    const verification = sameControl ? null : evidence;
    steps.push({ stepId: randomUUID(), title: stepTitle, explanation, targetElement, expectedState,
      verificationMethod: raw?.verificationMethod === 'uia-visible' && verification ? 'uia-visible' : 'manual',
      verifyElement: verification, status: 'pending' });
  }
  if (!title || !steps.length) throw new UserError('模型未返回可用的教学步骤。');
  return { title, steps, index: 0, mode: 'active' };
}

const PLAN_INSTRUCTION = 'Generate read-only user-operated teaching steps, in the user’s language, up to eight steps. ' +
  'For trading tutorials describe verified simulation only. If the environment is uncertain, first require the user to confirm it is a simulation. ' +
  'Never recommend a trade, direction, size or investment. Never make or submit orders. ' +
  'Return {title,steps:[{title,explanation,targetElement:{name,automationId?,role?}|null,expectedState,verificationMethod:"manual"|"uia-visible",verifyElement:{name,automationId?,role?}|null}]}. ' +
  'Choose uia-visible only for a specific observable UI element expected to appear after this step, not the control the user is supposed to operate. ' +
  'If any expected result can only be inferred from pixels or numeric values, use manual verification.';

export class GuidanceEngine {
  private request?: AbortController;
  private session?: { scope: ToolScope; state: GuidanceState; absent: boolean };
  private checking = false;
  private epoch = 0;

  constructor(private readonly detector: ElementDetector,
              private readonly evidence: (scope: ToolScope, region: ScreenRegion) => Promise<Evidence>,
              private readonly query: DesktopQuery,
              private readonly publish: (state: GuidanceState | null) => void) {}

  get state(): GuidanceState | null { return this.session ? structuredClone(this.session.state) : null; }

  clear() {
    this.epoch++;
    this.request?.abort();
    this.request = undefined;
    this.session = undefined;
    this.checking = false;
    this.publish(null);
  }

  async start(scope: ToolScope, task: string, includeImage: boolean, region?: ScreenRegion) {
    if (typeof task !== 'string' || !task.trim() || task.length > 1600 || typeof includeImage !== 'boolean') {
      throw new UserError('请输入 1–1600 字的教学任务。');
    }
    this.clear();
    const controller = new AbortController();
    this.request = controller;
    scope = { ...scope, signal: AbortSignal.any([scope.signal, controller.signal]) };
    let controls: { name: string; role: string }[] = [];
    try {
      const inspected = await this.detector.inspect(scope.target, scope.denied, scope.signal);
      const chosen = inspected.elements.filter(item => item.parentId && item.name && visible(item, inspected.geometry.bounds) &&
        ['button', 'tabitem', 'menuitem', 'checkbox', 'combobox'].includes(item.role));
      chosen.sort((a, b) => Number(task.includes(b.name)) - Number(task.includes(a.name)));
      controls = [...new Map(chosen.map(item => [item.name, { name: item.name, role: item.role }])).values()].slice(0, 18);
    } catch { scope.signal.throwIfAborted(); }
    const image = includeImage ? (await this.evidence(scope, region ?? FULL_REGION)).capture.image : undefined;
    const prepared = parseGuidance(await this.query(PLAN_INSTRUCTION, JSON.stringify({ task: task.trim(), controls }), image, scope.signal));
    scope.signal.throwIfAborted();
    const session = { scope, state: prepared, absent: false };
    this.session = session;
    await this.activate(session);
    return this.state;
  }

  private current(scope: ToolScope) {
    const session = this.session;
    if (!session || !sameTarget(scope.target, session.scope.target) || session.scope.signal.aborted) {
      throw new UserError('没有可用的教学任务。请在当前绑定窗口中重新开始。');
    }
    return session;
  }

  private async activate(session: NonNullable<GuidanceEngine['session']>) {
    const stamp = this.epoch;
    const step = session.state.steps[session.state.index];
    step.status = 'active';
    session.absent = false;
    if (step.verificationMethod === 'uia-visible' && step.verifyElement) {
      const baseline = await this.lookup(session.scope, step.verifyElement);
      if (stamp !== this.epoch || this.session !== session || session.state.mode !== 'active') return;
      session.absent = baseline === 'missing';
    }
    this.publish(this.state);
  }

  private async lookup(scope: ToolScope, query: ElementQuery) {
    try {
      const inspected = await this.detector.inspect(scope.target, scope.denied, scope.signal);
      if (inspected.status !== 'ready' || inspected.truncated) return 'unavailable';
      return matchElements(inspected, query).status;
    } catch { scope.signal.throwIfAborted(); return 'unavailable'; }
  }

  async check(scope: ToolScope) {
    const session = this.current(scope);
    const state = session.state;
    const step = state.steps[state.index];
    if (this.checking || state.mode !== 'active' || !['active', 'blocked'].includes(step.status)) return this.state;
    this.checking = true;
    const stamp = this.epoch;
    try {
      const result = session.absent && step.verificationMethod === 'uia-visible' && step.verifyElement
        ? await this.lookup(session.scope, step.verifyElement) : 'unavailable';
      if (stamp !== this.epoch || this.session !== session || state.mode !== 'active') return this.state;
      if (result === 'matched') { step.status = 'completed'; step.verification = 'uia'; }
      else { step.status = 'blocked'; step.reason = '界面证据不足。请对照预期结果后手动确认。'; }
      this.publish(this.state);
      return this.state;
    } finally { if (stamp === this.epoch) this.checking = false; }
  }

  confirm(scope: ToolScope, skip = false) {
    const { state } = this.current(scope);
    const step = state.steps[state.index];
    if (state.mode !== 'active' || !['active', 'blocked'].includes(step.status)) return this.state;
    this.epoch++;
    this.checking = false;
    step.status = skip ? 'skipped' : 'completed';
    step.verification = skip ? undefined : 'manual';
    step.reason = undefined;
    this.publish(this.state);
    return this.state;
  }

  async next(scope: ToolScope) {
    const session = this.current(scope);
    const { state } = session;
    if (state.mode !== 'active') return this.state;
    if (!['completed', 'skipped'].includes(state.steps[state.index].status)) throw new UserError('请先检查、确认或跳过本步。');
    if (state.index + 1 === state.steps.length) {
      state.mode = 'done';
      this.publish(this.state);
      return this.state;
    }
    this.epoch++;
    state.index++;
    await this.activate(session);
    return this.state;
  }

  async pause(scope: ToolScope, pause: boolean) {
    const session = this.current(scope);
    if (session.state.mode === 'done' || (session.state.mode === 'paused') === pause) return this.state;
    this.epoch++;
    this.checking = false;
    session.state.mode = pause ? 'paused' : 'active';
    const step = session.state.steps[session.state.index];
    if (!pause && ['active', 'blocked'].includes(step.status)) await this.activate(session);
    else this.publish(this.state);
    return this.state;
  }
}
