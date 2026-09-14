import type { Project } from '../types';
import { motionControls, setMotionControl } from './motionControls';

/** Remove the editable instance, retaining immutable jobs, requests and scene assets. */
export function removeSceneObject(project: Project, id: string): Project {
  if (!project.objects.some(object => object.id === id)
    && !project.workflow?.objectDefinitions?.some(definition => definition.id === id)) return project;
  const enabled = motionControls(project).object;
  const next: Project = {
    ...project,
    objects: project.objects.filter(object => object.id !== id),
    fourD: project.fourD === 'missing' ? 'missing' : 'stale',
    ...(project.workflow ? { workflow: {
      ...project.workflow,
      objectDefinitions: project.workflow.objectDefinitions?.filter(definition => definition.id !== id),
      exportJobId: undefined,
    } } : {}),
  };
  // Rebind the existing choice: removing one track must not enable the others.
  return setMotionControl(next, 'object', enabled && motionControls(next).object);
}

export function removeCameraTrajectory(project: Project): Project {
  if (!project.camera) return project;
  return setMotionControl({
    ...project, camera: null, cameraClip: null,
    cameraHistory: [project.camera, ...project.cameraHistory].slice(0, 500),
    ...(project.workflow ? { workflow: { ...project.workflow, exportJobId: undefined } } : {}),
  }, 'camera', false);
}
