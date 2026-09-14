import type { Project } from '../types';
import type { GlobalExecution, ObjectDefinition, TaskKind, WorkflowInputs, WorkflowRequest } from './types';

export function makeWorkflowRequest(project: Project, kind: TaskKind, inputs: WorkflowInputs, options: Record<string, unknown>, envName: string, execution: GlobalExecution): WorkflowRequest {
  const request: WorkflowRequest = { version: 1, requestId: `task_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`,
    createdAt: new Date().toISOString(), projectId: project.id, projectName: project.name, kind, inputs, options,
    execution: { kind: 'slurm_sbatch', version: 1, envName, scriptName: execution.scriptName, scriptContent: execution.scriptContent } };
  if (new TextEncoder().encode(JSON.stringify(request)).length > 1024 * 1024) throw new Error('任务快照超过 1 MiB；请缩短或精简轨迹。');
  if ((project.workflow?.pending.length || 0) >= 20) throw new Error('请先确认已有提交结果。');
  return request;
}

export function enqueueWorkflowRequest(project: Project, request: WorkflowRequest, definition?: Omit<ObjectDefinition, 'requestId' | 'createdAt' | 'sceneJobId'>): Project {
  if (!project.workflow || project.workflow.referenceAssetId !== request.inputs.referenceAssetId || project.id !== request.projectId) return project;
  return { ...project, ...(definition && project.fourD !== 'missing' ? { fourD: 'stale' as const } : {}), workflow: { ...project.workflow,
    pending: [...project.workflow.pending, request],
    ...(definition ? { objectDefinitions: [...(project.workflow.objectDefinitions || []).filter(item => item.id !== definition.id),
      { ...definition, requestId: request.requestId, createdAt: request.createdAt, sceneJobId: request.inputs.sceneJobId! }] } : {}) } };
}
