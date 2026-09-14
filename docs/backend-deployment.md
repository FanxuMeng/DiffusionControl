# 当前登录节点后端部署与运维

修订：2026-09-10。当前后端部署入口为 `celn01` 的 **`0.0.0.0:5192`**，沿用本轮开始时已运行服务的端口；`backend/config.local.json` 的默认端口仍为 8000，由启动参数覆盖。base Web 依赖、测试和前端构建已完成。已从节点验证 `10.27.130.15:5192` 的登录、页面、模型能力和项目交换 API；个人电脑到节点的路由仍需在用户浏览器中确认。模型权重及三个推理环境已齐；本机配置已启用 depth／sam2／associate／export，并通过真实 HTTP 调度、条件导出和双卡短生成。当前服务 PID 记录于 `var/backend.pid`；原生单卡仍因显存不足停用，见 [GPU 记录](gpu-validation.md) 与 [模块验收](workflow-module-validation.md)。

设计与接口见 [后端技术方案](backend-implementation.md) 和 [重建工作流](reconstruction-workflow.md)。第二阶段新增图像上传、Depth Pro、SAM2、点簇关联和条件导出，统一复用原作业协调器。本轮增加项目软删除、带版本的集群快照、本地／集群完整包交换，见 [项目管理](project-management.md)；多人自动协作同步仍不在当前实现内。

## 1. 环境与模型

| 用途 | 环境 | 当前处理 |
| --- | --- | --- |
| 登录节点 HTTP 服务 | `/home/225015066/miniconda3` 的 base，Python 3.8.12 | 已安装 `backend/requirements.txt` 的轻量 Web 依赖；没有升级 Python |
| 计算节点 SymphoMotion 推理 | 用户已有的 `symphomotion` | 按授权最小升级 Torch/cu128、匹配二进制组件及 sympy 1.13.3；其余包不变 |
| 计算节点 SAM2 | `sam2` | 用户自行安装，采用支持 RTX 5090 的 Torch/cu128 |
| 深度、关联、条件导出 | `depthpro` | 用户自行安装；动态渲染另需 CUDA 12.8 PyTorch3D 扩展 |

推理代码已从原 SymphoMotion 固定版本复制到项目内 `third_party/SymphoMotion`，原仓库未修改。基础权重为 `/home/225015066/PretrainedModels/Diffusers/Wan2.1-I2V-14B-720P-Diffusers`，附加权重位于 `/home/225015066/PretrainedModels/Symphomotion/pretrained_checkpoints`。Depth Pro、SAM2 权重路径及安装清单见 [模型环境](model-environments.md)。[配置样例](../backend/config.example.json) 已启用 `symphomotion-multi-gpu`；四类重建任务在样例中仍需部署者验证后显式启用，本机已通过验证并在 local 配置启用。

用户已确认环境名 `symphomotion`；prefix `/home/225015066/miniconda3/envs/symphomotion` 已在真实 Slurm 作业中核实。该环境的 CUDA 兼容升级已按授权完成。API 把任务 ENVNAME 解析为注册 prefix，作业脚本通过 Conda hook 执行 `conda activate "$ENVNAME"`，不自行安装依赖。

## 2. 安装与构建

以下命令均在项目目录中执行。用户明确批准仅安装 base Web 依赖后，本轮已成功执行安装和构建；现有部署无需重复安装。命令保留用于后续重建。

```bash
cd /home/225015066/dev-projects/DiffusionControl
mkdir -p var/tmp
TMPDIR="$PWD/var/tmp" PYTHONDONTWRITEBYTECODE=1 /home/225015066/miniconda3/bin/python -m pip install --no-user --no-cache-dir -r backend/requirements.txt
npm run build
```

`requirements.txt` 固定 FastAPI 0.124.4、Starlette 0.44.0、Pydantic 2.10.6、Uvicorn 0.33.0 和 HTTP 测试所用的 httpx 0.27.0，以兼容当前 Python 3.8。运行验证前不将这些旧 Python 兼容版本声称为最新版本。当前提供 JSON API，不接收 multipart；HTTP 层将 Range 限制为一个长度受限的字节区间。未来升级 Python 时需重新核对并升级这组依赖。

