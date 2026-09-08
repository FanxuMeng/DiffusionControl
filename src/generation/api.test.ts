import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGenerationCapabilities, fetchGenerationJob, GenerationRejectedError, isTerminalJob, normalizeApiBase, submitGenerationJob } from './api';
import type { GenerationRequest } from './types';

const request: GenerationRequest = { apiVersion: 1, requestId: 'request-1', createdAt: '2026-09-08T00:00:00.000Z', projectId: 'studio', projectName: '示例', projectProfileId: 'draft-1', profileId: 'symphomotion-single-gpu', profileVersion: 1, parameters: { seed: 42 }, argv: ['python3', 'infer.py', '--seed', '42'], command: 'python3 infer.py --seed 42' };
const job = { id: 'job-1', requestId: 'request-1', status: 'running', progress: .4, message: '运行中', outputs: [] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('CE generation task client', () => {
  it('normalizes API paths and rejects credentials or non-HTTP endpoints', () => {
    expect(normalizeApiBase(' https://ce.example/api/ ')).toBe('https://ce.example/api');
    expect(normalizeApiBase('/api')).toBe('http://localhost/api');
    for (const endpoint of ['', '//host/api', 'javascript:alert(1)', 'https://user:secret@ce.example', 'https://ce.example?key=secret']) expect(() => normalizeApiBase(endpoint)).toThrow();
  });

  it('validates the remote model/version catalog without treating HTTP 200 as sufficient', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ apiVersion: 1, profiles: [{ id: 'custom', version: 2 }] })).mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    expect((await fetchGenerationCapabilities('https://ce.example/api')).profiles).toEqual([{ id: 'custom', version: 2 }]);
    expect(fetch.mock.calls[0][0]).toBe('https://ce.example/api/inference/capabilities');
    await expect(fetchGenerationCapabilities('https://ce.example/api')).rejects.toThrow('能力清单');
  });

  it('submits the exact snapshot with an idempotency key and leaves the input untouched', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(job)); vi.stubGlobal('fetch', fetch);
    const before = structuredClone(request);
    const received = await submitGenerationJob('https://ce.example/api', request);
    expect(received.progress).toBe(.4);
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(request.requestId);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(before);
    expect(request).toEqual(before);
    await submitGenerationJob('https://ce.example/api', request);
    expect(fetch.mock.calls[1][1].body).toBe(fetch.mock.calls[0][1].body);
    expect(fetch.mock.calls[1][1].headers['Idempotency-Key']).toBe('request-1');
  });

  it('binds status responses to job and request IDs and resolves asset URLs', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...job, status: 'succeeded', outputs: [{ name: '生成视频', url: '/assets/video.mp4' }] })).mockResolvedValueOnce(response({ ...job, requestId: 'another-request' })).mockResolvedValueOnce(response({ ...job, id: 'another-job' }));
    vi.stubGlobal('fetch', fetch);
    const result = await fetchGenerationJob('https://ce.example/api', 'job-1', 'request-1');
    expect(result.outputs[0].url).toBe('https://ce.example/assets/video.mp4');
    expect(isTerminalJob(result)).toBe(true);
    await expect(fetchGenerationJob('https://ce.example/api', 'job-1', 'request-1')).rejects.toThrow('不匹配');
    await expect(fetchGenerationJob('https://ce.example/api', 'job-1', 'request-1')).rejects.toThrow('不匹配');
  });

  it('rejects invalid progress, unrecognized states and executable output links', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...job, progress: 75 })).mockResolvedValueOnce(response({ ...job, status: 'probably_done' })).mockResolvedValueOnce(response({ ...job, outputs: [{ name: 'x', url: 'javascript:alert(1)' }] }));
    vi.stubGlobal('fetch', fetch);
    await expect(fetchGenerationJob('https://ce.example', 'job-1', 'request-1')).rejects.toThrow('0–1');
    await expect(fetchGenerationJob('https://ce.example', 'job-1', 'request-1')).rejects.toThrow('状态无效');
    await expect(fetchGenerationJob('https://ce.example', 'job-1', 'request-1')).rejects.toThrow('HTTP(S)');
  });

  it('reports HTTP and network failures without returning a fabricated job', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ message: '模型版本未注册' }, 409)).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetch);
    await expect(submitGenerationJob('https://ce.example', request)).rejects.toThrow('模型版本未注册');
    await expect(submitGenerationJob('https://ce.example', request)).rejects.toThrow('无法连接');
  });

  it('distinguishes definite POST rejection from uncertain submission and GET failure', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ message: '条件 CSV 不存在' }, 422))
      .mockResolvedValueOnce(new Response('invalid request', { status: 400 }))
      .mockResolvedValueOnce(response({ message: '服务错误' }, 500))
      .mockResolvedValueOnce(response({ message: '参数错误' }, 422)));
    await expect(submitGenerationJob('https://ce.example', request)).rejects.toMatchObject({ name: 'GenerationRejectedError', status: 422, message: expect.stringContaining('条件 CSV 不存在') });
    await expect(submitGenerationJob('https://ce.example', request)).rejects.toBeInstanceOf(GenerationRejectedError);
    await expect(submitGenerationJob('https://ce.example', request)).rejects.not.toBeInstanceOf(GenerationRejectedError);
    await expect(fetchGenerationJob('https://ce.example', 'job-1', 'request-1')).rejects.not.toBeInstanceOf(GenerationRejectedError);
  });

  it('aborts timed-out submissions and identifies their result as unconfirmed', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))));
    const pending = submitGenerationJob('https://ce.example', request);
    const check = expect(pending).rejects.toThrow('沿用原请求 ID');
    await vi.advanceTimersByTimeAsync(15001);
    await check;
  });

  it('distinguishes intentional polling cancellation from remote job failure', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn((_url, options: RequestInit) => new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))));
    const pending = fetchGenerationJob('https://ce.example', 'job-1', 'request-1', controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});
