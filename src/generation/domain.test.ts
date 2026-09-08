import { describe, expect, it } from 'vitest';
import { buildGenerationRequest, createGenerationState, createProjectProfile, getModelProfiles, importModelProfile, inspectProjectProfile, rebuildCommand, renameProjectProfile, selectModel, selectProjectProfile, updateCommand, updateField, validateGenerationState, validateModelProfile } from './domain';
import { BUILTIN_MODEL_PROFILES } from './profiles';
import type { GenerationState, ModelProfile } from './types';

const custom = (): ModelProfile => ({
  id: 'test-model', version: 1, name: '另一模型', model: 'Test', description: '测试 argv 模板', inputRequirements: ['CE input'], commandPrefix: ['python3', 'other script.py'],
  parameters: [
    { key: 'prompt', flag: '--prompt', label: '提示词', type: 'string', defaultValue: '默认提示', required: true },
    { key: 'path', flag: '--path', label: '输入', type: 'path', defaultValue: 'inputs/a.png' },
    { key: 'empty', flag: '--empty', label: '空文字', type: 'string', defaultValue: '' },
    { key: 'seed', flag: '--seed', label: '种子', type: 'integer', defaultValue: '42' },
    { key: 'scale', flag: '--scale', label: '强度', type: 'number', defaultValue: '1.5', min: -2, max: 5 },
    { key: 'mode', flag: '--mode', label: '模式', type: 'enum', defaultValue: 'fast', choices: ['fast', 'precise'] },
    { key: 'flag', flag: '--flag', label: '开关', type: 'boolean', defaultValue: 'false' },
    { key: 'paired', flag: '--paired', falseFlag: '--no-paired', label: '成对开关', type: 'boolean', defaultValue: 'true' },
    { key: 'size', flag: '--size', label: '尺寸', type: 'list', defaultValue: '["480","832"]', nargs: 2 },
    { key: 'names', flag: '--names', label: '名称', type: 'list', defaultValue: '["默认"]', nargs: '+' },
  ],
});
const current = (state: GenerationState) => state.activeProfileIds[state.selectedModelId];
const withCustom = () => importModelProfile(createGenerationState(), custom());
const inspection = (state: GenerationState) => inspectProjectProfile(state, current(state));
const request = (state: GenerationState, requestId = 'request-1') => buildGenerationRequest(state, current(state), { id: 'project-1', name: '项目甲' }, requestId);