当前 Node 为 20.12.2；已安装的 Vite 7.3.6 提示需要 Node 20.19+ 或 22.12+，本次构建仍成功。没有擅自升级 base 的 Node；开发服务器兼容性需在满足 Vite 要求的 Node 环境中进一步验证。

如需本地配置，可先复制样例，再只编辑项目内配置：

```bash
cp backend/config.example.json backend/config.local.json
```

启动优先读取 `DIFFUSIONCONTROL_CONFIG` 指定的项目内 JSON；未设置时优先 `backend/config.local.json`，不存在则使用样例。配置文件、状态根和模型 profile 文件只能位于本项目内。`allowedReadRoots` 仅列已授权的本项目和 PretrainedModels 目录，不扫描其他目录。

## 3. 启动与个人电脑内网访问

前台启动，便于首先查看错误：

```bash
bash scripts/start-backend.sh --host 0.0.0.0 --port 5192
```

该脚本固定使用 base 的 Python，并禁止字节码写入。按用户提供的 Jupyter `--ip=0.0.0.0 --port=8014` 使用习惯，本服务采用相同的内网监听方式，目前使用 5192 端口。运行单个 Uvicorn 进程，禁用未经配置的代理身份头信任；当前服务以独立进程运行，PID 记录于 `var/backend.pid`。本轮未安装项目外的 systemd、Nginx 或开机自启配置。

个人电脑使用原来访问 Jupyter 的节点主机名或 IP，将端口改为 5192 并打开 `/login`。当前节点有以下候选地址，优先使用本机实际可达的集群内网网段：

| 地址 | 本轮检查 |
| --- | --- |
| `http://10.27.130.15:5192/login` | 已从登录节点通过 HTTP 检查 |
| `http://10.10.10.206:5192/login` | 候选地址；此前仅检查过该 IP 的 8000 入口 |
| `http://12.12.12.206:5192/login` | 已确认属于节点网卡，未单独访问验证 |
| `http://celn01:5192/login` | 适用于个人电脑能解析此节点名的网络 |

