import type { GenerationCapabilities, GenerationJob, GenerationRequest } from './types';

const ENDPOINT_KEY = 'diffusioncontrol.ce.apiBaseUrl';
const TIMEOUT_MS = 15000;
/** API v1 reserves these POST statuses for rejection before job creation. */
export class GenerationRejectedError extends Error {
  readonly status: 400 | 422;
  constructor(status: 400 | 422, message: string) {
    super(message);
    this.name = 'GenerationRejectedError';
    this.status = status;
  }
}
export function readApiEndpoint(): string {
  try { const value = localStorage.getItem(ENDPOINT_KEY); if (value !== null) return value; } catch { /* Session-only settings remain usable. */ }
  return import.meta.env.VITE_CE_API_BASE_URL ?? '';
}
export function saveApiEndpoint(value: string) { try { localStorage.setItem(ENDPOINT_KEY, value); } catch { /* The current connection still works. */ } }
export function normalizeApiBase(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('请填写 CE API 根地址。');
  if (input.startsWith('//')) throw new Error('请使用完整 HTTP(S) 地址或同源 /api 路径。');
  let url: URL;
  try {
    url = input.startsWith('/') ? new URL(input, typeof window === 'undefined' ? 'http://localhost' : window.location.origin) : new URL(input);
  } catch { throw new Error('CE API 地址格式无效。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('CE API 需使用不含凭据、查询参数或片段的 HTTP(S) 根地址。');
  return url.toString().replace(/\/+$/, '');
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('CE 响应不是有效对象。');
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max = 4096): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`CE 响应 ${label} 格式无效。`);
  return value;
}
function id(value: unknown, label: string): string {
  const result = text(value, label, 200);
  if (!result.trim() || /[\r\n]/.test(result)) throw new Error(`CE 响应 ${label} 不能为空或包含换行。`);
  return result;
}
async function jsonRequest(endpoint: string, path: string, options: RequestInit, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
  try {
    const response = await fetch(`${normalizeApiBase(endpoint)}${path}`, { ...options, credentials: 'include', signal: controller.signal, headers: { Accept: 'application/json', ...options.headers } });
    let body: unknown;
    try { body = await response.json(); } catch {
      const message = `CE 返回非 JSON 响应（HTTP ${response.status}），请检查 API 路径和登录状态。`;
      if (options.method === 'POST' && (response.status === 400 || response.status === 422)) throw new GenerationRejectedError(response.status, message);
      throw new Error(message);
    }
    if (!response.ok) {
      const message = body && typeof body === 'object' && 'message' in body && typeof body.message === 'string' ? body.message.slice(0, 1000) : response.statusText;
      if (options.method === 'POST' && (response.status === 400 || response.status === 422)) throw new GenerationRejectedError(response.status, `CE 拒绝请求（HTTP ${response.status}）：${message || '请检查参数'}`);
      throw new Error(`CE 请求失败（HTTP ${response.status}）：${message || '服务未接受请求'}`);
    }
    return body;
  } catch (error) {
    if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError');
    if (timedOut) throw new Error('CE 请求超时；提交结果可能尚未确认，重试应沿用原请求 ID。');
    if (error instanceof TypeError) throw new Error('无法连接 CE API，请检查地址、网络、CORS 和登录状态。');
    throw error;
  } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
}

export async function fetchGenerationCapabilities(endpoint: string, signal?: AbortSignal): Promise<GenerationCapabilities> {
  const raw = object(await jsonRequest(endpoint, '/inference/capabilities', { method: 'GET' }, signal));
  if (raw.apiVersion !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 200) throw new Error('CE 服务未返回支持的 v1 模型能力清单。');
  const profiles = raw.profiles.map(value => {
    const profile = object(value), version = profile.version;
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) throw new Error('CE 模型 profile 版本无效。');
    return { id: id(profile.id, 'profile.id'), version };
  });
  if (new Set(profiles.map(profile => `${profile.id}@${profile.version}`)).size !== profiles.length) throw new Error('CE 能力清单包含重复的模型版本。');
  return { apiVersion: 1, profiles };
}

function parseJob(rawValue: unknown, endpoint: string, requestId: string, jobId?: string): GenerationJob {
  const raw = object(rawValue), responseId = id(raw.id, 'job.id');
  if (id(raw.requestId, 'job.requestId') !== requestId || (jobId && responseId !== jobId)) throw new Error('CE 返回的作业与本次请求不匹配。');
  const status = raw.status;
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(String(status))) throw new Error('CE 作业状态无效。');
  if (raw.progress !== undefined && (typeof raw.progress !== 'number' || !Number.isFinite(raw.progress) || raw.progress < 0 || raw.progress > 1)) throw new Error('CE 作业进度应为 0–1。');
  if (!Array.isArray(raw.outputs) || raw.outputs.length > 100) throw new Error('CE 作业输出清单无效。');
  const outputs = raw.outputs.map(value => {
    const output = object(value), name = text(output.name, 'output.name', 200), path = text(output.url, 'output.url', 8192);
    let url: URL;
    try { url = new URL(path, `${normalizeApiBase(endpoint)}/`); } catch { throw new Error('CE 输出链接无效。'); }
    if (!path.trim() || path.startsWith('//') || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('CE 输出链接必须为可访问的 HTTP(S) 资产。');
    return { name, url: url.toString() };
  });
  return { id: responseId, requestId, status: status as GenerationJob['status'], message: text(raw.message, 'job.message'), outputs, ...(raw.progress !== undefined ? { progress: raw.progress as number } : {}) };
}

export async function submitGenerationJob(endpoint: string, request: GenerationRequest, signal?: AbortSignal): Promise<GenerationJob> {
  id(request.requestId, 'requestId');
  const raw = await jsonRequest(endpoint, '/inference/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': request.requestId }, body: JSON.stringify(request) }, signal);
  return parseJob(raw, endpoint, request.requestId);
}
export async function fetchGenerationJob(endpoint: string, jobId: string, requestId: string, signal?: AbortSignal): Promise<GenerationJob> {
  id(jobId, 'jobId'); id(requestId, 'requestId');
  const raw = await jsonRequest(endpoint, `/inference/jobs/${encodeURIComponent(jobId)}`, { method: 'GET' }, signal);
  return parseJob(raw, endpoint, requestId, jobId);
}
export function isTerminalJob(job: GenerationJob): boolean { return ['succeeded', 'failed', 'cancelled'].includes(job.status); }
