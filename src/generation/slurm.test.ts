import { describe, expect, it } from 'vitest';
import { createDemoProjects, migratePrototypeWorkspace } from '../model';
import { buildGenerationRequest, createGenerationState, createProjectProfile, importModelProfile, inspectProjectProfile, selectModel, selectProjectProfile, updateCommand, updateExecution, updateField, validateGenerationState } from './domain';
import { createSlurmExecution, DEFAULT_SLURM_SCRIPT, getSlurmExecution, inspectSlurmExecution, isSlurmRequest, MAX_SLURM_SCRIPT_BYTES, normalizeSlurmScript } from './slurm';
import type { GenerationRequest, GenerationState, SlurmExecutionConfig } from './types';

const active = (state: GenerationState) => state.activeProfileIds[state.selectedModelId];
const inspect = (state: GenerationState) => inspectProjectProfile(state, active(state));
const request = (state: GenerationState, requestId = 'slurm-request') => buildGenerationRequest(state, active(state), { id: 'project1', name: 'Slurm project' }, requestId);
const stored = (state: GenerationState, snapshot: GenerationRequest) => ({ ...state, submissions: [{ endpoint: 'https://ce.example/api', request: snapshot }] });

describe('Slurm execution configuration and immutable wrappers', () => {
  it('retains the supplied resource settings and forwards ENVNAME before exact inference argv', () => {
    const config = createSlurmExecution();
    expect(config).toMatchObject({ kind: 'slurm_sbatch', version: 1, envName: 'base', scriptName: 'job.gpu' });
    for (const directive of ['--export=NONE', '-N 1', '--ntasks-per-node=1', '--cpus-per-task=16', '-t 7-00:00:00', '-p youlab-gpu', '-G 2']) expect(config.scriptContent).toContain(`#SBATCH ${directive}`);
    expect(config.scriptContent).toContain('ENVNAME="${1#ENVNAME=}"\n    shift');
    expect(config.scriptContent).toContain('conda activate "$ENVNAME"');
    expect(config.scriptContent).toContain('exec "$@"');
    expect(inspectSlurmExecution(config)).toEqual([]);
    const state = createGenerationState(), result = inspect(state), built = request(state);
    expect(built.apiVersion).toBe(2);
    expect(isSlurmRequest(built)).toBe(true);
    expect(result.submissionArgv).toEqual(['sbatch', 'job.gpu', 'ENVNAME=base', ...result.argv]);
    expect(built.execution).toEqual({ ...config, argv: result.submissionArgv, command: result.submissionCommand });
    expect(built.parameters).not.toHaveProperty('ENVNAME');
    expect(built.parameters).not.toHaveProperty('envName');
  });

  it('normalizes imported UTF-8 BOM/line endings without interpreting Bash', () => {
    const original = '\uFEFF#!/bin/bash\r\n#SBATCH -p custom\r\n\r\nexec "$@"\r\n';
    const normalized = normalizeSlurmScript(original);
    expect(normalized).toBe('#!/bin/bash\n#SBATCH -p custom\n\nexec "$@"\n');
    expect(original).toContain('\r\n');
    expect(normalizeSlurmScript(normalized)).toBe(normalized);
    expect(inspectSlurmExecution({ ...createSlurmExecution(), scriptContent: '#!/usr/bin/env -S bash -eu\nexec "$@"\n' })).toEqual([]);
    // This is intentionally only a basic format check, not a Bash/Slurm interpreter.
    expect(inspectSlurmExecution({ ...createSlurmExecution(), scriptContent: '#!/bin/bash\nif malformed bash goes here\n' })).toEqual([]);
  });

  it('keeps spaces, quote characters, literal shell text and empty strings inside separate inference arguments', () => {
    let state = createGenerationState();
    const prompt = `中文 O'Brien "quoted" $literal ; | #`;
    state = updateField(state, active(state), 'negative_prompt', prompt);
    state = updateField(state, active(state), 'output_dir', '/CE outputs/run A');
    state = updateField(state, active(state), 'seed', '-9');
    state = updateExecution(state, active(state), { envName: 'wan_2.1', scriptName: 'inference.gpu' });
    const built = request(state);
    expect(built.execution!.argv.slice(0, 3)).toEqual(['sbatch', 'inference.gpu', 'ENVNAME=wan_2.1']);
    expect(built.execution!.argv.slice(3)).toEqual(built.argv);
    expect(built.argv).toContain(prompt);
    expect(built.argv).toContain('/CE outputs/run A');
    expect(validateGenerationState(JSON.parse(JSON.stringify(stored(state, built)))).submissions[0].request).toEqual(built);
    state = updateField(state, active(state), 'negative_prompt', '');
    const empty = request(state, 'empty-prompt');
    expect(empty.execution!.argv[empty.execution!.argv.indexOf('--negative_prompt') + 1]).toBe('');
    expect(validateGenerationState(stored(state, empty)).submissions[0].request.execution).toEqual(empty.execution);
  });

  it('isolates script settings across named copies, model switches, and inference edits', () => {
    let state = createGenerationState();
    const originalId = active(state), modelId = state.selectedModelId, initial = state;
    const inner = inspect(state).draft!.commandText;
    state = updateExecution(state, originalId, { envName: 'wan', scriptName: 'custom.gpu', scriptContent: DEFAULT_SLURM_SCRIPT.replace('-G 2', '-G 1') });
    expect(inspect(state).draft!.commandText).toBe(inner);
    expect(inspect(initial).draft!.execution).toEqual(createSlurmExecution());
    state = createProjectProfile(state, 'Copied', originalId);
    const copiedId = active(state);
    expect(inspect(state).draft!.execution.envName).toBe('wan');
    state = updateExecution(state, copiedId, { envName: 'another' });
    state = updateCommand(state, copiedId, inspect(state).draft!.commandText.replace('--seed 42', '--seed 123'));
    expect(inspect(state).submissionArgv).toContain('ENVNAME=another');
    expect(inspect(state).parameters?.seed).toBe(123);
    state = importModelProfile(state, { id: 'another-model', version: 1, name: 'Another', model: 'Other', commandPrefix: ['python3', 'other.py'], parameters: [], description: '', inputRequirements: [] });
    expect(inspect(state).draft!.execution).toEqual(createSlurmExecution());
    state = selectModel(state, modelId);
    expect(active(state)).toBe(copiedId);
    expect(inspect(state).draft!.execution.envName).toBe('another');
    state = selectProjectProfile(state, originalId);
    expect(inspect(state).draft!.execution.envName).toBe('wan');
    const retrieved = getSlurmExecution(inspect(state).draft!); retrieved.envName = 'external-mutation';
    expect(inspect(state).draft!.execution.envName).toBe('wan');
  });

  it.each<[Partial<SlurmExecutionConfig>, string]>([
    [{ envName: '' }, 'execution.envName'],
    [{ envName: 'ENVNAME=base' }, 'execution.envName'],
    [{ envName: '/path/to/env' }, 'execution.envName'],
    [{ envName: 'two words' }, 'execution.envName'],
    [{ scriptName: '../job.gpu' }, 'execution.scriptName'],
    [{ scriptName: '--wrap' }, 'execution.scriptName'],
    [{ scriptName: 'folder\\job.gpu' }, 'execution.scriptName'],
    [{ scriptContent: '' }, 'execution.scriptContent'],
    [{ scriptContent: '#!/bin/bash\n\0' }, 'execution.scriptContent'],
    [{ scriptContent: '#!/bin/sh\nexec "$@"\n' }, 'execution.scriptContent'],
    [{ scriptContent: '#!/bin/bash\n#' + '界'.repeat(Math.ceil(MAX_SLURM_SCRIPT_BYTES / 3)) }, 'execution.scriptContent'],
  ])('retains invalid execution field drafts through persistence while blocking submission: %j', (patch, field) => {
    let state = createGenerationState();
    state = updateExecution(state, active(state), patch);
    const restored = validateGenerationState(JSON.parse(JSON.stringify(state)));
    expect(restored).toEqual(state);
    expect(inspect(restored).canExecute).toBe(false);
    expect(inspect(restored).issues).toContainEqual(expect.objectContaining({ field }));
    expect(() => request(restored)).toThrow();
  });

  it('measures script limit in UTF-8 bytes and permits the exact limit', () => {
    const prefix = '#!/bin/bash\n#';
    const config = { ...createSlurmExecution(), scriptContent: prefix + 'a'.repeat(MAX_SLURM_SCRIPT_BYTES - prefix.length) };
    expect(inspectSlurmExecution(config)).toEqual([]);
    config.scriptContent += 'a';
    expect(inspectSlurmExecution(config).some(issue => issue.message.includes('256 KiB'))).toBe(true);
  });

  it('upgrades missing per-run settings and leaves historical v1 request/job snapshots unchanged', () => {
    const state = createGenerationState(), modern = request(state);
    const { execution: _execution, ...withoutExecution } = modern;
    const historical: GenerationRequest = { ...withoutExecution, apiVersion: 1 };
    const legacy = JSON.parse(JSON.stringify({ ...stored(state, historical), submissions: [{ ...stored(state, historical).submissions[0], job: { id: 'old-job', requestId: historical.requestId, status: 'running', message: 'Retained', outputs: [] } }] }));
    for (const profile of legacy.projectProfiles) delete profile.execution;
    const before = JSON.stringify(legacy), restored = validateGenerationState(legacy);
    expect(restored.projectProfiles[0].execution).toEqual(createSlurmExecution());
    expect(restored.submissions).toEqual(legacy.submissions);
    expect(restored.submissions[0].request.apiVersion).toBe(1);
    expect(restored.submissions[0].request).not.toHaveProperty('execution');
    expect(isSlurmRequest(restored.submissions[0].request)).toBe(false);
    expect(request(restored, 'new-request').apiVersion).toBe(2);
    expect(JSON.stringify(legacy)).toBe(before);
  });

  it('persists separate current-script and submitted-script snapshots through workspace export/import', () => {
    const projects = createDemoProjects(), project = projects[0];
    project.generation = updateExecution(project.generation, active(project.generation), { envName: 'production', scriptContent: DEFAULT_SLURM_SCRIPT.replace('-p youlab-gpu', '-p archived-queue') });
    const submitted = buildGenerationRequest(project.generation, active(project.generation), project, 'original-request');
    project.generation = stored(project.generation, submitted);
    project.generation = updateExecution(project.generation, active(project.generation), { envName: 'experimental', scriptContent: '#!/bin/bash\n# new draft\nexec "$@"\n' });
    const restored = migratePrototypeWorkspace(JSON.parse(JSON.stringify({ format: 'diffusioncontrol.prototype.workspace', version: 2, projects })), 2);
    expect(restored.issues).toEqual([]);
    expect(restored.projects[0].generation).toEqual(project.generation);
    expect(restored.projects[1].generation).toEqual(projects[1].generation);
    expect(inspect(restored.projects[0].generation).draft!.execution.envName).toBe('experimental');
    expect(restored.projects[0].generation.submissions[0].request.execution?.envName).toBe('production');
    expect(restored.projects[0].generation.submissions[0].request.execution?.scriptContent).toContain('-p archived-queue');
    expect(submitted.execution?.envName).toBe('production');
  });

  it('rejects mismatched wrappers, invalid submitted scripts and incomplete v2 snapshots', () => {
    const state = createGenerationState();
    for (const change of [
      (snapshot: GenerationRequest) => { snapshot.execution!.envName = 'different'; },
      (snapshot: GenerationRequest) => { snapshot.execution!.argv[1] = 'other.gpu'; },
      (snapshot: GenerationRequest) => { snapshot.execution!.argv.push('--unexpected'); },
      (snapshot: GenerationRequest) => { snapshot.execution!.command += ' extra'; },
      (snapshot: GenerationRequest) => { snapshot.execution!.scriptContent = '#!/bin/sh\ntrue\n'; },
      (snapshot: GenerationRequest) => { snapshot.execution!.scriptContent = '#!/bin/bash\n\0'; },
      (snapshot: GenerationRequest) => { delete snapshot.execution; },
      (snapshot: GenerationRequest) => { snapshot.apiVersion = 1; },
    ]) {
      const snapshot = request(state); change(snapshot);
      expect(() => validateGenerationState(stored(state, snapshot))).toThrow();
    }
    const malformed = JSON.parse(JSON.stringify(state)); malformed.projectProfiles[0].execution.envName = 42;
    expect(() => validateGenerationState(malformed)).toThrow('字符串');
  });
});
