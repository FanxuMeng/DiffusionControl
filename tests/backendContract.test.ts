import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildGenerationRequest, createGenerationState, selectModel, updateField, validateGenerationState } from '../src/generation/domain';
import { BUILTIN_MODEL_PROFILES } from '../src/generation/profiles';
import { DEFAULT_SLURM_SCRIPT } from '../src/generation/slurm';
import { cancelGenerationJob, fetchGenerationLogs, isTerminalJob } from '../src/generation/api';

afterEach(() => vi.unstubAllGlobals());

describe('backend deployment contract', () => {
  it('keeps the server profile and deployment script identical to the frontend', () => {
    for (const profile of BUILTIN_MODEL_PROFILES) {
      expect(JSON.parse(readFileSync(resolve(`backend/profiles/${profile.id}.json`), 'utf8'))).toEqual(profile);
    }
    expect(readFileSync(resolve('docs/examples/job.gpu'), 'utf8')).toBe(DEFAULT_SLURM_SCRIPT);
    expect(DEFAULT_SLURM_SCRIPT).not.toContain('conda init');
    expect(DEFAULT_SLURM_SCRIPT).toContain('set -euo pipefail');
  });

  it('exports a real frontend request for Python contract validation', () => {
    let state = createGenerationState();
    const id = state.activeProfileIds[state.selectedModelId];
    state = updateField(state, id, 'negative_prompt', `中文 O'Brien $literal ; "quoted"`);
    state = updateField(state, id, 'seed', '-9');
    const request = buildGenerationRequest(state, id, { id: 'contract-project', name: 'contract' }, 'frontend-contract');
    mkdirSync(resolve('var'), { recursive: true });
    writeFileSync(resolve('var/frontend-contract-request.json'), JSON.stringify(request));
    expect(request.apiVersion).toBe(2);
    const sharded = selectModel(state, 'symphomotion-multi-gpu');
    const shardedRequest = buildGenerationRequest(sharded, sharded.activeProfileIds[sharded.selectedModelId], { id: 'contract-project', name: 'contract' }, 'frontend-contract-sharded');
    writeFileSync(resolve('var/frontend-contract-sharded-request.json'), JSON.stringify(shardedRequest));
  });

  it('preserves cancellation intent as a nonterminal, persisted state', async () => {
    const state = createGenerationState(), id = state.activeProfileIds[state.selectedModelId];
    const request = buildGenerationRequest(state, id, { id: 'project', name: 'project' });
    const job = { id: 'job1', requestId: request.requestId, status: 'running', cancelRequested: true, message: '等待取消', outputs: [] };
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify(job), { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const result = await cancelGenerationJob('http://127.0.0.1:8000/api', job.id, request.requestId);
    expect(fetch.mock.calls[0][0]).toBe('http://127.0.0.1:8000/api/inference/jobs/job1/cancel');
    expect(result.cancelRequested).toBe(true);
    expect(isTerminalJob(result)).toBe(false);
    expect(validateGenerationState({ ...state, submissions: [{ endpoint: 'http://127.0.0.1:8000/api', request, job }] }).submissions[0].job?.cancelRequested).toBe(true);
  });

  it('downloads bounded log tails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ 'stdout.log': { text: 'hello', truncated: true }, 'stderr.log': { text: '' } }))));
    expect(await fetchGenerationLogs('http://127.0.0.1:8000/api', 'job1')).toContain('hello');
  });
});
