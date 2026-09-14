import type { GlobalExecution, WorkflowCapabilities, WorkflowJob, WorkflowRequest } from './types';

export class WorkflowError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
export async function workflowApi<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  if (signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 45000);
  try {
    const requestId = body && typeof body === 'object' && 'requestId' in body ? String(body.requestId) : undefined;
    const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', signal: controller.signal,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(requestId ? { 'Idempotency-Key': requestId } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json();
    if (!response.ok) throw new WorkflowError(typeof data.message === 'string' ? data.message : `HTTP ${response.status}`, response.status);
    return data as T;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}
export const getWorkflowCapabilities = () => workflowApi<WorkflowCapabilities>('/workflow/capabilities');
export const getGlobalExecution = () => workflowApi<GlobalExecution>('/settings/execution');
export const submitWorkflow = (request: WorkflowRequest) => workflowApi<WorkflowJob>('/workflow/jobs', 'POST', request);
export const getWorkflowJobs = (projectId: string, signal?: AbortSignal) => workflowApi<{ jobs: WorkflowJob[] }>(`/workflow/projects/${encodeURIComponent(projectId)}/jobs`, 'GET', undefined, signal);
export function outputUrl(job: Pick<WorkflowJob, 'outputs'>, name: string): string {
  const entry = job.outputs.find(output => output.name === name);
  if (!entry || !/^inference\/jobs\/[A-Za-z0-9-]+\/outputs\/\d+$/.test(entry.url)) throw new Error(`缺少有效产物：${name}`);
  return `/api/${entry.url}`;
}
export async function fetchOutput<T>(job: WorkflowJob, name: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(outputUrl(job, name), { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error(`读取产物失败：HTTP ${response.status}`);
  return response.json();
}
export async function getJob(jobId: string, signal?: AbortSignal): Promise<WorkflowJob> {
  return workflowApi<WorkflowJob>(`/inference/jobs/${encodeURIComponent(jobId)}`, 'GET', undefined, signal);
}