describe('model profile definitions and isolated run configurations', () => {
  it('validates the pinned built-in profile and builds its actual argument names', () => {
    for (const model of BUILTIN_MODEL_PROFILES) expect(validateModelProfile(model)).toEqual(model);
    const state = createGenerationState(), result = inspection(state);
    expect(result.canExecute).toBe(true);
    expect(result.argv.slice(0, 2)).toEqual(['python3', 'infer.py']);
    expect(result.argv).toContain('--validation_csv_path');
    expect(result.argv).not.toContain('--prompt');
    expect(result.parameters?.num_frames).toBe(81);
    expect(result.parameters?.normalize_object_to_first_frame).toBe(true);
  });

  it('blocks omitted required flags even when their schema defaults are nonempty', () => {
    let state = createGenerationState();
    state = updateCommand(state, current(state), 'python3 infer.py');
    expect(inspection(state).commandParseable).toBe(true);
    expect(inspection(state).canExecute).toBe(false);
    expect(inspection(state).issues.map(issue => issue.field)).toContain('pretrained_model_path');
    expect(inspection(state).draft!.values.pretrained_model_path).toBe(BUILTIN_MODEL_PROFILES[0].parameters[0].defaultValue);
    expect(() => request(state)).toThrow('必须显式提供');
    state = rebuildCommand(state, current(state));
    expect(inspection(state).canExecute).toBe(true);
    const command = inspection(state).draft!.commandText.replace(/ --config_path \S+/, '');
    state = updateCommand(state, current(state), command);
    expect(inspection(state).issues).toEqual([{ field: 'config_path', message: '必需参数 --config_path 必须显式提供' }]);
  });

  it('restores a model’s last selected run without sharing fields or breaking source state', () => {
    const initial = createGenerationState(), builtinId = initial.selectedModelId, firstRun = current(initial);
    let state = updateField(initial, firstRun, 'seed', '123');
    state = createProjectProfile(state, '第二配置', firstRun);
    const copiedRun = current(state);
    state = updateField(state, copiedRun, 'seed', '999');
    state = renameProjectProfile(state, copiedRun, '高速运行');
    state = importModelProfile(state, JSON.stringify(custom()));
    expect(state.selectedModelId).toBe('test-model');
    expect(getModelProfiles(state)).toHaveLength(BUILTIN_MODEL_PROFILES.length + 1);
    expect(inspection(state).parameters?.seed).toBe(42);
    state = selectModel(state, builtinId);
    expect(current(state)).toBe(copiedRun);
    expect(inspection(state).parameters?.seed).toBe(999);
    state = selectProjectProfile(state, firstRun);
    expect(inspection(state).parameters?.seed).toBe(123);
    expect(inspection(initial).parameters?.seed).toBe(42);
    expect(() => createProjectProfile(state, '高速运行')).toThrow('名称不能重复');
    expect(() => importModelProfile(state, custom())).toThrow('ID 已存在');
  });

  it.each([
    ['duplicate key', (model: ModelProfile) => { model.parameters[1].key = 'prompt'; }],
    ['duplicate false flag', (model: ModelProfile) => { model.parameters[7].falseFlag = '--prompt'; }],
    ['invalid enum default', (model: ModelProfile) => { model.parameters[5].defaultValue = 'other'; }],
    ['bad numeric default', (model: ModelProfile) => { model.parameters[4].defaultValue = '999'; }],
    ['invalid list length', (model: ModelProfile) => { model.parameters[8].defaultValue = '["1"]'; }],
    ['missing false flag', (model: ModelProfile) => { delete model.parameters[7].falseFlag; }],
    ['unsupported property', (model: ModelProfile) => { Object.assign(model, { shell: true }); }],
  ])('rejects unusable custom schema: %s', (_name, change) => {
    const model = custom(); change(model);
    expect(() => validateModelProfile(model)).toThrow();
  });
});

