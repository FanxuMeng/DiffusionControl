import type { GenerationState } from './generation/types';
import type { RealSceneData, SamPrompts, WorkflowState } from './workflow/types';

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];
export type Quat = [number, number, number, number];
export type View = '2d' | '3d';
export type RecordState = 'preview' | 'countdown' | 'recording' | 'paused' | 'saving';
export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';
export interface Pose { position: Vec3; quaternion: Quat }
export interface SelectionBox { center: Vec3; halfExtents: Vec3; quaternion: Quat }
export interface BoxEditState {
  projectId: string; objectId: string; sourceJobId: string;
  original: SelectionBox; box: SelectionBox; mode: 'translate' | 'rotate' | 'scale';
}
export interface Sample extends Pose { t: number }
export interface CameraCalibration {
  id: string; revision: number; model: 'pinhole'; imageWidth: number; imageHeight: number;
  pixelCenters: 'integer_coordinates'; intrinsic: Mat3;
  fov: { horizontalDegrees: number; verticalDegrees: number; derivedFrom: 'intrinsic_and_image_bounds' };
  distortion: { model: 'none' | 'brown_conrady_5'; coefficientOrder: ['k1', 'k2', 'p1', 'p2', 'k3']; coefficients: [number, number, number, number, number]; state: 'assumed' | 'estimated' | 'calibrated' };
  source: string;
}
export interface CameraIntrinsicsTrack {
  id: string; revision: number; mode: 'fixed'; timeDomain: 'trajectory_local_seconds'; calibration: CameraCalibration;
}
export interface MotionClip {
  id: string; revision: number; trajectoryId: string; trajectoryRevision: number;
  start: number; duration: number; timeMap: { mode: 'linear' };
  before: 'hold_first_pose'; after: 'hold_last_pose';
}
export interface TrajectoryKinematics { velocity: Vec3; speed: number; angularVelocity: Vec3; angularSpeed: number }
export interface MigrationResult {
  projects: Project[]; issues: { projectId: string | null; code: string; message: string }[];
  sourceVersion: number; targetVersion: 2;
}
export interface Trajectory {
  id: string; revision: number; name: string; kind: 'object' | 'camera'; samples: Sample[]; duration: number;
  preview: string; createdAt: string; source: 'recorded' | 'preset' | 'imported';
  cameraIntrinsics?: CameraIntrinsicsTrack;
}
export interface SceneObject {
  id: string; name: string; color: string; prompt: string;
  shape: 'chair' | 'plant' | 'table' | 'sphere' | 'humanoid' | 'pointcloud'; center: Vec3; halfExtents: Vec3;
  segmented: boolean; front: Face | null; initialPose: Pose;
  boxQuaternion?: Quat;
  motion: 'unassigned' | 'static' | 'trajectory'; trajectory: Trajectory | null; clip: MotionClip | null; history: Trajectory[];
  maskPreview?: string;
  reconstruction?: { jobId: string; sceneJobId: string };
}
export interface Project {
  motionControls?: Partial<Record<'object' | 'camera', { enabled: boolean; binding: string }>>;
  workflow?: WorkflowState;
  generation: GenerationState;
  id: string; name: string; description: string; parentPath: string; reference: string | null;
  demoScene: 'studio' | 'gallery' | null; demoSceneRevision: number | null; objects: SceneObject[]; geometryReady: boolean;
  fourD: 'missing' | 'ready' | 'stale'; camera: Trajectory | null; cameraHistory: Trajectory[];
  referenceCamera: CameraCalibration | null; cameraIntrinsics: CameraIntrinsicsTrack | null; cameraClip: MotionClip | null;
  duration: number; fps: number; updatedAt: string;
}
export interface ControlSettings { moveSpeed: number; rollSpeed: number; sensitivity: number; pointSize: number }
export interface Telemetry { position: Vec3; speed: number; points: number; controlled: boolean }
export interface SceneHandle {
  requestControl: () => Promise<boolean>;
  releaseControl: () => void;
  resetView: () => void;
  prepareTarget: (target: string) => void;
  getPose: (target: string) => Pose;
}
export interface SceneViewportProps {
  boxEdit?: BoxEditState | null;
  onBoxChange?: (box: SelectionBox) => void;
  realScene?: RealSceneData | null;
  sceneError?: string; onRetryScene?: () => void;
  samPrompts?: SamPrompts; samPromptMode?: 'positive' | 'negative' | 'box';
  onSamPromptsChange?: (prompts: SamPrompts) => void;
  project: Project; view: View; selectedObjectId: string | null; target: string | null;
  recordState: RecordState; time: number; playing: boolean; followCamera: boolean;
  getCaptureTime?: () => number;
  showMasks: boolean; segmenting: boolean; showBoxes: boolean; showTrajectories: boolean;
  settings: ControlSettings; draftSamples: Sample[];
  onMoveSpeedChange: (steps: number) => void;
  onObjectPick: (id: string) => void; onFrontPick: (id: string, face: Face) => void;
  onObjectPreviewsReady?: (previews: Record<string, string>) => void;
  onReferenceReady: (url: string) => void; onTelemetry: (info: Telemetry) => void;
  onPause: () => void; onControlLost: () => void; onError: (message: string) => void;
}
