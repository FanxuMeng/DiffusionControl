import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGenerationCapabilities, fetchGenerationJob, GenerationRejectedError, isTerminalJob, normalizeApiBase, readApiEndpoint, SAME_ORIGIN_API_BASE, saveApiEndpoint, submitGenerationJob, supportsSlurmExecution } from './api';
import { createSlurmExecution } from './slurm';
import type { GenerationRequest } from './types';

const request: GenerationRequest = { apiVersion: 2, requestId: 'request-1', createdAt: '2026-09-09T00:00:00.000Z', projectId: 'studio', projectName: '示例', projectProfileId: 'draft-1', profileId: 'symphomotion-single-gpu', profileVersion: 1, parameters: { seed: 42 }, argv: ['python3', 'infer.py', '--seed', '42'], command: 'python3 infer.py --seed 42', execution: { ...createSlurmExecution(), argv: ['sbatch', 'job.gpu', 'ENVNAME=base', 'python3', 'infer.py', '--seed', '42'], command: 'sbatch job.gpu ENVNAME=base python3 infer.py --seed 42' } };
const job = { id: 'job-1', requestId: 'request-1', status: 'running', progress: .4, message: '运行中', outputs: [] };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('CE endpoint settings', () => {
  function storage(initial: string | null = null) {
    let value = initial;
    vi.stubGlobal('localStorage', { getItem: () => value, setItem: (_key: string, next: string) => { value = next; } });
  }

  it('defaults to /api for missing or blank browser and build settings', () => {
    for (const configured of [undefined, '', '  ']) {
      vi.stubEnv('VITE_CE_API_BASE_URL', configured);
      for (const saved of [null, '', '  ']) {
        storage(saved);
        expect(readApiEndpoint()).toBe('/api');
      }
    }
  });

  it('preserves explicit browser overrides and falls back to build configuration', () => {
    vi.stubEnv('VITE_CE_API_BASE_URL', ' https://deployment.example/api ');
    storage(' https://existing.example/api ');
    expect(readApiEndpoint()).toBe('https://existing.example/api');
    storage('');
    expect(readApiEndpoint()).toBe('https://deployment.example/api');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('Storage unavailable'); } });
    expect(readApiEndpoint()).toBe('https://deployment.example/api');
  });

  it('restores /api over custom settings without fixing it to the current host', async () => {
    storage('https://existing.example/api');
    vi.stubEnv('VITE_CE_API_BASE_URL', 'https://deployment.example/api');
    saveApiEndpoint(SAME_ORIGIN_API_BASE);
    expect(readApiEndpoint()).toBe('/api');
    const fetch = vi.fn().mockImplementation(async () => response({ apiVersion: 2, profiles: [], executionModes: ['slurm_sbatch_v1'] }));
    vi.stubGlobal('fetch', fetch);
    for (const origin of ['https://ce.example', 'http://localhost:5174']) {
      vi.stubGlobal('window', { location: { origin } });
      await fetchGenerationCapabilities(readApiEndpoint());
      expect(fetch).toHaveBeenLastCalledWith(`${origin}/api/inference/capabilities`, expect.objectContaining({ method: 'GET', credentials: 'include' }));
      expect(readApiEndpoint()).toBe('/api');
    }
  });
});

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

  it('requires explicit v2 Slurm capability even when a model is registered', async () => {
    const profiles = [{ id: 'symphomotion-single-gpu', version: 1 }];
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ apiVersion: 1, profiles }))
      .mockResolvedValueOnce(response({ apiVersion: 2, profiles }))
      .mockResolvedValueOnce(response({ apiVersion: 2, profiles, executionModes: ['slurm_sbatch_v1'] }))
      .mockResolvedValueOnce(response({ apiVersion: 2, profiles, executionModes: 'slurm_sbatch_v1' })));
    expect(supportsSlurmExecution(await fetchGenerationCapabilities('https://ce.example'))).toBe(false);
    expect(supportsSlurmExecution(await fetchGenerationCapabilities('https://ce.example'))).toBe(false);
    expect(supportsSlurmExecution(await fetchGenerationCapabilities('https://ce.example'))).toBe(true);
    expect(supportsSlurmExecution({ apiVersion: 1, profiles, executionModes: ['slurm_sbatch_v1'] })).toBe(false);
    await expect(fetchGenerationCapabilities('https://ce.example')).rejects.toThrow('执行模式');
  });

  it('never posts old or incomplete requests as direct inference', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const legacy = { ...request, apiVersion: 1 as const }; delete legacy.execution;
    await expect(submitGenerationJob('https://ce.example', legacy)).rejects.toThrow('历史 v1');
    const incomplete = { ...request }; delete incomplete.execution;
    await expect(submitGenerationJob('https://ce.example', incomplete)).rejects.toThrow('Slurm');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('submits the exact snapshot with an idempotency key and leaves the input untouched', async () => {
    const fetch = vi.fn().mockImplementation(async () => response(job)); vi.stubGlobal('fetch', fetch);
    const before = structuredClone(request);
    const received = await submitGenerationJob('https://ce.example/api', request);
    expect(received.progress).toBe(.4);
    expect(fetch.mock.calls[0][1].headers['Idempotency-Key']).toBe(request.requestId);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(before);
    expect(JSON.parse(fetch.mock.calls[0][1].body).execution.scriptContent).toContain('exec "$@"');
    expect(JSON.parse(fetch.mock.calls[0][1].body).execution.argv.slice(0, 3)).toEqual(['sbatch', 'job.gpu', 'ENVNAME=base']);
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
