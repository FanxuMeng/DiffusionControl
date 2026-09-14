import type { WorkflowState } from './types';
import { validateSlurmExecutionDraft } from '../generation/slurm';

export function validateWorkflowState(raw: unknown, projectId?: string): WorkflowState | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工作流状态无效。');
  const value = raw as WorkflowState;
  if (value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.referenceAssetId)) throw new Error('工作流版本或首帧资产 ID 无效。');
  if (![value.width, value.height].every(x => Number.isInteger(x) && x >= 16 && x <= 16384) || value.width * value.height > 16000000) throw new Error('首帧尺寸无效。');
  for (const key of ['sceneJobId', 'exportJobId'] as const) if (value[key] !== undefined && !/^[a-zA-Z0-9-]{1,200}$/.test(value[key]!)) throw new Error('工作流作业 ID 无效。');
  if (!Array.isArray(value.pending) || value.pending.length > 20) throw new Error('待确认的工作流提交过多。');
  for (const request of value.pending) {
    if (!request || request.version !== 1 || !['depth', 'sam2', 'associate', 'export'].includes(request.kind) || typeof request.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(request.requestId) || !request.inputs || !request.options || typeof request.options !== 'object' || Array.isArray(request.options)) throw new Error('待确认任务格式无效。');
    if (typeof request.projectId !== 'string' || (projectId !== undefined && request.projectId !== projectId) || typeof request.projectName !== 'string' || !request.projectName.trim() || !Number.isFinite(Date.parse(request.createdAt))) throw new Error('待确认任务的项目或时间无效。');
    validateSlurmExecutionDraft(request.execution);
    if (request.inputs.referenceAssetId !== value.referenceAssetId) throw new Error('待确认任务与首帧不一致。');
  }
  if (new Set(value.pending.map(request => request.requestId)).size !== value.pending.length) throw new Error('待确认任务 ID 重复。');
  if (value.objectDefinitions !== undefined) {
    if (!Array.isArray(value.objectDefinitions) || value.objectDefinitions.length > 100) throw new Error('物体定义过多或无效。');
    for (const item of value.objectDefinitions) {
      if (item.replaceObjectJobId !== undefined && (typeof item.replaceObjectJobId !== 'string' || !/^[A-Za-z0-9-]{1,200}$/.test(item.replaceObjectJobId))) throw new Error('被替换物体作业 ID 无效。');
      if (!item || !['id', 'requestId', 'sceneJobId', 'segmentationJobId'].every(key => typeof item[key as keyof typeof item] === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(String(item[key as keyof typeof item])))
        || item.id === 'camera' || item.sceneJobId !== value.sceneJobId || !Number.isInteger(item.candidate) || item.candidate < 0 || item.candidate > 2
        || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 200 || typeof item.prompt !== 'string' || item.prompt.length > 10000
        || !Number.isFinite(Date.parse(item.createdAt))) throw new Error('物体定义与场景不匹配或格式无效。');
      if (item.submissionError !== undefined && (typeof item.submissionError !== 'string' || item.submissionError.length > 2000)) throw new Error('物体提交错误信息无效。');
    }
    if (new Set(value.objectDefinitions.map(item => item.id)).size !== value.objectDefinitions.length || new Set(value.objectDefinitions.map(item => item.requestId)).size !== value.objectDefinitions.length) throw new Error('物体定义 ID 重复。');
  }
  return structuredClone(value);
}
