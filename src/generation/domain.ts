import { BUILTIN_MODEL_PROFILES } from './profiles';
import { createSlurmExecution, getSlurmExecution, inspectSlurmExecution, validateSlurmExecutionDraft } from './slurm';
export { createSlurmExecution, getSlurmExecution } from './slurm';
import type { GenerationInspection, GenerationIssue, GenerationJob, GenerationParameter, GenerationParameters, GenerationRequest, GenerationState, GenerationValues, ModelProfile, ProjectGenerationProfile, SlurmExecutionConfig } from './types';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const parameterTypes = new Set(['string', 'path', 'integer', 'number', 'boolean', 'enum', 'list']);
const MAX_TEXT = 262144;
const own = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function fail(message: string): never { throw new Error(message); }
function record(raw: unknown, label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail(`${label} 必须是 JSON 对象`);
  const result = raw as Record<string, unknown>;
  if (Object.keys(result).some(key => forbiddenKeys.has(key))) fail(`${label} 含不支持的属性名称`);
  return result;
}
function text(raw: unknown, label: string, empty = false, max = MAX_TEXT): string {
  if (typeof raw !== 'string' || raw.length > max || raw.includes('\0') || (!empty && !raw.trim())) fail(`${label} 必须是${empty ? '' : '非空'}字符串（最长 ${max} 字符）`);
  return raw as string;
}
function identifier(raw: unknown, label: string): string {
  const value = text(raw, label, false, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value) || forbiddenKeys.has(value)) fail(`${label} 格式不合法`);
  return value;
}
function positiveInteger(raw: unknown, label: string): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 1) fail(`${label} 必须是正整数`);
  return raw as number;
}
function array(raw: unknown, label: string, max = 1000): unknown[] {
  if (!Array.isArray(raw) || raw.length > max) fail(`${label} 必须是数组（最多 ${max} 项）`);
  return raw as unknown[];
}
function stringArray(raw: unknown, label: string, max = 1000): string[] {
  return array(raw, label, max).map(value => text(value, label, true));
}
function allowedKeys(value: Record<string, unknown>, keys: string[], label: string) {
  const extra = Object.keys(value).find(key => !keys.includes(key));
  if (extra) fail(`${label} 含不支持的属性 ${extra}`);
}
function unique(values: string[], label: string) {
  if (new Set(values).size !== values.length) fail(`${label} 不能重复`);
}
function id() { return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
function profileModel(state: GenerationState, profile: ProjectGenerationProfile): ModelProfile | undefined {
  return getModelProfiles(state).find(model => model.id === profile.modelProfileId && model.version === profile.modelProfileVersion);
}
function requireProfile(state: GenerationState, profileId: string): ProjectGenerationProfile {
  return state.projectProfiles.find(profile => profile.id === profileId) ?? fail('项目运行配置不存在');
}
function requireModel(state: GenerationState, modelId: string): ModelProfile {
  return getModelProfiles(state).find(model => model.id === modelId) ?? fail('模型 profile 不可用');
}
function defaults(model: ModelProfile): GenerationValues {
  return Object.fromEntries(model.parameters.map(parameter => [parameter.key, parameter.defaultValue]));
}

/** Single-process POSIX argv lexer. It never invokes a shell or expands text. */
function tokenize(command: string): string[] {
  text(command, '命令', true);
  const tokens: string[] = [];
  let token = '', started = false, quote: "'" | '"' | null = null;
  const flush = () => { if (started) tokens.push(token); token = ''; started = false; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (quote === "'") {
      if (char === "'") quote = null; else token += char;
      continue;
    }
    if (char === '\\') {
      const next = command[++index];
      if (next === undefined) fail('命令末尾反斜线缺少转义字符');
      if (next === '\n') continue;
      if (next === '\r' && command[index + 1] === '\n') { index++; continue; }
      if (quote === '"' && !['$', '`', '"', '\\'].includes(next)) token += '\\';
      token += next; started = true; continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === '$' || char === '`') fail('不支持变量或命令替换；普通文本请使用单引号或转义');
      else token += char;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (char === '\n' || char === '\r') fail('仅支持单条命令；换行请使用反斜线续行');
    if (/\s/.test(char)) { flush(); continue; }
    if ('|&;<>()$`#*?[]{}~'.includes(char)) fail(`不支持未加引号的 shell 操作或展开：${char}`);
    token += char; started = true;
  }
  if (quote) fail('命令引号未闭合');
  flush();
  if (tokens.length > 4096) fail('命令参数过多');
  return tokens;
}
function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:@%+,=-]+$/.test(value) ? value : `'${value.replace(/'/g, `'"'"'`)}'`;
}
function readValue(parameter: GenerationParameter, raw: string): { value?: string | number | boolean | string[]; issue?: string } {
  const label = parameter.label;
  if (parameter.required && !raw.trim()) return { issue: `${label} 为必填项` };
  if (raw === '' && !parameter.required && parameter.type !== 'string' && parameter.type !== 'path') {
    if (parameter.defaultValue !== '') return { issue: `${label} 不能为空，请输入有效值或恢复模型默认值` };
    return {};
  }
  if (parameter.type === 'string' || parameter.type === 'path') return { value: raw };
  if (parameter.type === 'boolean') return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { issue: `${label} 应为 true 或 false` };
  if (parameter.type === 'enum') return parameter.choices?.includes(raw) ? { value: raw } : { issue: `${label} 应为指定枚举值` };
  if (parameter.type === 'list') {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return { issue: `${label} 应为 JSON 字符串数组` }; }
    if (!Array.isArray(parsed) || parsed.length > 1000 || parsed.some(value => typeof value !== 'string' || value.includes('\0'))) return { issue: `${label} 应为 JSON 字符串数组` };
    if ((typeof parameter.nargs === 'number' && parsed.length !== parameter.nargs) || (parameter.nargs === '+' && parsed.length === 0)) return { issue: `${label} 需要 ${parameter.nargs === '+' ? '至少 1' : parameter.nargs} 项` };
    return { value: parsed as string[] };
  }
  const numeric = raw.trim();
  const literal = parameter.type === 'integer' ? /^[+-]?\d+$/ : /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;
  if (!numeric || !literal.test(numeric)) return { issue: `${label} 应为${parameter.type === 'integer' ? '十进制整数字面量' : '数字'}` };
  const value = Number(numeric);
  if (!Number.isFinite(value) || (parameter.type === 'integer' && !Number.isSafeInteger(value))) return { issue: `${label} 应为有限${parameter.type === 'integer' ? '安全整数' : '数字'}` };
  if ((parameter.min !== undefined && value < parameter.min) || (parameter.max !== undefined && value > parameter.max)) return { issue: `${label} 超出允许范围 ${parameter.min ?? '−∞'}–${parameter.max ?? '+∞'}` };
  return { value };
}
function valuesInspection(model: ModelProfile, values: GenerationValues) {
  const parameters: GenerationParameters = {}, issues: GenerationIssue[] = [];
  for (const parameter of model.parameters) {
    const raw = values[parameter.key] ?? parameter.defaultValue;
    const result = readValue(parameter, raw);
    if (result.issue) issues.push({ field: parameter.key, message: result.issue });
    if (result.value !== undefined) parameters[parameter.key] = result.value;
  }
  for (const key of Object.keys(values)) if (!model.parameters.some(parameter => parameter.key === key)) issues.push({ field: key, message: `模型不支持字段 ${key}` });
  return { parameters, issues };
}
function canonicalCommand(model: ModelProfile, values: GenerationValues): string {
  const argv = [...model.commandPrefix];
  for (const parameter of model.parameters) {
    const raw = values[parameter.key] ?? parameter.defaultValue;
    if (parameter.type === 'boolean') {
      if (raw === 'true') argv.push(parameter.flag);
      else if (raw === 'false') { if (parameter.falseFlag) argv.push(parameter.falseFlag); }
      else if (raw !== '') argv.push(`${parameter.flag}=${raw}`);
      continue;
    }
    if (raw === '' && !parameter.required && parameter.type !== 'string' && parameter.type !== 'path') continue;
    if (parameter.type === 'list') {
      const result = readValue(parameter, raw);
      argv.push(parameter.flag, ...(Array.isArray(result.value) ? result.value : [raw]));
    } else if (/^-/.test(raw)) argv.push(`${parameter.flag}=${raw}`);
    else argv.push(parameter.flag, raw);
  }
  return argv.map(quoteArg).join(' ');
}
function parseCommand(model: ModelProfile, command: string): { argv: string[]; values: GenerationValues; issues: GenerationIssue[] } {
  const argv = tokenize(command);
  if (argv.length < model.commandPrefix.length || model.commandPrefix.some((token, index) => token !== argv[index])) fail(`命令入口必须为 ${model.commandPrefix.map(quoteArg).join(' ')}`);
  const flagMap = new Map<string, { parameter: GenerationParameter; truth: boolean }>();
  for (const parameter of model.parameters) {
    flagMap.set(parameter.flag, { parameter, truth: true });
    if (parameter.falseFlag) flagMap.set(parameter.falseFlag, { parameter, truth: false });
  }
  const values = defaults(model), seen = new Set<string>();
  const looksFlag = (token: string) => /^--?[A-Za-z_]/.test(token) || token === '--';
  for (let index = model.commandPrefix.length; index < argv.length; index++) {
    const token = argv[index], equal = token.indexOf('=');
    const flag = equal < 0 ? token : token.slice(0, equal);
    const entry = flagMap.get(flag);
    if (!entry) fail(`未知参数或多余位置参数：${flag}`);
    const { parameter, truth } = entry;
    if (seen.has(parameter.key)) fail(`参数 ${parameter.flag} 重复出现（含正／反开关）`);
    seen.add(parameter.key);
    if (parameter.type === 'boolean') {
      if (equal >= 0) fail(`布尔参数 ${flag} 不接受附加值`);
      values[parameter.key] = String(truth); continue;
    }
    const parts: string[] = equal < 0 ? [] : [token.slice(equal + 1)];
    const count = parameter.type === 'list' ? parameter.nargs : 1;
    if (count === '+') {
      while (index + 1 < argv.length && !looksFlag(argv[index + 1])) parts.push(argv[++index]);
    } else {
      while (parts.length < (count ?? 1) && index + 1 < argv.length && !looksFlag(argv[index + 1])) parts.push(argv[++index]);
    }
    if (!parts.length || (count !== '+' && parts.length !== (count ?? 1))) fail(`参数 ${flag} 缺少${count === '+' ? '至少 1 个' : count ?? 1}值`);
    values[parameter.key] = parameter.type === 'list' ? JSON.stringify(parts) : parts[0];
  }
  return { argv, values, issues: model.parameters.filter(parameter => parameter.required && !seen.has(parameter.key)).map(parameter => ({ field: parameter.key, message: `必需参数 ${parameter.flag} 必须显式提供` })) };
}

