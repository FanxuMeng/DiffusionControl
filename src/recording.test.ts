import { describe, expect, it } from 'vitest';
import { createDemoProjects, frontPose, makeDefaultClip, makePreset, exportTrajectory, validatePrototypeProject } from './model';
import { commitRecordedTake, currentPreviewTrajectory, prepareRecordedTake } from './recording';
import type { Project, Sample } from './types';

function existingProject(): Project {
  const project = createDemoProjects()[0];
  const object = project.objects[0];
  object.front = '+x'; object.initialPose = frontPose(object, '+x');
  object.trajectory = { ...makePreset('object', 'slide', object), preview: 'data:image/png;base64,old' };
  object.clip = makeDefaultClip(object.trajectory); object.motion = 'trajectory';
  project.fourD = 'ready';
  return project;
}
function samples(project: Project): Sample[] {
  const pose = project.objects[0].initialPose;
  return [{ t: 0, ...structuredClone(pose) }, { t: 1, position: [pose.position[0] + .8, pose.position[1] + .2, pose.position[2]], quaternion: [...pose.quaternion] }];
}

describe('recorded object preview replacement', () => {
  it('replaces samples, clip and PNG together while preserving the previous take and other objects', () => {
    const project = existingProject(), previous = project.objects[0].trajectory;
    const capture = samples(project);
    const take = prepareRecordedTake(project, 'chair', capture, null, (points, _color, options) => {
      expect(points.at(-1)?.t).toBe(1);
      expect(options.clip?.duration).toBe(1);
      expect(options.clip?.trajectoryId).not.toBe(previous!.id);
      return 'data:image/png;base64,new';
    });
    capture[1].position[0] = 999;
    const saved = commitRecordedTake(project, take);
    expect(saved.objects[0].trajectory?.preview).toBe('data:image/png;base64,new');
    expect(saved.objects[0].trajectory?.samples[1].position[0]).not.toBe(999);
    expect(saved.objects[0].history[0]).toBe(previous);
    expect(saved.objects[0].clip?.trajectoryId).toBe(take.trajectory.id);
    expect(saved.objects[1]).toBe(project.objects[1]);
    expect(saved.fourD).toBe('stale');
    expect(project.objects[0].trajectory).toBe(previous);
    expect(currentPreviewTrajectory(saved, 'chair')).toBe(take.trajectory);
    expect(exportTrajectory(take.trajectory, take.clip).samples).toHaveLength(2);
  });

  it('keeps the old take intact when preview generation fails', () => {
    const project = existingProject(), original = structuredClone(project);
    expect(() => prepareRecordedTake(project, 'chair', samples(project), null, () => '')).toThrow('预览图生成失败');
    expect(project).toEqual(original);
    expect(() => prepareRecordedTake(project, 'chair', samples(project), null, () => { throw new Error('canvas unavailable'); })).toThrow('canvas unavailable');
    expect(project).toEqual(original);
  });

  it('persists the new PNG through project serialization and resolves the latest take by target', () => {
    const project = existingProject();
    const first = prepareRecordedTake(project, 'chair', samples(project), null, () => 'data:image/png;base64,new');
    const saved = commitRecordedTake(project, first);
    const restored = validatePrototypeProject(JSON.parse(JSON.stringify(saved)));
    expect(restored.objects[0].trajectory?.id).toBe(first.trajectory.id);
    expect(restored.objects[0].trajectory?.preview).toBe('data:image/png;base64,new');
    const second = prepareRecordedTake(saved, 'chair', samples(saved), null, () => 'data:image/png;base64,newer');
    const latest = commitRecordedTake(saved, second);
    expect(currentPreviewTrajectory(latest, 'chair')?.preview).toBe('data:image/png;base64,newer');
    expect(latest.objects[0].history.map(item => item.id)).toContain(first.trajectory.id);
    expect(() => commitRecordedTake({ ...project, id: 'other-project' }, first)).toThrow('项目不匹配');
  });
});