describe('single argv command and form synchronization', () => {
  it('round trips Chinese text, spaces, quotes, literal shell text, negatives, booleans, and lists', () => {
    let state = withCustom();
    const expected = `中文 O'Brien "quoted" $HOME; | # [x] \\ literal`;
    for (const [key, value] of Object.entries({ prompt: expected, path: '/CE folder/a=b.png', seed: '-9', scale: '-1.25', flag: 'true', paired: 'false', size: '["640","480"]', names: '["对象 A","球体","a=b"]' })) state = updateField(state, current(state), key, value);
    const command = inspection(state).draft!.commandText;
    state = updateCommand(state, current(state), command);
    const result = inspection(state);
    expect(result.issues).toEqual([]);
    expect(result.parameters).toMatchObject({ prompt: expected, path: '/CE folder/a=b.png', seed: -9, scale: -1.25, flag: true, paired: false, size: ['640', '480'], names: ['对象 A', '球体', 'a=b'] });
    expect(result.argv).toContain('--no-paired');
    expect(result.draft!.values.names).toBe('["对象 A","球体","a=b"]');
    expect(request(state).argv).toEqual(result.argv);
  });

  it('parses equals, empty strings, backslash escapes and line continuation and restores omitted defaults', () => {
    let state = withCustom();
    state = updateField(state, current(state), 'seed', '500');
    state = updateField(state, current(state), 'mode', 'precise');
    const command = `python3 'other script.py' --prompt="字 词" --path a\\ b --empty '' \\\n --scale -1e-1 --names='a=b' 'second name' --size -3 4 --no-paired`;
    state = updateCommand(state, current(state), command);
    expect(inspection(state).issues).toEqual([]);
    expect(inspection(state).parameters).toMatchObject({ prompt: '字 词', path: 'a b', empty: '', scale: -0.1, seed: 42, mode: 'fast', names: ['a=b', 'second name'], size: ['-3', '4'], paired: false });
    expect(inspection(state).draft!.values.seed).toBe('42');
    state = updateCommand(state, current(state), `python3 'other script.py' --prompt='--literal-value'`);
    expect(inspection(state).canExecute).toBe(true);
    expect(inspection(state).parameters?.prompt).toBe('--literal-value');
  });

  it.each([
    `python3 'other script.py' --prompt 'unfinished`,
    `python3 'other script.py' --unknown 2`,
    `python3 'other script.py' --seed 1 --seed 2`,
    `python3 'other script.py' --paired --no-paired`,
    `python3 'other script.py' --path`,
    `python3 'other script.py' --size 1`,
    `python3 wrong.py --seed 1`,
    `python3 'other script.py' --flag=true`,
    `python3 'other script.py'; touch /tmp/x`,
    `python3 'other script.py' | echo x`,
    `python3 'other script.py' --prompt "$HOME"`,
    'python3 \'other script.py\' --prompt `whoami`',
    `python3 'other script.py' --prompt a # ignored`,
    `python3 'other script.py' --path *.png`,
    `python3 'other script.py'\necho 1`,
  ])('retains the command draft and previous fields but blocks structural error: %s', command => {
    let state = withCustom();
    state = updateField(state, current(state), 'seed', '123');
    const before = inspection(state).draft!.values;
    state = updateCommand(state, current(state), command);
    expect(inspection(state)).toMatchObject({ commandParseable: false, canExecute: false });
    expect(inspection(state).draft!.commandText).toBe(command);
    expect(inspection(state).draft!.values).toEqual(before);
    expect(() => request(state)).toThrow();
    state = rebuildCommand(state, current(state));
    expect(inspection(state).canExecute).toBe(true);
    expect(inspection(state).parameters?.seed).toBe(123);
  });

  it('requires integer literals accepted by argparse while retaining invalid edits', () => {
    let state = createGenerationState();
    for (const invalid of ['81.0', '8.1e1', '0x51']) {
      state = updateField(state, current(state), 'num_frames', invalid);
      expect(inspection(state).draft!.values.num_frames).toBe(invalid);
      expect(inspection(state).canExecute).toBe(false);
      state = updateCommand(state, current(state), inspection(state).draft!.commandText);
      expect(inspection(state).commandParseable).toBe(true);
      expect(inspection(state).canExecute).toBe(false);
      expect(() => request(state)).toThrow('十进制整数字面量');
    }
    state = updateField(state, current(state), 'num_frames', '+81');
    expect(inspection(state).parameters?.num_frames).toBe(81);
    expect(inspection(state).canExecute).toBe(true);
    state = updateField(state, current(state), 'guidance_scale', '5e-1');
    expect(inspection(state).parameters?.guidance_scale).toBe(0.5);
  });

  it('keeps cleared optional string/path fields equal to argv instead of restoring nonempty defaults', () => {
    const model = custom();
    model.parameters[0].required = false;
    let state = importModelProfile(createGenerationState(), model);
    for (const key of ['prompt', 'path']) state = updateField(state, current(state), key, '');
    const result = inspection(state);
    expect(result.canExecute).toBe(true);
    expect(result.parameters).toMatchObject({ prompt: '', path: '' });
    expect(result.argv[result.argv.indexOf('--prompt') + 1]).toBe('');
    expect(result.argv[result.argv.indexOf('--path') + 1]).toBe('');
    state = updateCommand(state, current(state), result.draft!.commandText);
    expect(inspection(state).draft!.values).toMatchObject({ prompt: '', path: '' });
    const saved = validateGenerationState(JSON.parse(JSON.stringify(state)));
    expect(request(saved).parameters).toMatchObject({ prompt: '', path: '' });
    const removed = updateCommand(saved, current(saved), "python3 'other script.py'");
    expect(inspection(removed).parameters).toMatchObject({ prompt: '默认提示', path: 'inputs/a.png' });
  });

  it('only omits an empty optional numeric field when its model default is empty', () => {
    let state = createGenerationState();
    state = updateField(state, current(state), 'seed', '');
    expect(inspection(state).canExecute).toBe(false);
    expect(() => request(state)).toThrow('不能为空');
    state = updateField(state, current(state), 'seed', '42');
    state = updateField(state, current(state), 'max_samples', '');
    expect(inspection(state).canExecute).toBe(true);
    expect(inspection(state).argv).not.toContain('--max_samples');
    expect(request(state).parameters).not.toHaveProperty('max_samples');
    let listDraft = withCustom();
    listDraft = updateField(listDraft, current(listDraft), 'names', '');
    expect(inspection(listDraft).canExecute).toBe(false);
    expect(inspection(listDraft).draft!.values.names).toBe('');
    expect(() => request(listDraft)).toThrow('不能为空');
  });

  it('updates fields for typed errors and never submits an old valid form command', () => {
    let state = withCustom();
    state = updateCommand(state, current(state), `python3 'other script.py' --prompt default --seed nope --scale 99 --mode wrong`);
    expect(inspection(state).commandParseable).toBe(true);
    expect(inspection(state).canExecute).toBe(false);
    expect(inspection(state).draft!.values).toMatchObject({ seed: 'nope', scale: '99', mode: 'wrong' });
    expect(inspection(state).issues.map(issue => issue.field)).toEqual(['seed', 'scale', 'mode']);
    state = updateCommand(state, current(state), `python3 'other script.py' --prompt default --seed -4 --scale 2 --mode precise`);
    expect(inspection(state).canExecute).toBe(true);
    const oldCommand = inspection(state).draft!.commandText;
    state = updateField(state, current(state), 'seed', '-');
    expect(inspection(state).draft!.values.seed).toBe('-');
    expect(inspection(state).draft!.commandText).not.toBe(oldCommand);
    expect(inspection(state).canExecute).toBe(false);
    expect(() => request(state)).toThrow();
    state = updateField(state, current(state), 'seed', '');
    expect(inspection(state).draft!.values.seed).toBe('');
    // Clearing a numeric field with a nonempty default is an incomplete draft.
    expect(inspection(state).canExecute).toBe(false);
    expect(inspection(state).issues).toContainEqual(expect.objectContaining({ field: 'seed', message: expect.stringContaining('不能为空') }));
    state = updateField(state, current(state), 'names', '["unfinished');
    expect(inspection(state).canExecute).toBe(false);
    expect(inspection(state).draft!.values.names).toBe('["unfinished');
  });
});

