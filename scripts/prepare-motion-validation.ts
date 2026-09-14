/** Bundled with the installed esbuild; uses production project/command builders. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Quaternion, Vector3 } from 'three';
import { frontPose, makePreset, makeDefaultClip, validatePrototypeProject } from '../src/model';
import { exportProjectSnapshot } from '../src/workflow/snapshot';
import { buildGenerationRequest, selectModel, updateField, updateExecution } from '../src/generation/domain';
import type { Project } from '../src/types';

const root = process.cwd(), folder = resolve(process.argv[2]);
const read = (name: string) => JSON.parse(readFileSync(resolve(folder, name), 'utf8'));
const save = (name: string, value: unknown) => writeFileSync(resolve(folder, name), JSON.stringify(value, null, 2)+'\n');
const project: Project = process.argv.includes('--generation') ? read('project.json') : JSON.parse(readFileSync(resolve(root, 'var/validation/20260910-workflow-resume/http-workflow-ready/frontend-project.json'), 'utf8'));
if (!process.argv.includes('--generation')) {
const result = read('associate/result.json'), job = read('associate/job.json');
const object = project.objects[0];
object.id = 'motion-validation-truck'; object.name = '定向框与 OMM 验证卡车'; object.prompt = 'A white truck moves smoothly across the scene.';
object.center = result.center; object.halfExtents = result.halfExtents; object.boxQuaternion = result.boxQuaternion;
object.front = '+x'; object.initialPose = frontPose(object, '+x');
object.reconstruction = { jobId: job.id, sceneJobId: project.workflow!.sceneJobId! };
object.maskPreview = '/api/'+job.outputs.find((entry: { name: string }) => entry.name === 'overlay.png').url;
object.trajectory = makePreset('object', 'slide', object, 1);
const initialQ = new Quaternion(...object.initialPose.quaternion);
for (const sample of object.trajectory.samples) {
  sample.position = [object.center[0]+.5*sample.t, object.center[1], object.center[2]];
  sample.quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), sample.t*.12).multiply(initialQ).toArray();
}
object.clip = makeDefaultClip(object.trajectory); object.motion = 'trajectory'; object.history = [];
project.objects = [object]; project.duration = 1; project.fps = 4; project.fourD = 'ready';
project.camera = makePreset('camera', 'slide', undefined, 1, project.cameraIntrinsics!);
for (const sample of project.camera.samples) sample.position = [.12*sample.t, 0, 0];
project.cameraClip = makeDefaultClip(project.camera); project.cameraHistory = [];
project.workflow!.pending = []; project.workflow!.objectDefinitions = []; delete project.workflow!.exportJobId;
project.motionControls = undefined;
project.name = 'Rendered Frames 与 OMM 验证'; project.description = 'A white truck moves slowly to the right while the camera shifts slightly.';
validatePrototypeProject(project);
save('project.json', project); save('snapshot.json', exportProjectSnapshot(project));
}
if (process.argv.includes('--generation')) {
  const exported = read('export/result.json'), exportJob = read('export/job.json');
  project.workflow!.exportJobId = exportJob.id;
  let state = selectModel(project.generation, 'symphomotion-multi-gpu');
  const id = state.activeProfileIds[state.selectedModelId];
  for (const [key, value] of Object.entries({ validation_csv_path: exported.validationCsv, num_frames: '5', fps: '4',
    num_inference_steps: '2', max_area: String(384*256), max_samples: '1', use_object_prompt: 'true', normalize_object_to_first_frame: 'true',
    max_entities: '2' })) state = updateField(state, id, key, value as string);
  state = updateExecution(state, id, { envName: 'symphomotion', scriptName: 'job.gpu', scriptContent: read('execution.json').scriptContent });
  project.generation = state;
  save('project.json', project);
  save('generation-request.json', buildGenerationRequest(state, id, project));
}
