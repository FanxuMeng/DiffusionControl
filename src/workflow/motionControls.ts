import type { Project } from '../types';
import { inspectProjectProfile, isSymphoMotion, updateField } from '../generation/domain';
import type { GenerationState } from '../generation/types';

export const RENDER_STRATEGY = 'reference_scene_with_projected_boxes_v2';
export function motionAvailability(project: Project) {
  return {
    object: project.objects.filter(o => o.motion === 'trajectory' && o.trajectory && o.clip).map(o => `${o.id}:${o.trajectory!.id}`).sort().join('|'),
    camera: project.camera && project.cameraClip ? project.camera.id : '',
  };
}
export function motionControls(project: Project) {
  const available = motionAvailability(project);
  const enabled = (kind: 'object' | 'camera') => !!available[kind] &&
    (project.motionControls?.[kind]?.binding === available[kind] ? project.motionControls[kind]!.enabled : true);
  return { object: enabled('object'), camera: enabled('camera') };
}
export function setMotionControl(project: Project, kind: 'object' | 'camera', enabled: boolean): Project {
  const binding = motionAvailability(project)[kind];
  if (enabled && !binding) throw new Error('请先应用对应轨迹。');
  return { ...project, motionControls: { ...project.motionControls, [kind]: { enabled, binding } } };
}
export function validateMotionControls(raw: unknown): Project['motionControls'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('运动控制开关无效。');
  const result: NonNullable<Project['motionControls']> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key !== 'object' && key !== 'camera') throw new Error('未知运动控制开关。');
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean'
      || typeof value.binding !== 'string' || value.binding.length > 50000 || Object.keys(value).some(k => !['enabled', 'binding'].includes(k))) throw new Error('运动控制开关无效。');
    result[key] = { enabled: value.enabled, binding: value.binding };
  }
  return result;
}
export function syncObjectControl(state: GenerationState, enabled: boolean): GenerationState {
  const profileId = state.activeProfileIds[state.selectedModelId];
  const inspection = inspectProjectProfile(state, profileId);
  if (!isSymphoMotion(state.selectedModelId) || !inspection.commandParseable || !inspection.draft || inspection.draft.values.use_object_prompt === String(enabled)) return state;
  return updateField(state, profileId, 'use_object_prompt', String(enabled));
}

export const OBJECT_PARAMETERS = new Set(['obj_injector_path', 'obj_cross_attn_interval', 'obj_scale', 'obj_traj_mid_dim', 'max_entities', 'max_text_tokens', 'normalize_object_to_first_frame']);
