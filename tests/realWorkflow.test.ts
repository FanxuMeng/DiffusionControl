import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDemoProjects, createCameraIntrinsics, deriveFov, frontPose, validateCameraCalibration, validatePrototypeProject } from '../src/model';
import { createRealSceneGeometry, decodePreview } from '../src/workflow/realScene';
import { outputUrl } from '../src/workflow/api';
import { exportProjectSnapshot } from '../src/workflow/snapshot';
import type { Mat3, Vec3 } from '../src/types';

// Opt-in real artifacts; the normal suite has no requirement for GPU outputs.
const folder = process.env.DIFFUSIONCONTROL_WORKFLOW_EVIDENCE;
describe.skipIf(!folder)('real HTTP workflow artifacts', () => {
  it('decodes full previews, separates object points, and restores the project binding', () => {
    const root = resolve(folder!);
    const output = resolve(process.env.DIFFUSIONCONTROL_WORKFLOW_OUTPUT || root);
    mkdirSync(output, { recursive: true });
    const json = (name: string) => JSON.parse(readFileSync(resolve(root, name), 'utf8'));
    const bytes = (name: string) => {
      const data = readFileSync(resolve(root, name));
      return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    };
    const asset = json('asset.json'), depth = json('depth/result.json'), obj = json('associate/result.json');
    const depthJob = json('depth/job.json'), objectJob = json('associate/job.json');
    const scene = decodePreview(bytes('depth/preview.bin')), object = decodePreview(bytes('associate/preview.bin'));
    const ids = new Uint32Array(bytes('associate/point-ids.bin')), occupied = new Set(ids);
    expect(scene.pointIds.length).toBe(180000);
    expect(object.pointIds.length).toBe(100000);
    expect(ids.length).toBe(obj.pointCount);
    expect(object.pointIds.every(id => occupied.has(id))).toBe(true);
    const calibration = validateCameraCalibration({ id: 'real-calibration', revision: 1, model: 'pinhole',
      imageWidth: depth.width, imageHeight: depth.height, pixelCenters: 'integer_coordinates', intrinsic: depth.intrinsic as Mat3,
      fov: deriveFov(depth.intrinsic, depth.width, depth.height), distortion: { model: 'none', coefficientOrder: ['k1', 'k2', 'p1', 'p2', 'k3'], coefficients: [0, 0, 0, 0, 0], state: 'assumed' }, source: `depthpro:${depthJob.id}` });
    const p = createDemoProjects()[0];
    Object.assign(p, { id: json('depth/request.json').projectId, name: '真实卡车验收', description: 'A silver pickup truck.', demoScene: null, demoSceneRevision: null,
      reference: asset.url, geometryReady: true, camera: null, cameraClip: null, cameraHistory: [], fourD: 'stale',
      referenceCamera: calibration, cameraIntrinsics: createCameraIntrinsics(calibration),
      workflow: { version: 1, referenceAssetId: asset.id, width: asset.width, height: asset.height, sceneJobId: depthJob.id, pending: [] } });
    p.objects = [{ id: 'truck', name: '卡车', color: '#86dcb7', prompt: 'A silver pickup truck.', shape: 'pointcloud',
      center: obj.center as Vec3, halfExtents: obj.halfExtents as Vec3, segmented: true, front: null,
      initialPose: { position: obj.center as Vec3, quaternion: [0, 0, 0, 1] }, motion: 'static', trajectory: null, clip: null, history: [],
      maskPreview: outputUrl(objectJob, 'overlay.png'), reconstruction: { jobId: objectJob.id, sceneJobId: depthJob.id } }];
    p.objects[0].initialPose = frontPose(p.objects[0], '+x');
    const restored = validatePrototypeProject(JSON.parse(JSON.stringify(p)));
    writeFileSync(resolve(output, 'frontend-project.json'), JSON.stringify(restored));
    expect(restored.workflow).toEqual(p.workflow);
    expect(restored.objects[0].reconstruction!.jobId).toBe(objectJob.id);
    expect(exportProjectSnapshot(restored).objects).toEqual([]); // Static-only scene has no object motion control.
    const geometry = createRealSceneGeometry(restored.objects, { scene, objects: { truck: { preview: object, pointIds: ids } } });
    const expectedBackground = scene.pointIds.filter(id => !occupied.has(id)).length;
    try {
      expect(geometry.pointCount).toBe(expectedBackground + object.pointIds.length);
      expect(geometry.clouds.get('truck')!.position.toArray()).toEqual(obj.center);
      expect(geometry.meshes.size).toBe(0);
    } finally { geometry.dispose(); }
    writeFileSync(resolve(output, 'frontend-artifacts.json'), JSON.stringify({ succeeded: true, scenePreviewPoints: scene.pointIds.length,
      objectPreviewPoints: object.pointIds.length, fullObjectPoints: ids.length, backgroundPreviewPoints: expectedBackground,
      restoredProjectBindings: true, scope: 'real_frontend_decoder_geometry_and_project_restore_not_browser_webgl' }, null, 2));
  });
});