export function validateModelProfile(raw: unknown): ModelProfile {
  const value = record(typeof raw === 'string' ? JSON.parse(raw) : raw, '模型 profile');
  allowedKeys(value, ['id', 'version', 'name', 'model', 'commandPrefix', 'parameters', 'description', 'inputRequirements', 'source'], '模型 profile');
  const model: ModelProfile = {
    id: identifier(value.id, '模型 ID'), version: positiveInteger(value.version, '模型版本'),
    name: text(value.name, '模型名称', false, 200), model: text(value.model, 'model', false, 200),
    commandPrefix: stringArray(value.commandPrefix, '命令入口', 50), parameters: [],
    description: text(value.description ?? '', '模型说明', true), inputRequirements: stringArray(value.inputRequirements ?? [], '输入要求', 100),
  };
  if (!model.commandPrefix.length || model.commandPrefix.some(token => !token.trim())) fail('命令入口不能为空');
  // Prefix tokens are arguments too; quote/reparse ensures imported literals remain literal.
  if (tokenize(model.commandPrefix.map(quoteArg).join(' ')).join('\0') !== model.commandPrefix.join('\0')) fail('命令入口不合法');
  model.parameters = array(value.parameters, '参数 schema', 200).map(rawParameter => {
    const source = record(rawParameter, '参数定义');
    allowedKeys(source, ['key', 'flag', 'label', 'type', 'defaultValue', 'required', 'min', 'max', 'choices', 'falseFlag', 'nargs', 'description'], '参数定义');
    const key = identifier(source.key, '参数 key');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail('参数 key 仅支持字母、数字与下划线');
    const flag = text(source.flag, '参数 flag', false, 128);
    if (!/^--?[A-Za-z][A-Za-z0-9_-]*$/.test(flag)) fail(`参数 ${key} 的 flag 不合法`);
    if (!parameterTypes.has(source.type as string)) fail(`参数 ${key} 类型不支持`);
    const parameter: GenerationParameter = { key, flag, label: text(source.label, '参数名称', false, 200), type: source.type as GenerationParameter['type'], defaultValue: text(source.defaultValue, '默认值', true) };
    if (source.required !== undefined) { if (typeof source.required !== 'boolean') fail('required 必须是布尔值'); parameter.required = source.required; }
    if (source.description !== undefined) parameter.description = text(source.description, '参数说明', true);
    for (const bound of ['min', 'max'] as const) if (source[bound] !== undefined) {
      if (!['number', 'integer'].includes(parameter.type) || typeof source[bound] !== 'number' || !Number.isFinite(source[bound])) fail(`${bound} 仅支持有限数值型参数范围`);
      parameter[bound] = source[bound];
    }
    if (parameter.min !== undefined && parameter.max !== undefined && parameter.min > parameter.max) fail('参数范围 min 不能大于 max');
    if (parameter.type === 'enum') {
      parameter.choices = stringArray(source.choices, '枚举 choices', 200);
      if (!parameter.choices.length) fail('枚举 choices 不能为空');
      unique(parameter.choices, '枚举选项');
    } else if (source.choices !== undefined) fail('只有 enum 可提供 choices');
    if (source.falseFlag !== undefined) {
      if (parameter.type !== 'boolean' || typeof source.falseFlag !== 'string' || !/^--?[A-Za-z][A-Za-z0-9_-]*$/.test(source.falseFlag)) fail('falseFlag 仅支持布尔参数的合法旗标');
      parameter.falseFlag = source.falseFlag;
    }
    if (parameter.type === 'list') {
      if (source.nargs !== '+' && (!Number.isSafeInteger(source.nargs) || (source.nargs as number) < 1 || (source.nargs as number) > 1000)) fail('列表 nargs 必须为 1–1000 的整数或 +');
      parameter.nargs = source.nargs as number | '+';
    } else if (source.nargs !== undefined) fail('只有 list 可提供 nargs');
    if (parameter.type === 'boolean' && !['true', 'false'].includes(parameter.defaultValue)) fail('布尔默认值必须为 true 或 false');
    if (parameter.type === 'boolean' && (parameter.defaultValue === 'true' || parameter.required) && !parameter.falseFlag) fail('默认为 true 或必需的布尔参数必须提供 falseFlag');
    if (parameter.defaultValue !== '') {
      const issue = readValue(parameter, parameter.defaultValue).issue;
      if (issue) fail(`默认值无效：${issue}`);
    }
    return parameter;
  });
  unique(model.parameters.map(parameter => parameter.key), '参数 key');
  unique(model.parameters.flatMap(parameter => [parameter.flag, ...(parameter.falseFlag ? [parameter.falseFlag] : [])]), '参数 flag');
  if (value.source !== undefined) {
    const source = record(value.source, '源码来源');
    model.source = { url: absoluteUrl(source.url, '源码 URL'), revision: text(source.revision, '源码版本', false, 200) };
  }
  return model;
}

