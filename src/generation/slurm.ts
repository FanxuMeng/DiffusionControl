import type { GenerationIssue, GenerationRequest, ProjectGenerationProfile, SlurmExecutionConfig, SlurmRequestExecution } from './types';

export const MAX_SLURM_SCRIPT_BYTES = 256 * 1024;
const MAX_DRAFT_TEXT_LENGTH = 1024 * 1024;
export const DEFAULT_SLURM_SCRIPT = `#!/bin/bash

#SBATCH --export=NONE
#SBATCH -J gpu               # Job name
#SBATCH -o out.gpu           # Standard output
#SBATCH -N 1
#SBATCH --ntasks-per-node=1
#SBATCH --cpus-per-task=16
#SBATCH -t 7-00:00:00        # 7 days
#SBATCH -p youlab-gpu
#SBATCH -G 2

set -euo pipefail
source /home/225015066/miniconda3/etc/profile.d/conda.sh

ENVNAME="base"
if [[ "\${1:-}" == ENVNAME=* ]]; then
    ENVNAME="\${1#ENVNAME=}"
    shift
fi

conda activate "$ENVNAME"

exec "$@"
`;

export function createSlurmExecution(): SlurmExecutionConfig {
  return { kind: 'slurm_sbatch', version: 1, envName: 'base', scriptName: 'job.gpu', scriptContent: DEFAULT_SLURM_SCRIPT };
}
export function getSlurmExecution(profile: Pick<ProjectGenerationProfile, 'execution'>): SlurmExecutionConfig {
  return profile.execution ? { ...profile.execution } : createSlurmExecution();
}
export function normalizeSlurmScript(text: string): string { return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n'); }

/** Persistence checks shape only. Invalid editor contents remain recoverable drafts. */
export function validateSlurmExecutionDraft(raw: unknown): SlurmExecutionConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) throw new Error('execution 必须是 JSON 对象');
  const source = raw as Record<string, unknown>;
  if (Object.keys(source).some(key => !['kind', 'version', 'envName', 'scriptName', 'scriptContent'].includes(key))) throw new Error('execution 含不支持的属性');
  if (source.kind !== 'slurm_sbatch' || source.version !== 1) throw new Error('不支持的 Slurm execution 类型或版本');
  for (const key of ['envName', 'scriptName', 'scriptContent'] as const) {
    if (typeof source[key] !== 'string' || source[key].length > MAX_DRAFT_TEXT_LENGTH) throw new Error(`execution.${key} 必须是长度不超过 1 Mi 字符的字符串`);
  }
  return { kind: 'slurm_sbatch', version: 1, envName: source.envName as string, scriptName: source.scriptName as string, scriptContent: source.scriptContent as string };
}

export function inspectSlurmExecution(execution: SlurmExecutionConfig): GenerationIssue[] {
  const issues: GenerationIssue[] = [];
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(execution.envName)) issues.push({ field: 'execution.envName', message: 'ENVNAME 应为 1–128 字符的 Conda 环境名，只含字母、数字、点、下划线或短横线，且不以点或短横线开头' });
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,254}$/.test(execution.scriptName)) issues.push({ field: 'execution.scriptName', message: '脚本名称应为安全的单个文件名（1–255 字符），不含目录、空白或命令选项前缀' });
  const script = execution.scriptContent;
  if (!script.trim()) issues.push({ field: 'execution.scriptContent', message: 'Bash 脚本不能为空' });
  else {
    if (script.includes('\0')) issues.push({ field: 'execution.scriptContent', message: 'Bash 脚本不能包含 NUL 字符' });
    if (new TextEncoder().encode(script).length > MAX_SLURM_SCRIPT_BYTES) issues.push({ field: 'execution.scriptContent', message: 'Bash 脚本不能超过 256 KiB' });
    const firstLine = script.split('\n', 1)[0];
    const bashShebang = /^#![ \t]*(?:\/(?:[A-Za-z0-9._-]+\/)*bash(?:[ \t]+-[A-Za-z]+)?|\/usr\/bin\/env[ \t]+bash|\/usr\/bin\/env[ \t]+-S[ \t]+bash(?:[ \t]+-[A-Za-z]+)?)[ \t]*$/;
    if (!bashShebang.test(firstLine)) issues.push({ field: 'execution.scriptContent', message: '脚本首行需要 Bash shebang，例如 #!/bin/bash 或 #!/usr/bin/env bash' });
  }
  return issues;
}

export function isSlurmRequest(request: GenerationRequest): request is GenerationRequest & { apiVersion: 2; execution: SlurmRequestExecution } {
  return request.apiVersion === 2 && request.execution?.kind === 'slurm_sbatch' && request.execution.version === 1;
}
