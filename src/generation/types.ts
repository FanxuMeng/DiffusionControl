export type GenerationValues = Record<string, string>;
export type GenerationParameters = Record<string, string | number | boolean | string[]>;
export interface GenerationParameter {
  key: string; flag: string; label: string;
  type: 'string' | 'path' | 'integer' | 'number' | 'boolean' | 'enum' | 'list';
  defaultValue: string; required?: boolean; min?: number; max?: number;
  choices?: string[]; falseFlag?: string; nargs?: number | '+'; description?: string;
}
export interface ModelProfile {
  id: string; version: number; name: string; model: string;
  commandPrefix: string[]; parameters: GenerationParameter[];
  description: string; inputRequirements: string[];
  source?: { url: string; revision: string };
}
export interface SlurmExecutionConfig {
  kind: 'slurm_sbatch'; version: 1; envName: string; scriptName: string; scriptContent: string;
}
export interface SlurmRequestExecution extends SlurmExecutionConfig { argv: string[]; command: string }
export interface ProjectGenerationProfile {
  id: string; name: string; modelProfileId: string; modelProfileVersion: number;
  values: GenerationValues; commandText: string; editSource: 'form' | 'command';
  execution: SlurmExecutionConfig;
  useGlobalExecution?: boolean;
}
export interface GenerationRequest {
  apiVersion: 1 | 2; requestId: string; createdAt: string;
  projectId: string; projectName: string; projectProfileId: string;
  profileId: string; profileVersion: number;
  parameters: GenerationParameters; argv: string[]; command: string;
  execution?: SlurmRequestExecution;
}
export interface GenerationJob {
  id: string; requestId: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress?: number; message: string; outputs: { name: string; url: string }[];
  cancelRequested?: boolean;
}
export interface GenerationSubmission {
  endpoint: string; request: GenerationRequest; job?: GenerationJob;
  rejection?: { status: 400 | 422; message: string };
}
export interface GenerationState {
  version: 1; selectedModelId: string; activeProfileIds: Record<string, string>;
  projectProfiles: ProjectGenerationProfile[]; customProfiles: ModelProfile[];
  submissions: GenerationSubmission[];
}
export interface GenerationIssue { field?: string; message: string }
export interface GenerationInspection {
  model?: ModelProfile; draft?: ProjectGenerationProfile; issues: GenerationIssue[];
  argv: string[]; parameters: GenerationParameters | null;
  submissionArgv: string[]; submissionCommand: string;
  commandParseable: boolean; canExecute: boolean;
}
export interface GenerationCapabilities { apiVersion: 1 | 2; profiles: { id: string; version: number; environmentNames?: string[] }[]; executionModes?: string[] }
