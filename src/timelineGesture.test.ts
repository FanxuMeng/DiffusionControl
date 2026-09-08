import { describe, expect, it } from 'vitest';
import { advanceClipGesture, type ClipGesture, type ClipPointerMotion } from './timelineGesture';

const gesture = (patch: Partial<ClipGesture> = {}): ClipGesture => ({
  pointerId: 1, target: 'chair', mode: 'move', x: 100, width: 500,
  initial: { start: 0, duration: 2 }, last: { start: 0, duration: 2 }, ...patch,
});
const pointer = (patch: Partial<ClipPointerMotion> = {}): ClipPointerMotion => ({
  pointerId: 1, matchesOwner: true, buttons: 1, captured: true, x: 200, ...patch,
});

describe('independent timeline pointer gestures', () => {
  it('moves only the active object, preserving its duration', () => {
    const result = advanceClipGesture(gesture(), pointer(), 5, 24);
    expect(result).toEqual({ action: 'change', target: 'chair', timing: { start: 1, duration: 2 } });
  });

  it('does not mutate a chair from camera hover or another pointer', () => {
    const chair = gesture();
    const before = structuredClone(chair);
    expect(advanceClipGesture(chair, pointer({ matchesOwner: false, buttons: 0, captured: false, x: 450 }), 5, 24)).toEqual({ action: 'ignore' });
    expect(advanceClipGesture(chair, pointer({ pointerId: 2 }), 5, 24)).toEqual({ action: 'ignore' });
    expect(chair).toEqual(before);
  });

  it('ends an uncaptured gesture with no held button, so later hover cannot edit it', () => {
    let active: ClipGesture | null = gesture();
    const stopped = advanceClipGesture(active, pointer({ buttons: 0, captured: false }), 5, 24);
    expect(stopped).toEqual({ action: 'release' });
    if (stopped.action === 'release') active = null;
    expect(advanceClipGesture(active, pointer({ x: 480 }), 5, 24)).toEqual({ action: 'ignore' });
  });

  it('keeps a captured gesture valid until its pointer lifecycle ends', () => {
    expect(advanceClipGesture(gesture(), pointer({ buttons: 0, captured: true }), 5, 24)).toEqual({ action: 'change', target: 'chair', timing: { start: 1, duration: 2 } });
  });

  it('a new camera gesture affects only the camera after the chair gesture ends', () => {
    const clips = { chair: { start: 0, duration: 2 }, camera: { start: 0, duration: 2 } };
    const camera = gesture({ target: 'camera' });
    const result = advanceClipGesture(camera, pointer(), 5, 24);
    if (result.action === 'change') clips[result.target as keyof typeof clips] = result.timing;
    expect(clips.chair).toEqual({ start: 0, duration: 2 });
    expect(clips.camera).toEqual({ start: 1, duration: 2 });
  });

  it('left resizing preserves the end time and retimes the entire interval', () => {
    const result = advanceClipGesture(gesture({ mode: 'start', initial: { start: 1, duration: 3 }, last: { start: 1, duration: 3 } }), pointer(), 5, 24);
    expect(result).toEqual({ action: 'change', target: 'chair', timing: { start: 2, duration: 2 } });
  });

  it('right resizing preserves the start and cannot exceed project duration', () => {
    const result = advanceClipGesture(gesture({ mode: 'end', initial: { start: 1, duration: 2 }, last: { start: 1, duration: 2 } }), pointer({ x: 999 }), 5, 24);
    expect(result).toEqual({ action: 'change', target: 'chair', timing: { start: 1, duration: 4 } });
  });

  it('resizing cannot collapse an interval below one output frame', () => {
    const result = advanceClipGesture(gesture({ mode: 'end', initial: { start: 1, duration: 2 }, last: { start: 1, duration: 2 } }), pointer({ x: -999 }), 5, 24);
    expect(result.action).toBe('change');
    if (result.action === 'change') { expect(result.timing.start).toBe(1); expect(result.timing.duration).toBeCloseTo(1 / 24); }
  });

  it('clamps a whole interval to the project and skips unchanged frame-snapped values', () => {
    expect(advanceClipGesture(gesture(), pointer({ x: 999 }), 5, 24)).toEqual({ action: 'change', target: 'chair', timing: { start: 3, duration: 2 } });
    expect(advanceClipGesture(gesture(), pointer({ x: 101 }), 5, 24)).toEqual({ action: 'ignore' });
  });

  it('ignores unusable pointer geometry instead of emitting invalid timing', () => {
    expect(advanceClipGesture(gesture({ width: 0 }), pointer(), 5, 24)).toEqual({ action: 'ignore' });
    expect(advanceClipGesture(gesture(), pointer({ x: NaN }), 5, 24)).toEqual({ action: 'ignore' });
  });
});
