import { describe, expect, it } from 'vitest';
import { clipKinematics, editClip, exportClip, makeDefaultClip, sampleClip, sourceTimeAt, trajectoryVelocity, validateClip } from './timelineModel';
import type { Trajectory } from './types';

function trajectory(): Trajectory {
  return { id: 'source', revision: 1, kind: 'object', name: 'Test', duration: 5, samples: [
    { t: 0, position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
    { t: 2.5, position: [2.5, 0, 0], quaternion: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] },
    { t: 5, position: [7.5, 0, 0], quaternion: [0, Math.sin(Math.PI / 4), 0, Math.cos(Math.PI / 4)] },
  ], preview: '', source: 'recorded', createdAt: '2026-09-06T00:00:00Z' };
}

describe('parallel project clips', () => {
  it('maps simultaneous tracks independently, with source timestamps untouched', () => {
    const source = trajectory(), original = structuredClone(source.samples);
    const a = { ...makeDefaultClip(source), start: 1, duration: 2.5 };
    const b = { ...makeDefaultClip(source), start: 2, duration: 2 };
    expect(sourceTimeAt(a, source.duration, 2.25)).toBe(2.5);
    expect(sourceTimeAt(b, source.duration, 2.25)).toBe(.625);
    expect(sampleClip(source, a, 0).position).toEqual(source.samples[0].position);
    expect(sampleClip(source, a, 4).position).toEqual(source.samples[2].position);
    expect(sampleClip(source, a, 2.25).position).toEqual([2.5, 0, 0]);
    expect(source.samples).toEqual(original);
  });

  it('moves without retiming and stretches complete motion while holding the opposite boundary', () => {
    const source = trajectory(), original = structuredClone(source);
    const clip = { ...makeDefaultClip(source), start: 1, duration: 2.5 };
    const moved = editClip(clip, 'move', 2, 8, 16);
    expect(moved.start).toBe(2); expect(moved.duration).toBe(2.5);
    const left = editClip(clip, 'resize-start', 2, 8, 16);
    expect(left.start + left.duration).toBe(3.5); expect(left.duration).toBe(1.5);
    const right = editClip(clip, 'resize-end', 6, 8, 16);
    expect(right.start).toBe(1); expect(right.duration).toBe(5);
    expect(sampleClip(source, right, 6).position).toEqual(source.samples[2].position);
    expect(source).toEqual(original);
  });

  it('scales linear and angular velocity together and holds outside the clip', () => {
    const source = trajectory();
    const clip = { ...makeDefaultClip(source), start: 1, duration: 2.5 };
    const original = trajectoryVelocity(source, 1), fast = clipKinematics(source, clip, 1.5);
    expect(original.speed).toBe(1); expect(fast.speed).toBe(2);
    expect(fast.angularSpeed).toBeCloseTo(original.angularSpeed * 2, 12);
    expect(clipKinematics(source, clip, 3).speed).toBe(4);
    expect(clipKinematics(source, clip, 0).speed).toBe(0);
    expect(clipKinematics(source, clip, 4).angularSpeed).toBe(0);
  });

  it('validates exported bindings and rejects invalid timing and unsupported mappings', () => {
    const source = trajectory(), clip = makeDefaultClip(source);
    expect(validateClip(exportClip(clip), source, 5)).toEqual(clip);
    expect(() => validateClip({ ...clip, start: -1 }, source, 5)).toThrow('开始时间');
    expect(() => validateClip({ ...clip, duration: 0 }, source, 5)).toThrow('时长');
    expect(() => validateClip({ ...clip, start: 1 }, source, 5)).toThrow('超出');
    expect(() => validateClip({ ...clip, trajectoryId: 'other' }, source, 5)).toThrow('不匹配');
    expect(() => validateClip({ ...clip, timeMap: { mode: 'piecewise_linear' } }, source, 5)).toThrow('整段');
  });
});
