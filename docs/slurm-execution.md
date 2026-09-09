# CE 登录节点与 Slurm 提交 v0.6

日期：2026-09-09。已按先文档、后代码的顺序完成 v0.6。用户已明确后端部署在 CE 集群登录节点，推理通过 `sbatch job.gpu ENVNAME=base <推理指令>` 提交至计算节点。本轮增加前端配置、脚本编辑与 API 契约，不表示已部署 CE 服务或提交实际 GPU 作业。

## 面板交互

生成面板保留模型参数与可编辑的“推理命令”，新增 Slurm 提交配置：

- `ENVNAME` 输入框，默认 `base`，填写 Conda 环境名，不包含 `ENVNAME=` 前缀；每份命名运行配置分别保存。
- 脚本文件名，默认 `job.gpu`，只允许文件名，不接受目录路径。
- 可折叠的 Bash 脚本预览／编辑区，提供脚本文件导入与下载。初始内容采用用户提供的 `#SBATCH` 资源配置与 ENVNAME 参数转发逻辑。导入更新文件名和全文，UTF-8 BOM 和 CRLF 换行规范化为 LF；编辑／导入不在浏览器执行 Bash。
- 单独显示完整 Slurm 提交命令。ENVNAME、脚本文件名或推理参数改变时自动更新；推理命令编辑仍反向同步模型参数。完整提交预览由各字段生成，修改模型参数应在推理命令或输入框完成。

可导入的默认模板见 [job.gpu](examples/job.gpu)，内容与前端初始模板一致；修改后的脚本可用“下载脚本”保存。

示例：

```bash
sbatch job.gpu ENVNAME=base python3 infer.py --seed 42
```

这是 argv 包装示例，并非包含全部 SymphoMotion 必需参数的可运行命令。`ENVNAME=base` 在脚本名之后，是脚本的第一个位置参数；脚本解析并 shift 后，用 `exec "$@"` 保留各推理参数边界。空格、引号等按既有命令序列化规则处理；ENVNAME 不进入模型参数 schema，也不作为 `--envname` 传给模型。

ENVNAME、脚本和文件名随项目／模型／命名配置切换恢复，复制配置时一并复制。无法执行的中间草稿可保存；空 ENVNAME、不合法文件名、空脚本、NUL 字符、过长脚本和不支持的 Bash shebang 阻止新提交及有效请求导出。脚本上限 256 KiB；浏览器只检查基础格式，不声称完成 Bash 语法或 Slurm 资源有效性检查。任意 Bash 逻辑不会反向解析成模型输入框，ENVNAME 显式实参优先于示例脚本的 `default_env` 回退。

脚本初始资源保持用户给定的 `youlab-gpu` 分区、2 GPU、16 CPU、1 节点和 `7-00:00:00` 时限；该时限表示 7 天，原注释中的 1.5 小时不适用。申请 2 GPU 不会自动将单进程 Python 改成多 GPU 推理；多进程启动方式由模型 profile 的入口决定。导入自定义脚本时应保留 ENVNAME 与剩余 argv 的转发约定。

## 登录节点与计算节点

浏览器将请求交给登录节点 HTTP API。后端校验模型及 Slurm 配置，为每个 requestId 保存不可变脚本和请求快照，从登录节点调用 `sbatch`；模型仅在分配到的计算节点运行。登录节点承担 API、文件暂存、调度提交及状态查询。

服务端为每个请求创建独立作业目录，将 `scriptContent` 写为 `scriptName`，不能覆盖公共 job.gpu。命令预览使用逻辑文件名；服务端以暂存脚本绝对路径替换该 argv，并可增加 `--parsable` 获取 Slurm job ID、`--chdir` 设置注册模型仓库工作目录。此目录不是浏览器项目路径或上传文件的本机路径。服务端保存实际提交 argv；脚本中的相对日志文件应按作业隔离处理，避免多个任务共用 `out.gpu`。

后端以 argv 调用 sbatch，不把推理命令通过 `bash -c` 或 eval 放在登录节点执行。自定义 Bash 脚本由 Slurm 在计算节点执行，须通过已认证的用户身份提交。服务器负责检查脚本 Bash 语法、环境是否存在、模型路径与权限、分区和配额，并确认脚本按所约定的参数转发。前端导入脚本不等于服务端已验证这些条件。

