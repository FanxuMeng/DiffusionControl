import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as THREE from 'three';
import { BASIS, createSceneGeometry, FACE_COLORS, makeBoundingBox } from './sceneGeometry';
import { advanceFlight, cameraLocalDirection, createFlightState, stopFlight } from './flight';
import { createDefaultCalibration, speedColor } from './cameraMath';
import { sampleClip, clipKinematics } from './timelineModel';
import { applyCalibratedProjection, createCaptureProjection, pixelRayInRenderWorld, projectCalibratedPoint } from './captureProjection';
import { buildTrajectoryDrawing, limitCameraArrowHeads, makeCameraGlyph } from './trajectoryGeometry';
import { controllerCameraPose, createObserver, createRecordingRig, lookOrientation, orientationQuaternion, poseForTarget, recordingRigPose, rollOrientation, usesRecordingRig } from './orientation';
import { wheelSpeedAllowed, wheelSpeedSteps } from './navigationSpeed';
import { referenceAxesForBox } from './objectAxes';
import type { PoseController, RecordingRig } from './orientation';
import type { PathAnnotation } from './trajectoryGeometry';
import type { FlightState } from './flight';
import type { CameraCalibration, Face, Pose, SceneHandle, SceneViewportProps, Vec3 } from './types';

const FIXED_ASPECT = 16 / 10;
const DEFAULT_CAPTURE = createDefaultCalibration();
const zeroPose = (): Pose => ({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] });
function setCameraPose(camera: THREE.PerspectiveCamera, pose: Pose) {
  camera.position.fromArray(pose.position).applyQuaternion(BASIS); camera.quaternion.copy(BASIS).multiply(new THREE.Quaternion(...pose.quaternion)).multiply(BASIS.clone().invert()); camera.updateMatrixWorld();
}
function captureLens(props: SceneViewportProps): CameraCalibration | null {
  if (props.view === '2d') return props.project.referenceCamera || DEFAULT_CAPTURE;
  if (props.target === 'camera' && usesRecordingRig(props.recordState)) return props.project.referenceCamera || DEFAULT_CAPTURE;
  if (props.followCamera && props.recordState === 'preview') return props.project.cameraIntrinsics?.calibration || props.project.camera?.cameraIntrinsics?.calibration || props.project.referenceCamera || DEFAULT_CAPTURE;
  return null;
}
function frameSize(width: number, height: number, calibration: CameraCalibration | null) {
  const aspect = calibration ? calibration.imageWidth / calibration.imageHeight : width / height;
  const w = Math.min(width, height * aspect), h = w / aspect; return { width: w, height: h, left: (width - w) / 2, top: (height - h) / 2 };
}
function disposeGroup(group: THREE.Group) {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  group.traverse(n => { if (n instanceof THREE.Mesh || n instanceof THREE.Line || n instanceof THREE.Points) { geometries.add(n.geometry); (Array.isArray(n.material) ? n.material : [n.material]).forEach(m => materials.add(m)); } });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); group.clear();
}
interface Controller { observer: PoseController; rig: RecordingRig | null; flight: FlightState; keys: Set<string>; controlled: boolean }
interface Runtime { renderer: THREE.WebGLRenderer; readyState: 'initializing' | 'ready' | 'disposed'; requestControl: () => Promise<boolean>; reset: () => void; prepare: (target: string) => void; controller: Controller; release: () => void }
interface ObjectLabel { id: string; name: string; color: string; x: number; y: number; annotation?: boolean; referenceAxis?: boolean; anchorX?: number; anchorY?: number }
interface CaptureReadout { speed: number; angularSpeed: number; fovH: number; fovV: number; coefficients: string; time: number; lens: string; intrinsic: string; imageSize: string }