describe('draft persistence and immutable submission snapshots', () => {
  it('keeps incomplete command and form input exactly through JSON persistence', () => {
    let state = withCustom();
    state = updateField(state, current(state), 'seed', '-');
    state = updateCommand(state, current(state), `python3 'other script.py' --prompt 'unfinished`);
    const restored = validateGenerationState(JSON.parse(JSON.stringify(state)));
    expect(restored).toEqual(state);
    expect(inspection(restored).canExecute).toBe(false);
    expect(inspection(restored).draft!.values.seed).toBe('-');
    expect(inspectProjectProfile(restored, 'missing').canExecute).toBe(false);
    const wrong = structuredClone(state);
    wrong.projectProfiles.find(profile => profile.id === current(state))!.modelProfileVersion = 99;
    const future = validateGenerationState(wrong);
    expect(inspection(future).model).toBeUndefined();
    expect(inspection(future).issues[0].message).toContain('v99 不可用');
    future.customProfiles = [];
    expect(validateGenerationState(future).projectProfiles).toEqual(future.projectProfiles);
  });

  it('rejects malicious maps, malformed structure and stale form command while keeping historical snapshots', () => {
    const state = withCustom();
    const polluted = JSON.parse(JSON.stringify(state));
    polluted.projectProfiles[0].values = JSON.parse('{"__proto__":"bad"}');
    expect(() => validateGenerationState(polluted)).toThrow('属性名称');
    const badIndex = structuredClone(state); badIndex.activeProfileIds['test-model'] = 'nonexistent';
    expect(() => validateGenerationState(badIndex)).toThrow('索引');
    const duplicate = structuredClone(state); duplicate.projectProfiles.push(duplicate.projectProfiles[0]);
    expect(() => validateGenerationState(duplicate)).toThrow('不能重复');
    const stale = structuredClone(state), profile = stale.projectProfiles.find(item => item.id === current(stale))!;
    profile.values.seed = '123'; profile.editSource = 'form';
    expect(inspection(validateGenerationState(stale)).canExecute).toBe(false);
    expect(inspection(stale).issues[0].message).toContain('参数与命令不一致');
    profile.editSource = 'command';
    expect(inspection(validateGenerationState(stale)).canExecute).toBe(false);
    const corrected = updateCommand(stale, profile.id, profile.commandText);
    expect(inspection(corrected).canExecute).toBe(true);
    expect(inspection(corrected).draft!.values.seed).toBe('42');
  });

  it('round trips explicit HTTP rejection records and rejects job/rejection conflicts or ambiguous status', () => {
    const state = withCustom(), snapshot = request(state);
    for (const status of [400, 422] as const) {
      const stored = { ...state, submissions: [{ endpoint: 'https://ce.example/api', request: snapshot, rejection: { status, message: '条件包不完整' } }] };
      expect(validateGenerationState(JSON.parse(JSON.stringify(stored)))).toEqual(stored);
      const conflicting = { ...stored, submissions: [{ ...stored.submissions[0], job: { id: 'job1', requestId: snapshot.requestId, status: 'queued', message: '', outputs: [] } }] };
      expect(() => validateGenerationState(conflicting)).toThrow('互斥');
      expect(() => validateGenerationState({ ...stored, submissions: [{ ...stored.submissions[0], rejection: { status: 500, message: 'uncertain' } }] })).toThrow('400 或 422');
      expect(() => validateGenerationState({ ...stored, submissions: [{ ...stored.submissions[0], rejection: { status, message: '' } }] })).toThrow('拒绝原因');
    }
  });

  it('preserves a submitted request independently of edits and validates job/endpoint associations', () => {
    let state = withCustom();
    const snapshot = request(state);
    state = { ...state, submissions: [{ endpoint: 'https://ce.example/api', request: snapshot, job: { id: 'job/opaque:1', requestId: snapshot.requestId, status: 'running', progress: 0.5, message: '', outputs: [{ name: '视频', url: '/outputs/video.mp4' }] } }] };
    state = updateField(state, current(state), 'seed', '200');
    expect(snapshot.parameters.seed).toBe(42);
    expect(request(state, 'request-2').parameters.seed).toBe(200);
    const restored = validateGenerationState(JSON.parse(JSON.stringify(state)));
    expect(restored.submissions[0].request).toEqual(snapshot);
    restored.submissions[0].request.argv.push('--mutated');
    expect(snapshot.argv).not.toContain('--mutated');
    for (const change of [
      (broken: GenerationState) => { broken.submissions[0].endpoint = 'https://user:secret@ce.example/api'; },
      (broken: GenerationState) => { broken.submissions[0].endpoint = 'https://ce.example/api?token=secret'; },
      (broken: GenerationState) => { broken.submissions[0].job!.requestId = 'another'; },
      (broken: GenerationState) => { broken.submissions[0].job!.outputs[0].url = 'javascript:alert(1)'; },
      (broken: GenerationState) => { broken.submissions[0].job!.outputs[0].url = '//elsewhere/output'; },
      (broken: GenerationState) => { broken.submissions[0].job!.progress = 2; },
      (broken: GenerationState) => { broken.submissions[0].request.argv.push('other'); },
      (broken: GenerationState) => { broken.submissions[0].request.parameters.seed = 100; },
    ]) {
      const broken = structuredClone(state); change(broken);
      expect(() => validateGenerationState(broken)).toThrow();
    }
  });
});
