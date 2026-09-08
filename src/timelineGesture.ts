export type ClipDragMode = 'move' | 'start' | 'end';
export interface ClipTiming { start: number; duration: number }
export interface ClipGesture {
  pointerId: number;
  target: string;
  mode: ClipDragMode;
  x: number;
  width: number;
  initial: ClipTiming;
  last: ClipTiming;
}
export interface ClipPointerMotion {
  pointerId: number;
  matchesOwner: boolean;
  buttons: number;
  captured: boolean;
  x: number;
}
export type ClipGestureResult = { action: 'ignore' | 'release' } | { action: 'change'; target: string; timing: ClipTiming };

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/** Pointer ownership and time geometry are independent of DOM and source samples. */
export function advanceClipGesture(gesture: ClipGesture | null, pointer: ClipPointerMotion, projectDuration: number, fps: number): ClipGestureResult {
  if (!gesture || pointer.pointerId !== gesture.pointerId || !pointer.matchesOwner) return { action: 'ignore' };
  // Capture owns a gesture until up/cancel/lostcapture even when button-state reporting is incomplete.
  if ((pointer.buttons & 1) === 0 && !pointer.captured) return { action: 'release' };
  if (!Number.isFinite(pointer.x) || !Number.isFinite(projectDuration) || projectDuration <= 0 || !Number.isFinite(fps) || fps <= 0 || !Number.isFinite(gesture.width) || gesture.width <= 0) return { action: 'ignore' };
  const step = 1 / fps;
  const snap = (value: number) => Math.round(value * fps) / fps;
  const delta = (pointer.x - gesture.x) / gesture.width * projectDuration;
  const end = gesture.initial.start + gesture.initial.duration;
  let timing: ClipTiming;
  if (gesture.mode === 'move') timing = { start: clamp(snap(gesture.initial.start + delta), 0, projectDuration - gesture.initial.duration), duration: gesture.initial.duration };
  else if (gesture.mode === 'start') {
    const start = clamp(snap(gesture.initial.start + delta), 0, end - step);
    timing = { start, duration: end - start };
  } else timing = { start: gesture.initial.start, duration: clamp(snap(end + delta), gesture.initial.start + step, projectDuration) - gesture.initial.start };
  if (Math.abs(timing.start - gesture.last.start) < 1e-7 && Math.abs(timing.duration - gesture.last.duration) < 1e-7) return { action: 'ignore' };
  return { action: 'change', target: gesture.target, timing };
}
