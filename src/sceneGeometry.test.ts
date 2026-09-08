import { describe, expect, it } from 'vitest';
import { Box3, Mesh, Points, Vector3 } from 'three';
import { createDemoProjects, frontPose, makeDefaultClip, makePreset, validatePrototypeProject } from './model';
import { createSceneGeometry } from './sceneGeometry';

describe('one rigid humanoid demonstration object', () => {
  it('builds a spherical head and five boxes with a single pick/mask ID and one bounded cloud', () => {
    const project = createDemoProjects()[0], object = project.objects.find(item => item.id === 'humanoid')!;
    const geometry = createSceneGeometry(project.objects);
    try {
      const group = geometry.meshes.get(object.id)!, content = group.children[0];
      const meshes: Mesh[] = [];
      group.traverse(node => { if (node instanceof Mesh) meshes.push(node); });
      expect(meshes).toHaveLength(6);
      expect(meshes.filter(mesh => mesh.geometry.type === 'BoxGeometry')).toHaveLength(5);
      expect(meshes.filter(mesh => mesh.geometry.type === 'SphereGeometry')).toHaveLength(1);
      expect(meshes.every(mesh => mesh.userData.objectId === object.id)).toBe(true);
      expect(content.scale.x).toBeCloseTo(content.scale.y, 6);
      expect(content.scale.x).toBeCloseTo(content.scale.z, 6);
      const bounds = new Box3().setFromObject(group);
      expect(bounds.getSize(new Vector3()).distanceTo(new Vector3(...object.halfExtents).multiplyScalar(2))).toBeLessThan(1e-6);
      expect(bounds.getCenter(new Vector3()).distanceTo(new Vector3(...object.center))).toBeLessThan(1e-6);
      expect(object.center[1] + object.halfExtents[1]).toBeCloseTo(1.5);
      const cloud = geometry.clouds.get(object.id)!;
      expect(cloud.userData.objectId).toBe(object.id);
      expect(cloud.children).toHaveLength(1);
      const points = cloud.children[0] as Points;
      const positions = points.geometry.getAttribute('position');
      expect(positions.count).toBeGreaterThan(1000);
      points.geometry.computeBoundingBox();
      const cloudBounds = points.geometry.boundingBox!;
      for (const [axis, dimension] of ['x', 'y', 'z'].entries()) {
        const key = dimension as 'x' | 'y' | 'z';
        expect(cloudBounds.min[key]).toBeGreaterThanOrEqual(-object.halfExtents[axis] - 1e-6);
        expect(cloudBounds.max[key]).toBeLessThanOrEqual(object.halfExtents[axis] + 1e-6);
      }
    } finally { geometry.dispose(); }
  });

  it('keeps existing objects point samples identical when the humanoid is appended', () => {
    const project = createDemoProjects()[0];
    const previous = createSceneGeometry(project.objects.filter(object => object.shape !== 'humanoid'));
    const current = createSceneGeometry(project.objects);
    try {
      for (const object of project.objects.filter(item => item.shape !== 'humanoid')) {
        const oldPoints = previous.clouds.get(object.id)!.children[0] as Points;
        const newPoints = current.clouds.get(object.id)!.children[0] as Points;
        expect(newPoints.geometry.getAttribute('position').array).toEqual(oldPoints.geometry.getAttribute('position').array);
        expect(newPoints.geometry.getAttribute('color').array).toEqual(oldPoints.geometry.getAttribute('color').array);
      }
    } finally { previous.dispose(); current.dispose(); }
  });

  it('requires a selected front and round-trips one whole-body motion track', () => {
    const project = createDemoProjects()[1], object = project.objects.find(item => item.id === 'humanoid')!;
    object.motion = 'trajectory'; object.trajectory = makePreset('object', 'arc', object);
    object.clip = makeDefaultClip(object.trajectory);
    expect(() => validatePrototypeProject(project)).toThrow('已选正面');
    object.front = '-z'; object.initialPose = frontPose(object, '-z');
    object.trajectory = makePreset('object', 'slide', object); object.clip = makeDefaultClip(object.trajectory);
    const restored = validatePrototypeProject(project).objects.find(item => item.id === object.id)!;
    expect(restored.trajectory!.samples[0].position).toEqual(object.center);
    expect(restored.trajectory!.samples.at(-1)!.position[2]).toBeCloseTo(object.center[2] - 1.5);
    expect(restored.clip).toEqual(object.clip);
    expect(restored.shape).toBe('humanoid');
  });
});