export function getModelProfiles(state: GenerationState): ModelProfile[] { return [...BUILTIN_MODEL_PROFILES, ...state.customProfiles]; }
export function isSymphoMotion(modelId: string): boolean {
  return modelId === 'symphomotion-single-gpu' || modelId === 'symphomotion-multi-gpu';
}
export function repairLegacyEnvironments(state: GenerationState): GenerationState {
  let changed = false;
  const projectProfiles = state.projectProfiles.map(profile => {
    if (!isSymphoMotion(profile.modelProfileId) || getSlurmExecution(profile).envName !== 'base') return profile;
    changed = true;
    return { ...profile, execution: { ...getSlurmExecution(profile), envName: 'symphomotion' } };
  });
  return changed ? { ...state, projectProfiles } : state;
}
export function createGenerationState(): GenerationState {
  const first = BUILTIN_MODEL_PROFILES[0] ?? fail('没有可用的内置模型 profile');
  return createProjectProfile({ version: 1, selectedModelId: first.id, activeProfileIds: {}, projectProfiles: [], customProfiles: [], submissions: [] }, '默认运行');
}
export function selectModel(state: GenerationState, modelId: string): GenerationState {
  const known = getModelProfiles(state).some(model => model.id === modelId);
  if (!known && !state.projectProfiles.some(profile => profile.modelProfileId === modelId)) fail('模型 profile 不存在');
  const next = { ...state, selectedModelId: modelId };
  const last = state.projectProfiles.find(profile => profile.id === state.activeProfileIds[modelId] && profile.modelProfileId === modelId);
  if (last) return next;
  const first = state.projectProfiles.find(profile => profile.modelProfileId === modelId);
  if (first) return { ...next, activeProfileIds: { ...state.activeProfileIds, [modelId]: first.id } };
  return createProjectProfile(next, '默认运行');
}
export function selectProjectProfile(state: GenerationState, profileId: string): GenerationState {
  const profile = requireProfile(state, profileId);
  return { ...state, selectedModelId: profile.modelProfileId, activeProfileIds: { ...state.activeProfileIds, [profile.modelProfileId]: profile.id } };
}
export function createProjectProfile(state: GenerationState, name: string, copyFromId?: string): GenerationState {
  const label = text(name.trim(), '运行配置名称', false, 200);
  const source = copyFromId ? requireProfile(state, copyFromId) : undefined;
  const model = source ? profileModel(state, source) : requireModel(state, state.selectedModelId);
  const modelId = source?.modelProfileId ?? model!.id;
  if (state.projectProfiles.some(profile => profile.modelProfileId === modelId && profile.name === label)) fail('同一模型的运行配置名称不能重复');
  if (state.projectProfiles.length >= 100) fail('最多支持 100 个项目运行配置');
  const values = source ? { ...source.values } : defaults(model!);
  const profile: ProjectGenerationProfile = { id: id(), name: label, modelProfileId: modelId, modelProfileVersion: source?.modelProfileVersion ?? model!.version, values, commandText: source?.commandText ?? canonicalCommand(model!, values), editSource: source?.editSource ?? 'form', execution: source ? getSlurmExecution(source) : { ...createSlurmExecution(), ...(isSymphoMotion(modelId) ? { envName: 'symphomotion' } : {}) }, useGlobalExecution: source?.useGlobalExecution ?? true };
  return { ...state, selectedModelId: modelId, activeProfileIds: { ...state.activeProfileIds, [modelId]: profile.id }, projectProfiles: [...state.projectProfiles, profile] };
}
export function renameProjectProfile(state: GenerationState, profileId: string, name: string): GenerationState {
  const profile = requireProfile(state, profileId), label = text(name.trim(), '运行配置名称', false, 200);
  if (state.projectProfiles.some(other => other.id !== profileId && other.modelProfileId === profile.modelProfileId && other.name === label)) fail('同一模型的运行配置名称不能重复');
  return replaceProfile(state, { ...profile, name: label });
}
function replaceProfile(state: GenerationState, next: ProjectGenerationProfile): GenerationState {
  return { ...state, projectProfiles: state.projectProfiles.map(profile => profile.id === next.id ? next : profile) };
}
export function updateExecution(state: GenerationState, profileId: string, patch: Partial<Pick<SlurmExecutionConfig, 'envName' | 'scriptName' | 'scriptContent'>>): GenerationState {
  const profile = requireProfile(state, profileId);
  const execution = validateSlurmExecutionDraft({ ...getSlurmExecution(profile), ...patch });
  return replaceProfile(state, { ...profile, execution });
}
export function updateField(state: GenerationState, profileId: string, key: string, value: string): GenerationState {
  const profile = requireProfile(state, profileId), model = profileModel(state, profile) ?? fail('当前模型版本不可用，无法修改参数');
  if (!model.parameters.some(parameter => parameter.key === key)) fail(`未知参数字段：${key}`);
  text(value, '参数输入', true);
  const values = { ...profile.values, [key]: value };
  return replaceProfile(state, { ...profile, values, commandText: canonicalCommand(model, values), editSource: 'form' });
}
export function updateCommand(state: GenerationState, profileId: string, commandText: string): GenerationState {
  const profile = requireProfile(state, profileId), model = profileModel(state, profile);
  text(commandText, '命令', true);
  let values = profile.values;
  if (model) { try { values = parseCommand(model, commandText).values; } catch { /* Preserve the latest parsed form while editing incomplete syntax. */ } }
  return replaceProfile(state, { ...profile, commandText, values, editSource: 'command' });
}
export function rebuildCommand(state: GenerationState, profileId: string): GenerationState {
  const profile = requireProfile(state, profileId), model = profileModel(state, profile) ?? fail('当前模型版本不可用，无法重建命令');
  return replaceProfile(state, { ...profile, commandText: canonicalCommand(model, profile.values), editSource: 'form' });
}
export function importModelProfile(state: GenerationState, raw: unknown): GenerationState {
  const model = validateModelProfile(raw);
  if (getModelProfiles(state).some(existing => existing.id === model.id)) fail('模型 profile ID 已存在，不能覆盖');
  if (state.customProfiles.length >= 50) fail('最多支持 50 个自定义模型 profile');
  return selectModel({ ...state, customProfiles: [...state.customProfiles, model] }, model.id);
}
export function inspectProjectProfile(state: GenerationState, profileId: string): GenerationInspection {
  const draft = state.projectProfiles.find(profile => profile.id === profileId);
  const result: GenerationInspection = { draft, issues: [], argv: [], parameters: null, submissionArgv: [], submissionCommand: '', commandParseable: false, canExecute: false };
  if (!draft) { result.issues.push({ message: '项目运行配置不存在' }); return result; }
  const execution = getSlurmExecution(draft);
  result.issues.push(...inspectSlurmExecution(execution));
  const model = profileModel(state, draft);
  if (!model) { result.issues.push({ message: `模型 ${draft.modelProfileId} v${draft.modelProfileVersion} 不可用；已保留草稿` }); return result; }
  result.model = model;
  if (draft.editSource === 'form') result.issues.push(...valuesInspection(model, draft.values).issues);
  try {
    const parsed = parseCommand(model, draft.commandText);
    result.commandParseable = true; result.argv = parsed.argv; result.issues.push(...parsed.issues);
    result.submissionArgv = ['sbatch', execution.scriptName, `ENVNAME=${execution.envName}`, ...parsed.argv];
    result.submissionCommand = result.submissionArgv.map(quoteArg).join(' ');
    const inspected = valuesInspection(model, parsed.values);
    for (const issue of inspected.issues) if (!result.issues.some(existing => existing.field === issue.field && existing.message === issue.message)) result.issues.push(issue);
    result.parameters = inspected.parameters;
    // Persisted form drafts cannot submit an old valid command after fields were modified.
    if (draft.editSource === 'form' && canonicalCommand(model, draft.values) !== draft.commandText) result.issues.push({ message: '参数与命令不一致，请从参数重建命令' });
    if (draft.editSource === 'command' && (model.parameters.some(parameter => (draft.values[parameter.key] ?? parameter.defaultValue) !== parsed.values[parameter.key]) || Object.keys(draft.values).some(key => !model.parameters.some(parameter => parameter.key === key)))) result.issues.push({ message: '保存的参数草稿与命令不一致，请重新编辑命令以同步或从参数重建命令' });
  } catch (error) { result.issues.push({ message: error instanceof Error ? error.message : '命令无法解析' }); }
  result.canExecute = result.commandParseable && result.issues.length === 0;
  return result;
}
export function buildGenerationRequest(state: GenerationState, profileId: string, project: { id: string; name: string }, requestId: string = id()): GenerationRequest {
  const inspected = inspectProjectProfile(state, profileId);
  if (!inspected.canExecute || !inspected.model || !inspected.draft || !inspected.parameters) fail(inspected.issues.map(issue => issue.message).join('；') || '配置尚不可执行');
  return clone({ apiVersion: 2, execution: { ...getSlurmExecution(inspected.draft), argv: inspected.submissionArgv, command: inspected.submissionCommand }, requestId: identifier(requestId, '请求 ID'), createdAt: new Date().toISOString(), projectId: identifier(project.id, '项目 ID'), projectName: text(project.name, '项目名称', false, 200), projectProfileId: profileId, profileId: inspected.model.id, profileVersion: inspected.model.version, parameters: inspected.parameters, argv: inspected.argv, command: inspected.draft.commandText });
}