export const SceneViewport = forwardRef<SceneHandle, SceneViewportProps>(function SceneViewport(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null), propsRef = useRef(props), runtimeRef = useRef<Runtime | null>(null);
  propsRef.current = props;
  const [maximumPathSpeed, setMaximumPathSpeed] = useState(0), [captureReadout, setCaptureReadout] = useState<CaptureReadout | null>(null);
  const [labels, setLabels] = useState<ObjectLabel[]>([]), [ready, setReady] = useState(false), [failure, setFailure] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({
    requestControl: () => runtimeRef.current?.requestControl() ?? Promise.resolve(false),
    releaseControl: () => runtimeRef.current?.release(),
    resetView: () => runtimeRef.current?.reset(),
    prepareTarget: target => runtimeRef.current?.prepare(target),
    getPose: target => {
      const control = runtimeRef.current?.controller; if (!control) return zeroPose();
      const p = propsRef.current;
      return poseForTarget(control.observer, control.rig, target, p.recordState, p.project.objects.find(o => o.id === target)?.initialPose || zeroPose());
    },
  }), []);

  useEffect(() => {
    const host = hostRef.current; if (!host || !props.project.demoScene) { setReady(false); setLabels([]); setCaptureReadout(null); setFailure(null); return; }
    let renderer: THREE.WebGLRenderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false }); }
    catch { const message = '此设备未能创建 WebGL 场景。请在桌面浏览器中启用硬件加速。'; setFailure(message); propsRef.current.onError(message); return; }
    setFailure(null); setReady(false); renderer.setPixelRatio(1); renderer.setSize(1120, 700, false); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2; renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;outline:none;touch-action:none;'; renderer.domElement.tabIndex = 0; renderer.domElement.setAttribute('aria-label', '交互点云视口，点击物体选择，进入控制后使用 WASD 移动'); host.prepend(renderer.domElement);
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#e7e3db'); scene.fog = new THREE.Fog('#e7e3db', 9, 23);
    const referenceCalibration = propsRef.current.project.referenceCamera || DEFAULT_CAPTURE, referenceWidth = referenceCalibration.imageWidth, referenceHeight = referenceCalibration.imageHeight;
    renderer.setSize(referenceWidth, referenceHeight, false);
    const camera = new THREE.PerspectiveCamera(55, FIXED_ASPECT, .045, 90); setCameraPose(camera, zeroPose()); applyCalibratedProjection(camera, referenceCalibration);
    scene.add(new THREE.HemisphereLight('#fffae9', '#777a6e', 2.55));
    const sun = new THREE.DirectionalLight('#fff0cf', 3.1); sun.position.set(-5, 7, -1); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.camera.left = -9; sun.shadow.camera.right = 9; sun.shadow.camera.top = 9; sun.shadow.camera.bottom = -9; sun.shadow.bias = -.001; sun.shadow.normalBias = .02; sun.target.position.set(0, -.8, -5); scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight('#f0f5ed', .75); fill.position.set(3, 1, 1); scene.add(fill);
    const data = createSceneGeometry(propsRef.current.project.objects, propsRef.current.project.demoScene === 'gallery'); scene.add(data.meshRoot, data.cloudRoot); data.cloudRoot.visible = false;
    const overlay = new THREE.Group(); overlay.quaternion.copy(BASIS); scene.add(overlay);
    const boxRoot = new THREE.Group(), pathRoot = new THREE.Group(), currentCameraRoot = new THREE.Group(); overlay.add(boxRoot, pathRoot, currentCameraRoot); const boxes = new Map<string, THREE.Group>();
    propsRef.current.project.objects.forEach(o => { const box = makeBoundingBox(o); boxes.set(o.id, box); boxRoot.add(box); });
    const grid = new THREE.GridHelper(12, 24, '#87aaa1', '#66847f'); grid.position.set(0, 1.51, 4); (grid.material as THREE.Material).transparent = true; (grid.material as THREE.Material).opacity = .36; overlay.add(grid);
    const velocityArrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), .8, '#7adaac', .11, .075); velocityArrow.visible = false; velocityArrow.userData.captureArrow = true; overlay.add(velocityArrow);
    const worldAxes = new THREE.AxesHelper(.55); worldAxes.position.set(-2.45, 1.47, 3.9); overlay.add(worldAxes);
    const projection = createCaptureProjection(); projection.install(data.cloudRoot); projection.install(overlay);
    const controller: Controller = { observer: createObserver(), rig: null, flight: createFlightState(), keys: new Set(), controlled: false };
    const clearMotion = () => { controller.flight = createFlightState(); controller.keys.clear(); };
    const reset = () => { controller.observer = createObserver(); clearMotion(); };
    const prepare = (target: string) => {
      clearMotion();
      const object = propsRef.current.project.objects.find(o => o.id === target);
      controller.rig = target === 'camera' ? createRecordingRig(target, zeroPose()) : object ? createRecordingRig(target, { position: [...object.center], quaternion: [...object.initialPose.quaternion] }) : null;
    };
    const activeRig = (p: SceneViewportProps) => p.view === '3d' && usesRecordingRig(p.recordState) && controller.rig?.target === p.target ? controller.rig : null;
    let pendingControl: Promise<boolean> | null = null;
    let cancelPendingControl: (() => void) | null = null;
    const requestControl = (): Promise<boolean> => {
      if (runtime.readyState !== 'ready' || propsRef.current.view === '2d') return Promise.resolve(false);
      if (document.pointerLockElement === renderer.domElement) return Promise.resolve(true);
      if (pendingControl) return pendingControl;
      if (!renderer.domElement.requestPointerLock) { propsRef.current.onError('此浏览器暂不支持鼠标锁定，请使用桌面版 Chrome。'); return Promise.resolve(false); }
      let resolveRequest!: (success: boolean) => void;
      pendingControl = new Promise<boolean>(resolve => { resolveRequest = resolve; });
      const result = pendingControl;
      let settled = false;
      const finish = (success: boolean, message?: string) => {
        if (settled) return; settled = true; clearTimeout(timeout);
        document.removeEventListener('pointerlockchange', changed); document.removeEventListener('pointerlockerror', failed);
        pendingControl = null; cancelPendingControl = null; if (message && runtime.readyState !== 'disposed') propsRef.current.onError(message); resolveRequest(success);
      };
      const changed = () => { if (document.pointerLockElement === renderer.domElement) finish(true); };
      const failed = () => finish(false, '浏览器未允许锁定鼠标，请点击画面重试。');
      const timeout = window.setTimeout(() => finish(false, '鼠标锁定请求超时，请直接点击「开始录制」重试。'), 4000);
      cancelPendingControl = () => finish(false);
      // Register first: legacy implementations return undefined and complete only by events.
      document.addEventListener('pointerlockchange', changed); document.addEventListener('pointerlockerror', failed);
      try {
        const requested = renderer.domElement.requestPointerLock();
        if (requested && typeof requested.then === 'function') requested.then(changed, failed);
      } catch (error) { finish(false, error instanceof Error ? error.message : '无法进入视角控制，请点击画面重试。'); }
      return result;
    };
    const release = () => { cancelPendingControl?.(); clearMotion(); if (document.pointerLockElement === renderer.domElement) document.exitPointerLock(); };
    const runtime: Runtime = { renderer, controller, reset, prepare, release, requestControl, readyState: 'initializing' };
    runtimeRef.current = runtime;
    // Capture the actual source geometry before adding segmentation and editing overlays.
    overlay.visible = false; renderer.render(scene, camera); const reference = renderer.domElement.toDataURL('image/png');
    propsRef.current.onReferenceReady(reference);
    // Render visible masks with the SAME reference projection and depth occlusion, then
    // crop the object's projected bbox into a compact thumbnail. No invented icon shape.
    const previewScene = new THREE.Scene(); previewScene.background = new THREE.Color('#17211f');
    const previewRoot = data.meshRoot.clone(true); previewScene.add(previewRoot); const previewMaterials: THREE.MeshBasicMaterial[] = [];
    previewRoot.traverse(node => { if (node instanceof THREE.Mesh) { const material = new THREE.MeshBasicMaterial({ color: '#17211f', side: THREE.DoubleSide, toneMapped: false }); node.material = material; node.castShadow = false; node.receiveShadow = false; previewMaterials.push(material); } });
    const previews: Record<string, string> = {};
    propsRef.current.project.objects.forEach(object => {
      previewRoot.traverse(node => { if (node instanceof THREE.Mesh) (node.material as THREE.MeshBasicMaterial).color.set(node.userData.objectId === object.id ? object.color : '#17211f'); });
      renderer.render(previewScene, camera);
      const source = data.meshes.get(object.id); if (!source) return;
      const bounds = new THREE.Box3().setFromObject(source); let minX = referenceWidth, maxX = 0, minY = referenceHeight, maxY = 0;
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) { const projected = new THREE.Vector3(x, y, z).project(camera); minX = Math.min(minX, (projected.x + 1) * referenceWidth / 2); maxX = Math.max(maxX, (projected.x + 1) * referenceWidth / 2); minY = Math.min(minY, (1 - projected.y) * referenceHeight / 2); maxY = Math.max(maxY, (1 - projected.y) * referenceHeight / 2); }
      const padding = 10; minX = Math.max(0, minX - padding); maxX = Math.min(referenceWidth, maxX + padding); minY = Math.max(0, minY - padding); maxY = Math.min(referenceHeight, maxY + padding);
      const sw = maxX - minX, sh = maxY - minY; if (sw <= 0 || sh <= 0) return;
      const thumbnail = document.createElement('canvas'); thumbnail.width = 192; thumbnail.height = 192; const context = thumbnail.getContext('2d'); if (!context) return;
      context.fillStyle = '#17211f'; context.fillRect(0, 0, 192, 192); const scale = Math.min(168 / sw, 168 / sh), dw = sw * scale, dh = sh * scale;
      context.drawImage(renderer.domElement, minX, minY, sw, sh, (192 - dw) / 2, (192 - dh) / 2, dw, dh); previews[object.id] = thumbnail.toDataURL('image/png');
    });
    previewMaterials.forEach(material => material.dispose()); previewScene.remove(previewRoot); previewRoot.clear(); propsRef.current.onObjectPreviewsReady?.(previews);
    // Independent translucent masks preserve all original material colors and restore
    // the untouched reference immediately when the user hides masks.
    const maskRoot = new THREE.Group(); maskRoot.quaternion.copy(BASIS); scene.add(maskRoot); const masks = new Map<string, THREE.Group>(), maskMaterials: THREE.MeshBasicMaterial[] = [];
    propsRef.current.project.objects.forEach(object => { const source = data.meshes.get(object.id); if (!source) return; const mask = source.clone(true); mask.traverse(node => { if (node instanceof THREE.Mesh) { const material = new THREE.MeshBasicMaterial({ color: object.color, transparent: true, opacity: .62, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false }); node.material = material; node.castShadow = false; node.receiveShadow = false; node.renderOrder = 2; maskMaterials.push(material); } }); maskRoot.add(mask); masks.set(object.id, mask); });
    overlay.visible = true; renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    runtime.readyState = 'ready'; setReady(true);
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(); let frame = 0, disposed = false, previous = performance.now(), lastTelemetry = 0, lastLabels = 0, lastPaths = '', lastView = propsRef.current.view, lastRecordState = propsRef.current.recordState;
    let width = referenceWidth, height = referenceHeight, pathAnnotations: PathAnnotation[] = [], currentGlyphKey = '';
    let previousCaptureRotation = new THREE.Quaternion(), previousCaptureTime = performance.now(), previousCaptureWasLive = false;
    const resize = () => { width = Math.max(1, host.clientWidth); height = Math.max(1, host.clientHeight); renderer.setSize(width, height, false); };
    resize(); const observer = new ResizeObserver(resize); observer.observe(host);
    const lockChanged = () => { const was = controller.controlled; controller.controlled = document.pointerLockElement === renderer.domElement; if (!controller.controlled) { clearMotion(); if (was) propsRef.current.onControlLost(); } };
    const mouseMove = (event: MouseEvent) => {
      const p = propsRef.current; if (!controller.controlled || p.view !== '3d' || !['preview', 'recording'].includes(p.recordState)) return;
      if (p.followCamera && p.recordState === 'preview') return;
      const controlledPose = activeRig(p) || (p.recordState === 'preview' ? controller.observer : null); if (!controlledPose) return;
      const sensitivity = p.settings.sensitivity * Math.PI / 180;
      controlledPose.orientation = lookOrientation(controlledPose.orientation, event.movementX * sensitivity, -event.movementY * sensitivity);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (!controller.controlled) return; if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'Space', 'KeyP'].includes(event.code)) event.preventDefault();
      if (event.code === 'Space') { clearMotion(); controller.flight = stopFlight(); return; }
      if (event.code === 'KeyP' && !event.repeat && propsRef.current.recordState === 'recording') { propsRef.current.onPause(); release(); return; }
      if (event.repeat && !controller.keys.has(event.code)) return;
      controller.keys.add(event.code);
    };
    const keyUp = (event: KeyboardEvent) => controller.keys.delete(event.code);
    const wheel = (event: WheelEvent) => {
      const p = propsRef.current;
      const editing = document.activeElement instanceof HTMLElement && !!document.activeElement.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]');
      if (!wheelSpeedAllowed({ controlled: controller.controlled, view: p.view, recordState: p.recordState, followCamera: p.followCamera, ctrlKey: event.ctrlKey, metaKey: event.metaKey, editing })) return;
      if (p.recordState === 'recording' && !activeRig(p)) return;
      const steps = wheelSpeedSteps(event.deltaY, event.deltaMode);
      if (steps === 0) return;
      event.preventDefault();
      p.onMoveSpeedChange(steps);
    };
    const contextMenu = (event: Event) => { if (controller.controlled) event.preventDefault(); };
    const click = (event: MouseEvent) => {
      const p = propsRef.current; if (controller.controlled || p.recordState !== 'preview') return;
      const bounds = renderer.domElement.getBoundingClientRect(), lens = captureLens(p), frameSizeNow = frameSize(width, height, lens);
      const px = event.clientX - bounds.left, py = event.clientY - bounds.top;
      if (px < frameSizeNow.left || px > frameSizeNow.left + frameSizeNow.width || py < frameSizeNow.top || py > frameSizeNow.top + frameSizeNow.height) return;
      const u = (px - frameSizeNow.left) / frameSizeNow.width, v = (py - frameSizeNow.top) / frameSizeNow.height;
      if (lens) { try { raycaster.ray.set(camera.position, pixelRayInRenderWorld([u * lens.imageWidth - .5, v * lens.imageHeight - .5], lens, camera)); } catch { return; } }
      else { pointer.set(u * 2 - 1, 1 - v * 2); raycaster.setFromCamera(pointer, camera); }
      if (p.view !== '2d' && p.showBoxes) {
        const selected = p.project.objects.find(o => o.id === p.selectedObjectId);
        if (selected?.segmented) { const bbox = boxes.get(selected.id); if (bbox) { const hit = raycaster.intersectObjects(bbox.children, false).find(h => h.object.userData.face); if (hit) { p.onFrontPick(selected.id, hit.object.userData.face as Face); return; } } }
      }
      const hits = raycaster.intersectObjects(Array.from(data.meshes.values()), true); if (hits[0]?.object.userData.objectId) p.onObjectPick(hits[0].object.userData.objectId);
    };
    const blur = () => { if (controller.controlled) { if (propsRef.current.recordState === 'recording') propsRef.current.onPause(); release(); } };
    const visibility = () => { if (document.hidden) blur(); };
    document.addEventListener('pointerlockchange', lockChanged); document.addEventListener('mousemove', mouseMove); window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); renderer.domElement.addEventListener('contextmenu', contextMenu); renderer.domElement.addEventListener('click', click); window.addEventListener('blur', blur); document.addEventListener('visibilitychange', visibility);
    document.addEventListener('wheel', wheel, { passive: false });

    const updatePaths = () => {
      const p = propsRef.current;
      const includeCamera = !(p.followCamera && p.recordState === 'preview') && activeRig(p)?.target !== 'camera';
      const key = JSON.stringify({ objects: p.project.objects.map(o => [o.id, o.motion, o.trajectory?.id, o.trajectory?.revision, o.clip]), camera: [p.project.camera?.id, p.project.camera?.revision, p.project.cameraClip, p.project.cameraIntrinsics, p.project.camera?.cameraIntrinsics], draft: p.draftSamples.length, visible: p.showTrajectories, includeCamera });
      if (key === lastPaths) return; lastPaths = key; disposeGroup(pathRoot); pathAnnotations = [];
      if (!p.showTrajectories) { setMaximumPathSpeed(0); return; }
      const drawing = buildTrajectoryDrawing(p.project, p.draftSamples, p.target, p.project.referenceCamera || DEFAULT_CAPTURE, includeCamera);
      pathRoot.add(drawing.root); pathAnnotations = drawing.annotations; setMaximumPathSpeed(drawing.maximumSpeed); projection.install(pathRoot);
    };
    const tick = (now: number) => {
      if (disposed) return; frame = requestAnimationFrame(tick); let dt = Math.max(0, (now - previous) / 1000); previous = now; const p = propsRef.current;
      // The recorder and scene read one monotonic capture clock. React's throttled
      // time state remains suitable for transport UI and non-recording playback.
      let sceneTime = p.time;
      if (p.recordState === 'recording' && p.getCaptureTime) { const captureTime = p.getCaptureTime(); if (Number.isFinite(captureTime)) sceneTime = THREE.MathUtils.clamp(captureTime, 0, p.project.duration); }
      if (p.recordState === 'recording' && lastRecordState !== 'recording') dt = 0;
      if (lastRecordState !== p.recordState) { if (p.recordState === 'preview') controller.rig = null; if (p.recordState !== 'recording') clearMotion(); lastRecordState = p.recordState; }
      if (lastView !== p.view) { clearMotion(); lastView = p.view; if (p.view === '2d') release(); }
      const is2d = p.view === '2d', lens = captureLens(p), frameSizeNow = frameSize(width, height, lens); data.meshRoot.visible = is2d; data.cloudRoot.visible = !is2d; overlay.visible = !is2d;
      scene.background = new THREE.Color(is2d ? '#e7e3db' : '#17282b'); scene.fog = new THREE.Fog(is2d ? '#e7e3db' : '#17282b', is2d ? 10 : 12, is2d ? 24 : 32); maskRoot.visible = is2d && p.showMasks;
      const rig = activeRig(p), activeObject = rig && rig.target !== 'camera' ? rig.target : null;
      const controlledPose = rig || (p.recordState === 'preview' ? controller.observer : null);
      const following = p.followCamera && p.recordState === 'preview';
      const movable = controller.controlled && !is2d && !!controlledPose && ['preview', 'recording'].includes(p.recordState) && !following;
      if (movable) {
        const roll = Number(controller.keys.has('KeyE')) - Number(controller.keys.has('KeyQ'));
        if (roll) controlledPose.orientation = rollOrientation(controlledPose.orientation, roll * p.settings.rollSpeed * Math.PI / 180 * dt);
        const direction = cameraLocalDirection(controller.keys, orientationQuaternion(controlledPose.orientation));
        const integrated = advanceFlight(controller.flight, { direction }, dt, p.settings);
        controller.flight = integrated.state;
        controlledPose.position = controlledPose.position.map((value, i) => value + integrated.displacement[i]) as Vec3;
      } else controller.flight = stopFlight();
      const activeObjectPose = rig && activeObject ? recordingRigPose(rig) : null;
      for (const object of p.project.objects) {
        const pose = !is2d && activeObject === object.id && activeObjectPose ? activeObjectPose : !is2d && object.motion === 'trajectory' && object.trajectory && object.clip ? sampleClip(object.trajectory, object.clip, sceneTime) : object.initialPose;
        const cloud = data.clouds.get(object.id), mesh = data.meshes.get(object.id), bbox = boxes.get(object.id);
        const displayRotation = new THREE.Quaternion(...pose.quaternion).multiply(new THREE.Quaternion(...object.initialPose.quaternion).invert());
        if (cloud) { cloud.position.fromArray(pose.position); cloud.quaternion.copy(displayRotation); cloud.traverse(n => { if (n instanceof THREE.Points) (n.material as THREE.PointsMaterial).size = p.settings.pointSize; }); }
        if (mesh) {
          mesh.position.fromArray(is2d ? object.center : pose.position); mesh.quaternion.copy(is2d ? new THREE.Quaternion() : displayRotation);
          const mask = masks.get(object.id); if (mask) { mask.visible = object.segmented; mask.traverse(n => { if (n instanceof THREE.Mesh) { const material = n.material as THREE.MeshBasicMaterial; material.color.set(object.color); material.opacity = object.id === p.selectedObjectId ? .7 : .6; } }); }
        }
        if (bbox) {
          bbox.visible = p.showBoxes && object.segmented; bbox.position.fromArray(pose.position); bbox.quaternion.copy(displayRotation);
          bbox.children.forEach(n => { if (n instanceof THREE.ArrowHelper && n.userData.frontArrow) { n.visible = object.id === p.selectedObjectId && !!object.front; if (object.front) { const axis = object.front[1], sign = object.front[0] === '+' ? 1 : -1; n.setDirection(new THREE.Vector3(axis === 'x' ? sign : 0, axis === 'y' ? sign : 0, axis === 'z' ? sign : 0)); n.setColor(FACE_COLORS[object.front]); } } if (n instanceof THREE.Mesh && n.userData.face) { const m = n.material as THREE.MeshBasicMaterial; m.opacity = object.id === p.selectedObjectId ? (object.front === n.userData.face ? .38 : .10) : .035; m.color.set(FACE_COLORS[n.userData.face as Face]); } });
        }
      }
      data.cloudRoot.children[0]?.traverse(n => { if (n instanceof THREE.Points) (n.material as THREE.PointsMaterial).size = p.settings.pointSize; });
      let displayedPose = controllerCameraPose(controller.observer);
      if (is2d) displayedPose = zeroPose();
      else if (rig) { displayedPose = controllerCameraPose(rig); if (activeObject) displayedPose.position = new THREE.Vector3(0, -.45, -2.9).applyQuaternion(new THREE.Quaternion(...displayedPose.quaternion)).add(new THREE.Vector3(...rig.position)).toArray() as Vec3; }
      else if (following && p.project.camera && p.project.cameraClip) displayedPose = sampleClip(p.project.camera, p.project.cameraClip, sceneTime);
      if (lens) applyCalibratedProjection(camera, lens); else { camera.aspect = width / height; camera.fov = 55; camera.updateProjectionMatrix(); }
      setCameraPose(camera, displayedPose); projection.update(is2d ? null : lens); updatePaths();
      const liveCapture = rig?.target === 'camera';
      const captureCalibration = liveCapture ? p.project.referenceCamera || DEFAULT_CAPTURE : p.project.cameraIntrinsics?.calibration || p.project.camera?.cameraIntrinsics?.calibration || p.project.referenceCamera || DEFAULT_CAPTURE;
      const capturePose = liveCapture ? recordingRigPose(rig) : p.project.camera && p.project.cameraClip ? sampleClip(p.project.camera, p.project.cameraClip, sceneTime) : zeroPose();
      const captureKinematics = p.project.camera && p.project.cameraClip ? clipKinematics(p.project.camera, p.project.cameraClip, sceneTime) : { speed: 0, angularSpeed: 0, velocity: [0, 0, 0] as Vec3 };
      const captureVelocity = liveCapture ? controller.flight.velocity : captureKinematics.velocity;
      velocityArrow.visible = !is2d && !lens && p.showTrajectories && Math.hypot(...captureVelocity) > 1e-7;
      if (velocityArrow.visible) { velocityArrow.position.fromArray(capturePose.position); velocityArrow.setDirection(new THREE.Vector3(...captureVelocity).normalize()); }
      const glyphKey = JSON.stringify(captureCalibration);
      if (glyphKey !== currentGlyphKey) { currentGlyphKey = glyphKey; disposeGroup(currentCameraRoot); currentCameraRoot.add(makeCameraGlyph(captureCalibration, .72)); projection.install(currentCameraRoot); }
      currentCameraRoot.visible = !is2d && !lens && p.showTrajectories && !!p.project.camera; currentCameraRoot.position.fromArray(capturePose.position); currentCameraRoot.quaternion.fromArray(capturePose.quaternion);
      limitCameraArrowHeads(overlay, camera, frameSizeNow.height);
      renderer.setScissorTest(false); renderer.setViewport(0, 0, width, height); renderer.clear();
      if (lens) { renderer.setViewport(frameSizeNow.left, frameSizeNow.top, frameSizeNow.width, frameSizeNow.height); renderer.setScissor(frameSizeNow.left, frameSizeNow.top, frameSizeNow.width, frameSizeNow.height); renderer.setScissorTest(true); }
      renderer.render(scene, camera); renderer.setScissorTest(false);
      if (now - lastLabels > 100) {
        lastLabels = now; const nextLabels: ObjectLabel[] = [];
        const placeLabel = (id: string, name: string, color: string, position: THREE.Vector3, annotation = false, referenceAxis = false) => {
          const pos = projectCalibratedPoint(position.applyQuaternion(BASIS), camera, lens);
          if (pos.z < 1 && pos.z > -1 && Math.abs(pos.x) < .98 && Math.abs(pos.y) < .98) {
            const x = ((pos.x + 1) / 2 * frameSizeNow.width + frameSizeNow.left) / width * 100;
            const anchorY = ((1 - pos.y) / 2 * frameSizeNow.height + frameSizeNow.top) / height * 100;
            let y = anchorY;
            if (referenceAxis) {
              for (let attempt = 0; attempt < 12; attempt++) {
                const offset = attempt === 0 ? 0 : Math.ceil(attempt / 2) * (attempt % 2 ? 1 : -1) * 21;
                const candidate = anchorY + offset / height * 100;
                if (candidate * height / 100 < 20 || candidate > 98) continue;
                if (!nextLabels.some(label => label.referenceAxis && Math.abs(label.x - x) * width / 100 < 30 && Math.abs(label.y - candidate) * height / 100 < 20)) { y = candidate; break; }
              }
            }
            nextLabels.push({ id, name, color, annotation, referenceAxis, x, y, ...(referenceAxis ? { anchorX: x, anchorY } : {}) });
          }
        };
        p.project.objects.filter(o => o.segmented && (is2d ? p.showMasks : p.showBoxes)).forEach(o => {
          const pose = !is2d && activeObject === o.id && activeObjectPose ? activeObjectPose : !is2d && o.motion === 'trajectory' && o.trajectory && o.clip ? sampleClip(o.trajectory, o.clip, sceneTime) : o.initialPose;
          const rotation = new THREE.Quaternion(...pose.quaternion).multiply(new THREE.Quaternion(...o.initialPose.quaternion).invert()); let top = Infinity;
          for (const x of [-o.halfExtents[0], o.halfExtents[0]]) for (const y of [-o.halfExtents[1], o.halfExtents[1]]) for (const z of [-o.halfExtents[2], o.halfExtents[2]]) top = Math.min(top, new THREE.Vector3(x, y, z).applyQuaternion(rotation).y);
          placeLabel(o.id, o.name, o.color, new THREE.Vector3(...pose.position).add(new THREE.Vector3(0, top - .12, 0)));
          if (!is2d && o.id === p.selectedObjectId) {
            referenceAxesForBox(o.halfExtents).forEach(axis => placeLabel(`bbox-axis-${o.id}-${axis.face}`, axis.face.toUpperCase(), axis.color, new THREE.Vector3(...axis.labelPosition).applyQuaternion(rotation).add(new THREE.Vector3(...pose.position)), true, true));
          }
        });
        if (!is2d && p.showTrajectories) pathAnnotations.forEach(a => placeLabel(a.id, a.text, a.color, new THREE.Vector3(...a.position).add(new THREE.Vector3(0, -.08, 0)), true));
        setLabels(nextLabels);
        if (!is2d && (p.project.camera || liveCapture)) {
          const currentRotation = new THREE.Quaternion(...capturePose.quaternion);
          const speed = liveCapture ? Math.hypot(...controller.flight.velocity) : captureKinematics.speed;
          const angularSpeed = liveCapture ? previousCaptureWasLive ? currentRotation.angleTo(previousCaptureRotation) / Math.max(.001, (now - previousCaptureTime) / 1000) : 0 : captureKinematics.angularSpeed;
          setCaptureReadout({ speed, angularSpeed: angularSpeed * 180 / Math.PI, fovH: captureCalibration.fov.horizontalDegrees, fovV: captureCalibration.fov.verticalDegrees, coefficients: captureCalibration.distortion.coefficients.map(v => Number(v.toFixed(4))).join(', '), time: sceneTime, lens: captureCalibration.distortion.model, intrinsic: `f ${captureCalibration.intrinsic[0][0].toFixed(1)}/${captureCalibration.intrinsic[1][1].toFixed(1)} · c ${captureCalibration.intrinsic[0][2].toFixed(1)}/${captureCalibration.intrinsic[1][2].toFixed(1)}`, imageSize: `${captureCalibration.imageWidth}×${captureCalibration.imageHeight}` });
          previousCaptureRotation.copy(currentRotation); previousCaptureTime = now; previousCaptureWasLive = liveCapture;
        } else setCaptureReadout(null);
      }
      if (now - lastTelemetry >= 100) { lastTelemetry = now; p.onTelemetry({ position: [...(activeObjectPose?.position || displayedPose.position)], speed: Math.hypot(...controller.flight.velocity), points: data.pointCount, controlled: controller.controlled }); }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      disposed = true; runtime.readyState = 'disposed'; cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener('pointerlockchange', lockChanged); document.removeEventListener('mousemove', mouseMove); window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); renderer.domElement.removeEventListener('contextmenu', contextMenu); renderer.domElement.removeEventListener('click', click); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility); release();
      document.removeEventListener('wheel', wheel);
      maskMaterials.forEach(material => material.dispose()); maskRoot.clear(); data.dispose(); disposeGroup(overlay); renderer.dispose(); renderer.domElement.remove(); runtimeRef.current = null;
    };
  }, [props.project.id, props.project.demoScene, props.project.demoSceneRevision]);

  const external = !props.project.demoScene;
  const cameraDrawingVisible = !(props.followCamera && props.recordState === 'preview') && !(props.target === 'camera' && usesRecordingRig(props.recordState));
  return <div ref={hostRef} className="scene-viewport" style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'var(--surface-inset)' }}>
    {external && props.project.reference && props.view === '2d' && <img src={props.project.reference} alt="项目首帧参考图" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />}
    {external && (!props.project.reference || props.view !== '2d') && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', textAlign: 'center', color: 'var(--text-secondary)', gap: 10 }}><span style={{ fontSize: 36, fontWeight: 300 }}>◇</span><strong>{props.view === '2d' ? '导入你的首帧参考图' : '等待场景重建'}</strong><span style={{ fontSize: 12 }}>{props.view === '2d' ? '从 Projects 面板上传图片，开始创建场景。' : '外部图像需要连接 CE 推理服务后生成点云。'}</span></div>}
    {!external && !ready && !failure && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', color: 'var(--text-muted)', fontSize: 13 }}>正在准备交互场景…</div>}
    {failure && <div style={{ position: 'absolute', inset: 0, display: 'grid', placeContent: 'center', padding: 40, textAlign: 'center', color: 'var(--danger-text)' }}>{failure}</div>}
    {props.view === '3d' && captureReadout && <details open style={{ position: 'absolute', right: 16, top: 52, width: 285, maxWidth: 'calc(100% - 32px)', maxHeight: 'calc(100% - 100px)', overflow: 'auto', pointerEvents: 'auto', border: '1px solid var(--hud-border)', borderRadius: 6, padding: '8px 10px', background: 'var(--hud-bg)', color: 'var(--hud-text)', textShadow: 'var(--hud-shadow)', fontSize: 11, lineHeight: 1.65, fontFamily: 'ui-monospace, monospace', scrollbarWidth: 'thin' }}>
      <summary style={{ color: 'var(--hud-accent)', cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}>拍摄相机 · {captureReadout.time.toFixed(2)} s <span style={{ color: 'var(--hud-muted)' }}>{captureReadout.imageSize}</span></summary>
      <div style={{ marginTop: 5 }}>{captureReadout.speed.toFixed(3)} su/s <span style={{ color: 'var(--hud-muted)' }}>·</span> {captureReadout.angularSpeed.toFixed(1)} °/s</div>
      <div><span style={{ color: '#e5c088' }}>↗ 拍摄光轴</span> <span style={{ color: '#7adaac' }}>↗ 移动方向</span></div>
      <div>FOV {captureReadout.fovH.toFixed(1)}° × {captureReadout.fovV.toFixed(1)}°</div>
      <div>K {captureReadout.intrinsic}</div>
      <div style={{ color: 'var(--hud-muted)' }}>k1, k2, p1, p2, k3</div><div>{captureReadout.coefficients}</div>
      {captureReadout.lens !== 'none' && <div><span style={{ color: '#82a6a5' }}>─ 理想</span> <span style={{ color: '#e7c275' }}>─ 畸变边界</span></div>}
    </details>}
    {props.view === '3d' && props.showTrajectories && ((props.project.camera && cameraDrawingVisible) || props.project.objects.some(o => o.trajectory) || (props.draftSamples.length > 1 && props.target !== 'camera')) && <div style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 12, width: 182, pointerEvents: 'none', padding: '7px 9px', border: '1px solid var(--hud-border)', borderRadius: 5, background: 'var(--hud-bg)', color: 'var(--hud-text)', textShadow: 'var(--hud-shadow)', fontSize: 11, fontFamily: 'ui-monospace, monospace' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}><span>平移速率 · su/s</span><span>全轨迹</span></div><div style={{ height: 4, borderRadius: 3, background: `linear-gradient(to right, ${Array.from({ length: 9 }, (_, i) => speedColor(i / 8, 1)).join(',')})` }} /><div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 3 }}><span>0</span><span>{maximumPathSpeed.toFixed(3)}</span></div>
    </div>}
    <svg aria-hidden="true" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>{labels.filter(label => label.referenceAxis && label.y !== label.anchorY).map(label => <line key={label.id} x1={`${label.anchorX}%`} y1={`${label.anchorY}%`} x2={`${label.x}%`} y2={`${label.y}%`} stroke={label.color} strokeWidth={1} />)}</svg>
    {labels.map(label => <button key={label.id} tabIndex={label.annotation ? -1 : undefined} aria-label={label.referenceAxis ? `bbox 参考轴 ${label.name}` : undefined} onClick={() => { if (!label.annotation) props.onObjectPick(label.id); }} style={{ position: 'absolute', left: `${label.x}%`, top: `${label.y}%`, transform: 'translate(-50%, -100%)', padding: label.referenceAxis ? '2px 3px' : '5px 9px', border: `1px solid ${label.color}`, borderRadius: 5, background: 'var(--hud-label-bg)', color: 'var(--hud-label-text)', textShadow: 'var(--hud-shadow)', fontFamily: 'inherit', fontSize: label.referenceAxis ? 11 : 10, whiteSpace: 'nowrap', fontWeight: 600, cursor: label.annotation ? 'default' : 'pointer', pointerEvents: label.annotation ? 'none' : 'auto', opacity: label.annotation && !label.referenceAxis ? .85 : 1, display: 'flex', alignItems: 'center', gap: 5 }}>{!label.referenceAxis && <span style={{ width: 5, height: 5, background: label.color, borderRadius: '50%' }} />}{label.name}{props.selectedObjectId === label.id && <span style={{ opacity: .5 }}>↗</span>}</button>)}
  </div>;
});

export default SceneViewport;
