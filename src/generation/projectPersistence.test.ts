import { describe, expect, it } from 'vitest';
import { createDemoProjects, createEmptyProject, makeDefaultClip, makePreset, migratePrototypeWorkspace, validatePrototypeProject } from '../model';
import type { Project } from '../types';
import { buildGenerationRequest, createProjectProfile, importModelProfile, inspectProjectProfile, selectProjectProfile, updateCommand, updateField } from './domain';
import type { GenerationState, ModelProfile } from './types';

const active = (state: GenerationState) => state.activeProfileIds[state.selectedModelId];
const inspected = (project: Project) => inspectProjectProfile(project.generation, active(project.generation));
const custom: ModelProfile = {
  id: 'ce-custom', version: 3, name: 'Custom CE model', model: 'custom',
  commandPrefix: ['python3', 'generate_custom.py'], description: 'Project backup integration fixture', inputRequirements: ['CE condition package'],
  parameters: [
    { key: 'input', flag: '--input', type: 'path', label: 'Input', defaultValue: '/CE/scene A', required: true },
    { key: 'seed', flag: '--seed', type: 'integer', label: 'Seed', defaultValue: '7' },
  ],
};

function populatedProject(): Project {
  const project = createDemoProjects()[0], object = project.objects[0];
  object.front = '+x'; object.motion = 'trajectory';
  object.trajectory = makePreset('object', 'arc', object, 3);
  object.clip = { ...makeDefaultClip(object.trajectory), start: 0.5, duration: 2.5, revision: 2 };
  object.history = [makePreset('object', 'rise', object, 2)];
  project.camera = makePreset('camera', 'slide', undefined, 5, project.cameraIntrinsics!);
  project.cameraClip = makeDefaultClip(project.camera);
  project.cameraHistory = [makePreset('camera', 'arc', undefined, 5, project.cameraIntrinsics!)];
  return project;
}

describe('generation integration with project persistence', () => {
  it('initializes independent configurations for each demo and empty project', () => {
    const projects = [...createDemoProjects(), createEmptyProject('New A', '/projects'), createEmptyProject('New B', '/projects')];
    expect(new Set(projects.map(project => active(project.generation))).size).toBe(projects.length);
    expect(new Set(projects.map(project => project.generation)).size).toBe(projects.length);
    const original = structuredClone(projects);
    projects[0].generation = updateField(projects[0].generation, active(projects[0].generation), 'seed', '100');
    expect(inspected(projects[0]).parameters?.seed).toBe(100);
    for (let index = 1; index < projects.length; index++) {
      expect(inspected(projects[index]).parameters?.seed).toBe(42);
      expect(projects[index]).toEqual(original[index]);
    }
    expect(original[0].generation.projectProfiles[0].values.seed).toBe('42');
  });

  it('opens a pre-generation project without losing source trajectories, clips, history or lens', () => {
    const original = populatedProject();
    const legacy = JSON.parse(JSON.stringify(original)) as Record<string, unknown>;
    delete legacy.generation;
    const before = structuredClone(legacy), restored = validatePrototypeProject(legacy);
    expect(inspected(restored).canExecute).toBe(true);
    expect(restored.id).toBe(original.id);
    expect(restored.objects[0].trajectory).toEqual(original.objects[0].trajectory);
    expect(restored.objects[0].clip).toEqual(original.objects[0].clip);
    expect(restored.objects[0].history).toEqual(original.objects[0].history);
    expect(restored.camera).toEqual(original.camera);
    expect(restored.cameraClip).toEqual(original.cameraClip);
    expect(restored.cameraHistory).toEqual(original.cameraHistory);
    expect(restored.cameraIntrinsics).toEqual(original.cameraIntrinsics);
    expect(legacy).toEqual(before);
  });

  it('round trips a self-contained workspace with custom model, broken drafts, named runs and submitted job', () => {
    const first = populatedProject(), other = createEmptyProject('Other project', '/projects');
    first.generation = importModelProfile(first.generation, custom);
    const draftId = active(first.generation);
    const submitted = buildGenerationRequest(first.generation, draftId, first, 'integration-request');
    first.generation = {
      ...first.generation,
      submissions: [{ endpoint: 'https://ce.example/api', request: submitted, job: { id: 'jobs/opaque:1', requestId: submitted.requestId, status: 'running', progress: 0.25, message: 'Processing', outputs: [{ name: 'log', url: 'https://ce.example/logs/job1' }] } }],
    };
    first.generation = updateField(first.generation, draftId, 'seed', '-');
    first.generation = updateCommand(first.generation, draftId, "python3 generate_custom.py --input 'unfinished");
    first.generation = createProjectProfile(first.generation, 'Alternate', draftId);
    const secondDraft = active(first.generation);
    first.generation = updateField(first.generation, secondDraft, 'seed', '120');
    first.generation = selectProjectProfile(first.generation, draftId);
    const payload = { format: 'diffusioncontrol.prototype.workspace', version: 2, projects: [first, other] };
    const exported = JSON.stringify(payload), result = migratePrototypeWorkspace(JSON.parse(exported), 2);
    expect(result.issues).toEqual([]);
    expect(result.projects).toHaveLength(2);
    const [restored, restoredOther] = result.projects;
    expect(restored.generation).toEqual(first.generation);
    expect(inspected(restored)).toMatchObject({ canExecute: false, commandParseable: false });
    expect(inspected(restored).draft).toMatchObject({ commandText: "python3 generate_custom.py --input 'unfinished", values: { seed: '-' } });
    expect(restored.generation.customProfiles).toEqual([custom]);
    expect(restored.generation.submissions[0].request).toEqual(submitted);
    expect(restored.generation.submissions[0].job?.progress).toBe(0.25);
    expect(restored.objects[0].trajectory).toEqual(first.objects[0].trajectory);
    expect(restored.camera).toEqual(first.camera);
    expect(restoredOther.generation).toEqual(other.generation);
    expect(inspected(restoredOther).parameters?.seed).toBe(42);
    const edited = updateField(restored.generation, secondDraft, 'seed', '300');
    expect(inspectProjectProfile(edited, secondDraft).parameters?.seed).toBe(300);
    expect(first.generation.projectProfiles.find(profile => profile.id === secondDraft)?.values.seed).toBe('120');
    expect(submitted.parameters.seed).toBe(7);
    expect(JSON.stringify(payload)).toBe(exported);
  });

  it('keeps original request ownership when a backup receives a new local project ID', () => {
    const project = createEmptyProject('Imported source', '/projects');
    const request = buildGenerationRequest(project.generation, active(project.generation), project, 'request-before-import');
    project.generation.submissions = [{ endpoint: 'https://ce.example/api', request }];
    const renamed = validatePrototypeProject({ ...JSON.parse(JSON.stringify(project)), id: 'new-local-id', name: 'Imported copy' });
    expect(renamed.id).toBe('new-local-id');
    expect(renamed.generation.submissions[0].request.projectId).toBe(project.id);
    expect(renamed.generation.submissions[0].request.projectName).toBe('Imported source');
    expect(buildGenerationRequest(renamed.generation, active(renamed.generation), renamed, 'new-request').projectId).toBe('new-local-id');
    expect(renamed.generation.submissions).toHaveLength(1);
  });
});