`0.0.0.0` 是服务器监听配置；个人电脑浏览器应使用上述节点地址或系统实际分配的入口。此部署不要求 SSH 端口转发。若集群展示了不同域名/外部端口，应将该域名加入 `backend/config.local.json` 的 `allowedHosts` 后重启；带 `/proxy/.../` 前缀的入口尚未配置，不能直接假定与根路径部署相同。VS Code Remote-SSH 可能为本端口自动建立隧道，它与本服务无关，关闭方法见 [停止服务与端口转发](#停止服务与端口转发)。

首次启动已在项目内生成 `var/access-token`，权限 0600，父目录权限 0700。在登录节点终端读取令牌，填入登录页面：

```bash
cat var/access-token
```

令牌不打印进启动日志、不放进 URL 或前端 localStorage。登录后使用 HttpOnly、SameSite=Strict、8 小时有效的 cookie；前端静态资源、作业查询和视频下载由同一入口提供。其他能够连接此端口的账户也需要令牌。更换令牌后重启会使原会话失效；停止服务不会取消已经提交的 Slurm 作业。

健康检查为 `GET /api/health`，无需令牌；其他 API 除登录外均需会话。`/api/inference/capabilities` 在模型未启用时返回空 profiles 和 `unavailableProfiles` 原因，HTTP 服务本身仍可正常运行。未知 API 路径返回 JSON 404，不返回前端 HTML。

开发模式可同时启动后端 8000 端口与 `npm run dev`；Vite 已将 `/api` 和 `/login` 代理至后端并保留 Host。在开发端口打开 `/login` 后返回前端。开发代理固定指向 8000，修改后端端口时应同步调整 `vite.config.ts`；生产入口无需 Vite。

### 停止服务与端口转发

两个脚本配合使用：

```bash
bash scripts/check-backend-status.sh    # 只读：报告运行状态、监听地址、HTTP 状态码
bash scripts/shutdown-backend.sh        # 关闭后端并清理端口转发，可传入等待秒数
```

`shutdown-backend.sh` 先向 `var/backend.pid` 中的进程发送 SIGTERM（超时后升级为 SIGKILL），校验 `/proc/<pid>/cmdline` 确为本后端后才终止，随后清理 PID 文件并调用 `scripts/close-port-forward.sh`。

关于端口转发：**关闭后端不会自动关闭端口转发**，因为 VS Code Remote-SSH 的端口转发由本地 VS Code 客户端发起并持有，远程服务器只负责维持隧道，并在后端退出后不断重试。远程日志 `~/.vscode-server/data/logs/<时间戳>/remoteagent.log` 中的 `Failed to connect tunnel to localhost:8000` 即该重试记录；远程进程树中不存在任何转发中继，因此服务器上的脚本无法终止它。

`scripts/close-port-forward.sh` 因此只做两件事：

1. 终止服务器上真实存在的转发中继进程（`ssh -L/-R/-D`、`autossh`、`plink`、`socat`）。当前部署未使用这些方式，通常为空。
2. 检测 VS Code 隧道并打印客户端操作步骤：命令面板 → `Ports: Focus on Ports View` → 右键该端口 → `停止转发端口 / Stop Forwarding Port`。

只检测不终止：`bash scripts/close-port-forward.sh --check`。端口参数可覆盖配置；缺省读取 `backend/config.local.json`（回退 `config.example.json`）的 `port`。

若希望该端口不再被自动转发，在 Remote/工作区设置中关闭 `remote.autoForwardPorts`、取消 `remote.restoreForwardedPorts`，或在 `remote.portsAttributes` 中将该端口设为 `onAutoForward: "ignore"`。本部署可通过节点内网地址直连，不需要端口转发。

## 4. 准备并启用模型

模型环境使用已最小升级的 `symphomotion`。当前多 GPU profile 已启用；后续重部署可依次核对：

1. `environments.symphomotion` 指向真实现有环境；模型工作目录、共享路径、分区和配额在计算节点可用。
2. 当前允许读根为 DiffusionControl 和用户授权的 PretrainedModels。若输入位于其他路径，先获得该目录访问授权，再扩展 `allowedReadRoots`。后端任务不会自动下载权重；显式下载辅助脚本见环境文档。
3. 生成面板的 `ENVNAME` 填 **`symphomotion`**。通用客户端的默认值仍为 base；已保存配置不会被自动改写。推理不能使用后端 Web 服务环境来替代现有模型环境。
4. 在面板填写真实 `pretrained_model_path`、`controlnet_path`、`config_path`、`validation_csv_path`，需要物体控制时填写 Object Injector。基础权重的真实绝对路径见第 1 节；配置的 `inputDefaults` 仅是部署提示，不会覆盖用户请求参数。
5. 旧保存的作业脚本若仍含 `conda init`，通过面板导入 [更新后的 job.gpu](examples/job.gpu)。新模板保留原 GPU/CPU/分区/时限，改为显式 Conda hook 与 `set -euo pipefail`；脚本名、原请求和原提交历史保持不变。
6. 核对后在 `backend/config.local.json` 将该模型改为 `enabled:true`，重启服务，再连接能力接口和发起小规模实际验证。

服务器验证 CSV 的 path 列及每个 sample；路径相对于模型 cwd。当前固定版本实际读取 `first_image.png`、`full_prompt.json`、`spatialtracker2.npz`、`render_output/render_with_2d_bbox.mp4` 和 `render_output/render_mask.mp4`，物体控制另需 `prompt-didi.json`。基础权重索引及分片需存在。后端做文件和元数据检查，不在登录节点导入 Torch 或运行模型来验证环境。

每个模型可在服务端注册完整 profile JSON、入口、环境名、路径字段检查及输出 glob。首版提供 SymphoMotion 适配器和通用文件检查适配器；通用模型也需显式提供 `output_dir` 参数以完成隔离。前端自定义 JSON 不会自动变成服务端可执行模型。

## 5. 作业目录与恢复

```text
projects/<稳定项目 ID>/
  project-info.json
  jobs/<应用作业 UUID>/
    request.json
    execution-plan.json
    submission/<scriptName>
    stdout.log
    stderr.log
    outputs/
    outputs.json
var/
  access-token
  service.lock
  jobs.sqlite3
  assets/
  projects/                       # 快照、完整包和交换暂存
  migrations/                     # 历史迁移备份与报告
```

`request.json` 保存用户原始 API 请求，包括完整脚本。`execution-plan.json` 保存模型 argv、独立 output_dir、模型 profile、输入检查证据；实际 sbatch argv 另存作业数据库。新任务执行时将模型输出参数固定替换为 `projects/<项目 ID>/jobs/<作业 ID>/outputs`，不回写原请求。`job.gpu` 中的 `#SBATCH -o` 是日志选项，实际日志由后端 `--output`／`--error` 定位到同一作业目录。

2026-09-10 已将 9 个已完成历史作业从 `var/jobs` 迁移到项目目录，API 下载 ID 保持不变。历史实际执行命令仍记录当时路径，当前文件位置见 `outputDirectory`；计划中的 `previousOutputDirectories` 保留目录别名用于旧包恢复。备份及报告位于 `var/migrations/20260910-project-storage`，迁移和交互细节见 [目录与交互修复](workflow-usability-and-storage.md)。

数据库只由单个登录节点应用进程访问；采用 DELETE journal、FULL synchronous 和 flock，计算节点不访问 SQLite。已在本项目 GPFS 目录验证单机进程互斥与持久化重开；这不等于验证所有跨节点故障或 GPFS 存储故障模式。真实 Slurm 探测已经验证 `youlab-gpu01` 可读取项目代码并向项目验证目录写入日志。

停止 HTTP 服务后，已提交任务继续由 Slurm 执行。重启同一运行目录会恢复非终态记录，使用 `dc-<UUID>` 作业名从 squeue/sacct 对账。未知提交结果保留原 ID，不自动重发 sbatch；记账服务不可用、记录过期或存在歧义时继续显示待确认，需要结合集群管理员提供的信息处理，不能仅删除数据库记录后重新提交。

取消先保存意图，有已知 Slurm ID 时即使记账服务不可用也会尝试 scancel。只有调度确认取消后才显示 cancelled；终态先成功时保留历史输出，不写回浏览器项目资产。相同 requestId 的“重试提交”只恢复原作业，失败后重新运行需创建新请求。当前未提供独立的带 `retry_of` 新任务接口。

日志下载返回 stdout/stderr 各最后 64 KiB。视频只从发布清单读取，校验路径、符号链接、inode/时间/大小；完成时记录 SHA-256 并将产物设为只读。MP4 验证检查容器头和文件完整性，没有在登录节点解码或评估生成质量。输入检查记录大小和 mtime，并在提交与完成前核对，尚不提供所有外部权重和条件文件的逐字节不可变副本。

## 6. 验证命令与实际结果

```bash
npm test
npm run build
PYTHONDONTWRITEBYTECODE=1 /home/225015066/miniconda3/bin/python -m unittest discover -s backend/tests -t . -v
bash -n docs/examples/job.gpu scripts/start-backend.sh
```

前端测试生成 `var/frontend-contract-request.json`，后端再用它验证真实客户端的参数、引号、布尔值和 Slurm 包装。所有临时文件均位于项目 `var/tests`；测试调度器不会执行 sbatch/scancel 或模型。

2026-09-09 实际结果：

- 前端 **18 个文件、160 项测试通过**；TypeScript 与 Vite 生产构建通过。构建保留 Node 版本与既有主包体积提示。
- 后端 **63 项测试通过**，其中核心测试 30 项、几何 10 项、工作流 10 项、HTTP 10 项、分片规划 3 项；覆盖跨语言契约、并发去重、恢复窗口、取消竞态、输入变更、资产边界、GPFS 进程锁和内网 Host/Origin 规则。
- `pip check` 通过。HTTP 测试最初受沙箱的异步事件唤醒限制，在沙箱外复测通过。安装 Web 依赖后的 HTTP 测试不再跳过。
- 更新后的服务在 0.0.0.0:8000 运行，PID 见 `var/backend.pid`；回环和 10.27.130.15 完成 health、认证、登录、页面、模型能力、新工作流／全局设置及 JSON 404 检查。可用 `python scripts/smoke-backend.py --host 10.27.130.15` 复查，该脚本不会创建/取消推理作业。
- Bash 语法与 `git diff --check` 通过。
- 已下载 Depth Pro／SAM2 权重，用户补齐 SymphoMotion 检查点；真实 Slurm 344272／344274 及随后环境升级、GPU 复测单独记录在 [GPU 验收](gpu-validation.md)。合成导出包另通过原版 loader 的 CPU 测试。双卡短视频生成已通过；720p／长视频的性能与效果，以及用户个人电脑的实际页面访问尚待确认。
