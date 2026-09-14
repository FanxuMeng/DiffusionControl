import { useCallback, useEffect, useState } from 'react';
import * as THREE from 'three';
import type { Project, SceneObject } from '../types';
import { BASIS, type SceneGeometry } from '../sceneGeometry';
import { getJob, outputUrl } from './api';
import type { PointPreview, RealSceneData } from './types';

export function decodePreview(buffer: ArrayBuffer): PointPreview {
  if (buffer.byteLength < 12 || new TextDecoder().decode(buffer.slice(0, 4)) !== 'DCP1') throw new Error('点云预览格式无效。');
  const view = new DataView(buffer), count = view.getUint32(4, true), stride = view.getUint32(8, true);
  if (count > 300000 || stride !== 28 || buffer.byteLength !== 12 + count * stride) throw new Error('点云预览长度无效。');
  const positions = new Float32Array(count * 3), colors = new Float32Array(count * 3), pointIds = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const offset = 12 + i * stride;
    for (let axis = 0; axis < 3; axis++) {
      const position = view.getFloat32(offset + axis * 4, true), color = view.getFloat32(offset + 12 + axis * 4, true);
      if (!Number.isFinite(position) || !Number.isFinite(color) || color < 0 || color > 1) throw new Error('点云包含无效坐标或颜色。');
      positions[i * 3 + axis] = position; colors[i * 3 + axis] = color;
    }
    pointIds[i] = view.getUint32(offset + 24, true);
  }
  return { positions, colors, pointIds };
}
export function useRealScene(project: Project) {
  const [state, setState] = useState<{ identity: string; data: RealSceneData | null; error: string }>({ identity: '', data: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(value => value + 1), []);
  const key = project.objects.filter(o => o.reconstruction).map(o => `${o.id}:${o.reconstruction!.jobId}`).join('|');
  const sceneId = project.workflow?.sceneJobId;
  const identity = `${project.id}/${project.workflow?.referenceAssetId}/${sceneId}/${key}`;
  useEffect(() => {
    setState({ identity, data: null, error: '' });
    if (project.demoScene || !sceneId) return;
    const controller = new AbortController();
    const bytes = async (url: string) => { const response = await fetch(url, { signal: controller.signal, credentials: 'same-origin' }); if (!response.ok) throw new Error('无法读取点云产物，请检查登录与任务状态。'); return response.arrayBuffer(); };
    void (async () => {
      const scene = await getJob(sceneId, controller.signal);
      if (scene.kind !== 'depth' || scene.status !== 'succeeded' || scene.cancelRequested || scene.inputs.referenceAssetId !== project.workflow?.referenceAssetId) throw new Error('场景资产与当前首帧不匹配。');
      const result: RealSceneData = { scene: decodePreview(await bytes(outputUrl(scene, 'preview.bin'))), objects: {} };
      for (const object of project.objects) {
        if (!object.reconstruction || object.reconstruction.sceneJobId !== sceneId) throw new Error('物体点簇引用无效。');
        const job = await getJob(object.reconstruction.jobId, controller.signal);
        if (job.kind !== 'associate' || job.status !== 'succeeded' || job.cancelRequested || job.inputs.sceneJobId !== sceneId || job.inputs.referenceAssetId !== project.workflow?.referenceAssetId) throw new Error('物体点簇已失效。');
        const preview = decodePreview(await bytes(outputUrl(job, 'preview.bin'))), raw = await bytes(outputUrl(job, 'point-ids.bin'));
        if (raw.byteLength % 4 || raw.byteLength > 64000000) throw new Error('物体点索引长度无效。');
        result.objects[object.id] = { preview, pointIds: new Uint32Array(raw) };
      }
      if (!controller.signal.aborted) setState({ identity, data: result, error: '' });
    })().catch(error => { if (!controller.signal.aborted) setState({ identity, data: null, error: error instanceof Error ? error.message : '点云加载失败' }); });
    return () => controller.abort();
  // Only immutable asset identity triggers reloading; editing trajectories does not.
  }, [project.id, project.demoScene, project.workflow?.referenceAssetId, sceneId, key, identity, attempt]);
  return { data: state.identity === identity ? state.data : null, error: state.identity === identity ? state.error : '', retry };
}

export function createRealSceneGeometry(objects: SceneObject[], data: RealSceneData): SceneGeometry {
  const meshRoot = new THREE.Group(), cloudRoot = new THREE.Group(), meshes = new Map<string, THREE.Group>(), clouds = new Map<string, THREE.Group>();
  const occupied = new Set<number>();
  for (const object of objects) for (const id of data.objects[object.id]?.pointIds || []) occupied.add(id);
  let pointCount = 0;
  const resources: (THREE.BufferGeometry | THREE.Material)[] = [];
  const make = (preview: PointPreview, center: number[], keep: (id: number) => boolean, objectId?: string) => {
    const positions: number[] = [], colors: number[] = [], color = new THREE.Color();
    preview.pointIds.forEach((id, index) => {
      if (!keep(id)) return;
      positions.push(preview.positions[index * 3] - center[0], preview.positions[index * 3 + 1] - center[1], preview.positions[index * 3 + 2] - center[2]);
      color.setRGB(preview.colors[index * 3], preview.colors[index * 3 + 1], preview.colors[index * 3 + 2], THREE.SRGBColorSpace);
      colors.push(color.r, color.g, color.b);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size: .018, vertexColors: true, sizeAttenuation: true, toneMapped: false, fog: false });
    const points = new THREE.Points(geometry, material), group = new THREE.Group();
    if (objectId) { points.userData.objectId = objectId; group.userData.objectId = objectId; }
    group.add(points); group.position.fromArray(center); resources.push(geometry, material); pointCount += positions.length / 3;
    return group;
  };
  cloudRoot.add(make(data.scene, [0, 0, 0], id => !occupied.has(id)));
  for (const object of objects) {
    const asset = data.objects[object.id];
    if (!asset) continue;
    const cloud = make(asset.preview, object.center, () => true, object.id);
    clouds.set(object.id, cloud); cloudRoot.add(cloud);
  }
  cloudRoot.quaternion.copy(BASIS); meshRoot.quaternion.copy(BASIS);
  return { meshRoot, cloudRoot, meshes, clouds, pointCount, dispose: () => resources.forEach(resource => resource.dispose()) };
}