function absoluteUrl(raw: unknown, label: string, endpoint = false): string {
  const value = text(raw, label, false, 8192);
  if (/[\u0000-\u0020\\]/.test(value)) fail(`${label} 含不支持的空白或反斜线`);
  let url: URL; try { url = new URL(value); } catch { return fail(`${label} 必须是 HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (endpoint && (url.hash || url.search))) fail(`${label} 必须是无凭据的 HTTP(S) URL（CE 根地址不含查询或片段）`);
  return value;
}
function outputUrl(raw: unknown): string {
  const value = text(raw, '输出 URL', false, 8192);
  if (value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !/[\r\n]/.test(value)) return value;
  return absoluteUrl(value, '输出 URL');
}
function validateRequest(raw: unknown, models: ModelProfile[]): GenerationRequest {
  const source = record(raw, '提交请求');
  if (source.apiVersion !== 1 && source.apiVersion !== 2) fail('不支持的请求版本');
  const parameters = record(source.parameters, '请求 parameters'), validated: GenerationParameters = {};
  if (Object.keys(parameters).length > 200) fail('请求参数过多');
  for (const [key, value] of Object.entries(parameters)) {
    identifier(key, '参数 key');
    if (typeof value === 'string') validated[key] = text(value, '参数值', true);
    else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) validated[key] = value;
    else if (Array.isArray(value)) validated[key] = stringArray(value, '列表参数');
    else fail('请求参数仅支持字符串、有限数值、布尔值或字符串数组');
  }
  const createdAt = text(source.createdAt, '请求创建时间', false, 100);
  if (!/^\d{4}-\d\d-\d\dT/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) fail('请求创建时间不是有效的 ISO 日期');
  const argv = stringArray(source.argv, '请求 argv', 4096), command = text(source.command, '请求 command');
  if (!argv.length || JSON.stringify(tokenize(command)) !== JSON.stringify(argv)) fail('请求 command 与 argv 不一致');
  const request: GenerationRequest = { apiVersion: source.apiVersion, requestId: identifier(source.requestId, '请求 ID'), createdAt, projectId: identifier(source.projectId, '项目 ID'), projectName: text(source.projectName, '项目名称', false, 200), projectProfileId: identifier(source.projectProfileId, '运行配置 ID'), profileId: identifier(source.profileId, '模型 ID'), profileVersion: positiveInteger(source.profileVersion, '模型版本'), parameters: validated, argv, command };
  if (source.apiVersion === 2) {
    const executionSource = record(source.execution, '请求 execution');
    allowedKeys(executionSource, ['kind', 'version', 'envName', 'scriptName', 'scriptContent', 'argv', 'command'], '请求 execution');
    const config = validateSlurmExecutionDraft({ kind: executionSource.kind, version: executionSource.version, envName: executionSource.envName, scriptName: executionSource.scriptName, scriptContent: executionSource.scriptContent });
    const issues = inspectSlurmExecution(config);
    if (issues.length) fail(issues.map(issue => issue.message).join('；'));
    const submissionArgv = stringArray(executionSource.argv, '请求 execution.argv', 4100);
    const submissionCommand = text(executionSource.command, '请求 execution.command');
    const expectedArgv = ['sbatch', config.scriptName, `ENVNAME=${config.envName}`, ...argv];
    if (JSON.stringify(submissionArgv) !== JSON.stringify(expectedArgv) || JSON.stringify(tokenize(submissionCommand)) !== JSON.stringify(expectedArgv)) fail('Slurm 提交包装与推理 argv 不一致');
    request.execution = { ...config, argv: submissionArgv, command: submissionCommand };
  } else if (source.execution !== undefined) fail('历史 v1 请求不支持 execution，不可静默改写');
  const model = models.find(item => item.id === request.profileId && item.version === request.profileVersion);
  if (model) {
    const parsed = parseCommand(model, command), inspected = valuesInspection(model, parsed.values);
    const sorted = (parameters: GenerationParameters) => JSON.stringify(Object.keys(parameters).sort().map(key => [key, parameters[key]]));
    if (parsed.issues.length || inspected.issues.length || sorted(inspected.parameters) !== sorted(validated)) fail('提交快照的参数与模型或命令不一致');
  }
  return request;
}
function validateJob(raw: unknown, requestId: string): GenerationJob {
  const source = record(raw, '作业');
  if (!['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(source.status as string)) fail('作业状态不支持');
  if (source.requestId !== requestId) fail('作业 requestId 与提交请求不一致');
  const jobId = text(source.id, '作业 ID', false, 200);
  if (/[\u0000-\u001f]/.test(jobId)) fail('作业 ID 不能含控制字符');
  const job: GenerationJob = { id: jobId, requestId, status: source.status as GenerationJob['status'], message: text(source.message, '作业消息', true), outputs: array(source.outputs, '作业输出', 100).map(rawOutput => {
    const output = record(rawOutput, '输出'); return { name: text(output.name, '输出名称', true, 200), url: outputUrl(output.url) };
  }) };
  if (source.progress !== undefined) {
    if (typeof source.progress !== 'number' || !Number.isFinite(source.progress) || source.progress < 0 || source.progress > 1) fail('作业进度应为 0–1');
    job.progress = source.progress;
  }
  if (source.cancelRequested !== undefined) {
    if (typeof source.cancelRequested !== 'boolean') fail('取消意图应为布尔值');
    job.cancelRequested = source.cancelRequested;
  }
  return job;
}
export function validateGenerationState(raw: unknown): GenerationState {
  const source = record(raw, 'generation');
  if (source.version !== 1) fail('不支持的 generation 版本');
  const customProfiles = array(source.customProfiles, '自定义模型 profiles', 50).map(validateModelProfile);
  unique([...BUILTIN_MODEL_PROFILES, ...customProfiles].map(model => model.id), '模型 profile ID');
  const projectProfiles = array(source.projectProfiles, '项目运行 profiles', 100).map(rawProfile => {
    const profile = record(rawProfile, '项目运行 profile'), rawValues = record(profile.values, '参数草稿');
    if (Object.keys(rawValues).length > 200) fail('参数草稿过多');
    const values: GenerationValues = {};
    for (const [key, value] of Object.entries(rawValues)) values[identifier(key, '参数 key')] = text(value, '参数草稿值', true);
    if (profile.editSource !== 'form' && profile.editSource !== 'command') fail('editSource 必须为 form 或 command');
    if (profile.useGlobalExecution !== undefined && typeof profile.useGlobalExecution !== 'boolean') fail('useGlobalExecution 必须为布尔值');
    return { id: identifier(profile.id, '运行配置 ID'), name: text(profile.name, '运行配置名称', false, 200), modelProfileId: identifier(profile.modelProfileId, '模型 ID'), modelProfileVersion: positiveInteger(profile.modelProfileVersion, '模型版本'), values, commandText: text(profile.commandText, '命令草稿', true), editSource: profile.editSource, execution: profile.execution === undefined ? createSlurmExecution() : validateSlurmExecutionDraft(profile.execution), ...(profile.useGlobalExecution !== undefined ? { useGlobalExecution: profile.useGlobalExecution } : {}) } satisfies ProjectGenerationProfile;
  });
  unique(projectProfiles.map(profile => profile.id), '运行配置 ID');
  unique(projectProfiles.map(profile => `${profile.modelProfileId}\0${profile.name}`), '同模型的运行配置名称');
  const selectedModelId = identifier(source.selectedModelId, '当前模型 ID'), activeProfileIds: Record<string, string> = {};
  const active = record(source.activeProfileIds, '当前运行配置索引');
  if (Object.keys(active).length > 200) fail('运行配置索引过多');
  for (const [modelId, profileId] of Object.entries(active)) {
    const model = identifier(modelId, '模型 ID'), profile = identifier(profileId, '运行配置 ID');
    if (!projectProfiles.some(item => item.id === profile && item.modelProfileId === model)) fail('运行配置索引与所属模型不匹配');
    activeProfileIds[model] = profile;
  }
  if (!own(activeProfileIds, selectedModelId)) fail('当前模型缺少已选运行配置');
  const submissions = array(source.submissions, '提交记录', 50).map(rawSubmission => {
    const submission = record(rawSubmission, '提交记录'), request = validateRequest(submission.request, [...BUILTIN_MODEL_PROFILES, ...customProfiles]);
    if (submission.job !== undefined && submission.rejection !== undefined) fail('提交记录中的 job 与 rejection 互斥');
    let rejection: { status: 400 | 422; message: string } | undefined;
    if (submission.rejection !== undefined) {
      const rawRejection = record(submission.rejection, '拒绝记录');
      allowedKeys(rawRejection, ['status', 'message'], '拒绝记录');
      if (rawRejection.status !== 400 && rawRejection.status !== 422) fail('明确拒绝记录只支持 HTTP 400 或 422');
      rejection = { status: rawRejection.status, message: text(rawRejection.message, '拒绝原因', false, 4096) };
    }
    return { endpoint: absoluteUrl(submission.endpoint, 'CE 地址', true), request, ...(submission.job === undefined ? {} : { job: validateJob(submission.job, request.requestId) }), ...(rejection ? { rejection } : {}) };
  });
  unique(submissions.map(submission => submission.request.requestId), '提交请求 ID');
  return { version: 1, selectedModelId, activeProfileIds, projectProfiles, customProfiles, submissions };
}
