import type { RecordState, View } from './types';

export const MIN_MOVE_SPEED = 0.01;
export const MAX_MOVE_SPEED = 8;
export const DEFAULT_MOVE_SPEED = 0.35;
export const WHEEL_SPEED_FACTOR = 1.2;

export function wheelSpeedAllowed(context: { controlled: boolean; view: View; recordState: RecordState; followCamera: boolean; ctrlKey: boolean; metaKey: boolean; editing: boolean }): boolean {
  return context.controlled && context.view === '3d' && !context.editing && !context.ctrlKey && !context.metaKey
    && (context.recordState === 'preview' || context.recordState === 'recording')
    && !(context.followCamera && context.recordState === 'preview');
}

/** Normalize pixel, line and page wheel events without rounding trackpad deltas. */
export function wheelSpeedSteps(deltaY: number, deltaMode: number): number {
  if (!Number.isFinite(deltaY)) return 0;
  if (deltaMode === 0) return -deltaY / 100;
  if (deltaMode === 1) return -deltaY / 3;
  if (deltaMode === 2) return -deltaY;
  return 0;
}

/** Alters a setting, never a pose or an actual velocity. Release-to-stop stays intact. */
export function adjustMoveSpeed(speed: number, steps: number): number {
  const current = Math.min(MAX_MOVE_SPEED, Math.max(MIN_MOVE_SPEED, Number.isFinite(speed) ? speed : DEFAULT_MOVE_SPEED));
  if (!Number.isFinite(steps) || steps === 0) return current;
  return Math.min(MAX_MOVE_SPEED, Math.max(MIN_MOVE_SPEED, current * WHEEL_SPEED_FACTOR ** steps));
}