模板沿用用户的 `conda init bash ; source ~/.bashrc` 和 `conda activate`。实际部署时应将 Conda 初始化放在环境准备阶段，并在初始化／激活失败时停止作业，避免继续调用错误环境的 Python；本轮不静默替换用户的脚本逻辑。[Conda 官方初始化说明](https://docs.conda.io/projects/conda/en/latest/dev-guide/deep-dives/activation.html)

Slurm 的提交成功仅表示作业已被接收，不能映射为推理完成；`--parsable` 可能返回 `jobId;cluster`。`#SBATCH` 指令不进行 shell 变量展开，`--export=NONE` 也不表示完全没有用户环境；保留脚本原义，由 CE 服务记录实际提交与执行环境。[Slurm 官方 sbatch 文档](https://slurm.schedmd.com/sbatch.html)

## 同源连接与高级设置

用户已确认采用同源入口：页面与 API 使用同一协议、主机和端口，浏览器默认以 `/api` 为根地址。浏览器向 `/api/inference/capabilities` 查询能力、向 `/api/inference/jobs` 提交请求；入口将这些请求路由至 CE 登录节点 API，再由后端调用 sbatch。API 通信仍然必需，正常使用不需要手动填写服务地址。

生成面板默认展示当前后端地址与“连接并检查模型”按钮；地址输入框收进默认折叠的“高级连接设置”。仅在跨源或调试部署时覆盖地址。选择“恢复同源 /api”会保存 `/api`，清除当前连接与能力检查结果，需要重新连接。编辑地址同样取消进行中的能力查询并使旧连接失效，不自动提交推理。

地址优先级：浏览器保存的非空设置 → 非空公开构建配置 `VITE_CE_API_BASE_URL` → `/api`。旧版保存的空值按未设置处理；已有自定义地址继续保留。点击连接时保存输入的地址形式，`/api` 保持相对路径，不固化为当前主机。历史任务仍使用各自提交时保存的绝对 endpoint 查询与重试，切换连接设置不改写历史快照。

恢复同源会显式覆盖浏览器设置，即使构建配置使用其他地址也生效。连接失败或尚未连接时仍可编辑、校验与导出请求。本仓库目前只有前端客户端；默认 `/api` 不会创建 HTTP 后端或反向代理，开发服务器也不会自动获得 CE 连接。实际部署需配置同源入口与登录节点服务。

## API v2 与兼容性

新提交使用 `apiVersion:2`，并要求能力接口明确返回：

```json
{"apiVersion":2,"profiles":[{"id":"symphomotion-single-gpu","version":1}],"executionModes":["slurm_sbatch_v1"]}
```

缺少 v2 或 Slurm 能力时允许编辑和导出，禁止提交。这样旧 v1 服务不会忽略新增字段后在登录节点直接运行推理。

请求顶层 `parameters / argv / command` 继续表示推理进程；新增必需的 execution：

```json
{
  "kind":"slurm_sbatch",
  "version":1,
  "envName":"base",
  "scriptName":"job.gpu",
  "scriptContent":"完整 Bash 脚本原文",
  "argv":["sbatch","job.gpu","ENVNAME=base","python3","infer.py","--seed","42"],
  "command":"sbatch job.gpu ENVNAME=base python3 infer.py --seed 42"
}
```

提交时重新验证脚本和命令，execution 与模型 argv 必须一致；请求快照包含脚本全文，修改配置不影响已提交任务。HTTP 路径与 v1 一致，仍使用 `Idempotency-Key: requestId`；明确拒绝与结果不确定的处理、作业回显 ID 和输出链接规则沿用生成面板规格。重试必须复用原环境、原脚本、原命令与请求 ID，服务端也须以 requestId 对 Slurm 提交去重。

旧 generation v1 项目缺少 execution 时，为其运行配置补充默认 Slurm 设置；工作区封装版本保持 2，generation 扩展版本保持 1。历史 apiVersion 1 的请求／作业完整保留并可下载或查询，不改写成新请求，不能通过新版客户端直接重试提交。结果未确认的旧请求继续阻止同配置新提交；应先在原服务核实任务，再复制运行配置发起 Slurm 请求。新建请求一律使用 v2。模型 schema 与其固定源码版本无需因调度包装改版。

## 验收

1. ENVNAME 与脚本字段改变后，提交预览、导出的执行 argv 和请求脚本保持一致。
2. 编辑／导入脚本可保留自定义资源配置；折叠、切换项目或模型、复制配置、刷新和备份导入不丢失脚本。
3. 含空格的路径和带引号文本进入脚本后仍为独立参数；ENVNAME 不污染模型参数。
4. 空／错误草稿阻止提交；不具备 v2 Slurm 能力的 CE 服务不能触发推理 POST。
5. 旧项目能升级，历史请求保持原样，新请求脚本快照不可变，重试复用全部内容。
6. 运行相应测试和生产构建；不把前端测试声称为真实 CE 部署或 GPU 推理验证。

## 验证记录

2026-09-09 同源连接补充：先更新需求、交互与部署文档，再实现 `/api` 回退和高级设置。`npm test` **16 个文件、147 项测试通过**，`npm run build` 通过；仍有既有主包体积提示。新增测试覆盖旧空地址回退、浏览器／构建配置优先级、恢复同源及相对路径随当前 origin 解析。Chrome 在本地 5174 端口确认：初始高级设置折叠、显示 `/api`，展开后可编辑自定义地址，恢复后刷新保留 `/api` 并重新折叠。点击连接时，未配置后端的本地服务返回 HTTP 404，界面正确显示连接失败，未提交推理任务。

2026-09-09：`npm test` 的 **16 个文件、144 项测试通过**；新增 19 项 Slurm 配置／包装／迁移测试和 2 项 API 门禁测试，既有 123 项回归继续通过。`npm run build` 通过 TypeScript 与 Vite 生产构建，现有主包仍有超过 500 kB 的体积提示。`bash -n docs/examples/job.gpu` 语法检查通过；没有执行 Conda 初始化或 sbatch。

Chrome 实际交互检查使用本地 5174 端口的新建 `slurm-qa` 项目，未修改已有场景轨迹。已验证：

- 将 ENVNAME 改成 `symphomotion` 后，完整提交预览立即更新；清空环境名显示错误并禁用请求导出与执行。
- Bash 区域可展开，资源配置可由 `-G 2` 编辑为 `-G 1`；通过文件选择器导入 `job.gpu` 恢复文件名和模板全文。
- 文件名改为 `experiment.gpu` 后同步更新 sbatch 包装；复制成 `slurm-test` 运行配置时保留环境与脚本。
- 修改复制配置为 `test-env`、`-G 1` 后刷新，重新选择项目可恢复运行配置、环境名、文件名及脚本内容。
- 未连接 CE 时，实际下载 `slurm-qa_slurm-test_request.json` 成功；v2 请求包含执行配置和脚本全文的序列化由测试校验。

API v1／缺失 Slurm 能力时的禁止提交、不可变请求与脚本快照、argv 参数边界、历史任务保留及非法脚本草稿由单元／持久化测试覆盖。当前未提供 CE HTTP 服务地址，因此没有进行登录节点部署、真实 Slurm 提交、GPU 推理或远端作业状态联调。
