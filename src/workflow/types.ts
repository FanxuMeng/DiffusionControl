import type { GenerationJob, SlurmExecutionConfig } from '../generation/types';
import type { Mat3, Quat, Vec3 } from '../types';
export type TaskKind = 'depth' | 'sam2' | 'associate' | 'export';
export type PromptPoint = [number, number, 0 | 1];
export interface SamPrompts { points: PromptPoint[]; box: [number, number, number, number] | null }
export interface WorkflowInputs { referenceAssetId: string; sceneJobId?: string; segmentationJobId?: string; objectJobIds?: string[]; replaceObjectJobId?: string }
export interface WorkflowRequest {
  version: 1; requestId: string; createdAt: string; projectId: string; projectName: string;
  kind: TaskKind; inputs: WorkflowInputs; options: Record<string, unknown>; execution: SlurmExecutionConfig;
}
export interface WorkflowJob extends GenerationJob {
  kind: TaskKind; inputs: WorkflowInputs; options: Record<string, unknown>;
  slurmId?: string; createdAt?: string;
  outputDirectory?: string;
}
export interface WorkflowState {
  version: 1; referenceAssetId: string; width: number; height: number;
  sceneJobId?: string; exportJobId?: string; pending: WorkflowRequest[];
  objectDefinitions?: ObjectDefinition[];
}
export interface ObjectDefinition {
  replaceObjectJobId?: string;
  id: string; name: string; prompt: string; requestId: string; createdAt: string;
  sceneJobId: string; segmentationJobId: string; candidate: number;
  submissionError?: string;
}
export interface WorkflowResult {
  kind: TaskKind; source: WorkflowInputs; width?: number; height?: number; intrinsic?: Mat3; pointCount?: number;
  center?: Vec3; halfExtents?: Vec3; boxQuaternion?: Quat; candidates?: { index: number; score: number; pixels: number; mask: string; overlay: string }[];
  renderStrategy?: string;
  validationCsv?: string; numFrames?: number; fps?: number; maxArea?: number; numEntities?: number;
}
export interface PointPreview { positions: Float32Array; colors: Float32Array; pointIds: Uint32Array }
export interface RealSceneData { scene: PointPreview; objects: Record<string, { preview: PointPreview; pointIds: Uint32Array }> }
export interface WorkflowCapabilities {
  version: 1; environments: string[];
  projectsRoot?: string;
  tasks: { kind: TaskKind; environment: string; available: boolean; reason: string | null; checkpoint?: string }[];
}
export interface GlobalExecution { revision: number; scriptName: string; scriptContent: string }
