# 模型环境安装

`sam2`、`depthpro` 两个环境由用户自行创建和安装；不升级 base。现有 `symphomotion` 已按用户随后批准的最小范围升级，具体版本和差异见第 6 节；Python 仍为 3.10.14，未安装 PyTorch3D。

**真实 GPU 测试修订：** Slurm 344272 实际分配 RTX 5090（sm_120），旧 PyTorch 2.6/cu126 无法执行 CUDA 内核。因此两个新环境改用 **torch 2.7.1+cu128、torchvision 0.22.1+cu128**；下方命令与 requirements 已同步。现有 `symphomotion` 的同版本升级已完成，Slurm 344347 的 CUDA 运算与推理入口导入复测通过。官方从 PyTorch 2.7 开始提供 Blackwell／CUDA 12.8 支持：[发布说明](https://pytorch.org/blog/pytorch-2-7/)、[版本对应表](https://pytorch.org/get-started/previous-versions/#v271)。

## 1. 准备官方源码

从项目根目录执行。源码必须位于本项目内；权重不放进源码目录。固定版本分别为 Depth Pro `9efe5c1def37a26c5367a71df664b18e1306c708`、SAM2 `2b90b9f5ceec907a1c18123530e92e794ad901a4`。

```bash
cd /home/225015066/dev-projects/DiffusionControl
mkdir -p third_party
git clone https://github.com/facebookresearch/sam2.git third_party/sam2
git -C third_party/sam2 checkout 2b90b9f5ceec907a1c18123530e92e794ad901a4
git clone https://github.com/apple/ml-depth-pro.git third_party/ml-depth-pro
git -C third_party/ml-depth-pro checkout 9efe5c1def37a26c5367a71df664b18e1306c708
```

若对应目录已存在，先核对版本，不重复 clone 或覆盖本地修改。所有后续 pip 命令也从项目根目录执行，因为 requirements 中的 editable 路径相对于当前工作目录。

## 2. SAM2

依赖文件：[sam2/requirements.txt](../backend/environments/sam2/requirements.txt)。

```bash
conda create -n sam2 python=3.10 pip -y --solver classic
conda activate sam2
python -m pip install setuptools==75.8.0 wheel==0.45.1
python -m pip install torch==2.7.1+cu128 torchvision==0.22.1+cu128 --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple
SAM2_BUILD_CUDA=0 python -m pip install --no-build-isolation -r backend/environments/sam2/requirements.txt
python -m pip check
```

`SAM2_BUILD_CUDA=0` 是官方支持的开关，关闭可选连通域 CUDA 扩展构建；基础图像提示分割仍使用 GPU。当前工作流不依赖该扩展做小孔/散点后处理，因而无需为此安装 nvcc；不要把此配置误解为 CPU 推理。[SAM2 构建配置](https://github.com/facebookresearch/sam2/blob/2b90b9f5ceec907a1c18123530e92e794ad901a4/setup.py)。

## 3. Depth Pro

依赖文件：[depthpro/requirements.txt](../backend/environments/depthpro/requirements.txt)。

```bash
conda create -n depthpro python=3.10 pip -y --solver classic
conda activate depthpro
python -m pip install setuptools==75.8.0 wheel==0.45.1
python -m pip install torch==2.7.1+cu128 torchvision==0.22.1+cu128 --index-url https://download.pytorch.org/whl/cu128 --extra-index-url https://pypi.org/simple
python -m pip install --no-build-isolation -r backend/environments/depthpro/requirements.txt
python -m pip check
```

该文件包含 Depth Pro 官方推理依赖，以及本项目点云关联和视频导出的 NumPy/Kornia/ImageIO 依赖。完整条件渲染还需在 `depthpro` 环境安装 PyTorch3D；它不在现有 `symphomotion` 环境中，也不会向该环境安装。

PyTorch3D 需要可用的 C++ 编译工具链，以及与 PyTorch 对应的 CUDA 开发工具链（本方案 cu128 对应 CUDA 12.8）。PyTorch wheel 本身不包含 nvcc。已实测：登录节点无 `nvcc` 且 `module avail` 只到 `cuda/12.4`（无法编译 sm_120）；计算节点 `youlab-gpu*` 的系统 CUDA 12.8 工具链位于 `/home/share/software/cuda/cuda-12.8`（`nvcc` 12.8.93）。因此必须通过 sbatch 在计算节点编译，脚本见 `scripts/build-pytorch3d-gpu.sh`：

```bash
conda activate depthpro
git clone https://github.com/facebookresearch/pytorch3d.git third_party/pytorch3d
git -C third_party/pytorch3d checkout 0a7d4c1a171e8b768c63f15b17564f9ad495f49b
python -m pip install fvcore==0.1.5.post20221221 iopath==0.1.10 ninja==1.11.1.3
# 以下在计算节点执行（sbatch），并固定主机编译器与 CUDA_HOME：
export CUDA_HOME=/home/share/software/cuda/cuda-12.8
export PATH="$CUDA_HOME/bin:$PATH"
export CC=/usr/bin/gcc CXX=/usr/bin/g++ CUDAHOSTCXX=/usr/bin/g++
export FORCE_CUDA=1 TORCH_CUDA_ARCH_LIST="12.0" MAX_JOBS=4
python -m pip install --no-build-isolation -r backend/environments/depthpro/requirements-render.txt
python -m pip check
python scripts/probe-workflow-environment.py export   # 仍需 sbatch，验证 CUDA 光栅化
```

`FORCE_CUDA=1` 避免在没有分配 GPU 的编译进程里误构建 CPU 扩展；显式 `TORCH_CUDA_ARCH_LIST="12.0"` 为当前 RTX 5090 生成内核，也避免无 GPU 时无法自动推断架构。若还要兼容其他 GPU，应加入对应架构后重编译。注意：默认 `PATH` 中 `gcc` 解析到 conda-forge 的 16.2.0（超出 CUDA 12.8 支持范围），必须如上固定 `CC`/`CXX`/`CUDAHOSTCXX` 到系统 GCC 11.4.1。编译产物 `pytorch3d._C` 链接 libtorch，运行时须先 `import torch`（项目导出代码已如此），单独 `from pytorch3d import _C` 会报 `libc10.so` 缺失，属预期。缺少对应工具链时先完成两个基础 requirements，保留渲染任务为未就绪。

Depth Pro 官方依赖要求 `numpy<2`，本方案在两环境统一使用 NumPy 1.26.4。Torch 2.7.1／torchvision 0.22.1／cu128 是官方对应组合，选型依据是计算节点实测 GPU。[Depth Pro 依赖](https://github.com/apple/ml-depth-pro/blob/9efe5c1def37a26c5367a71df664b18e1306c708/pyproject.toml)。

## 4. 权重与运行

```text
/home/225015066/PretrainedModels/DepthPro/depth_pro.pt
/home/225015066/PretrainedModels/SAM2/sam2.1_hiera_large.pt
/home/225015066/PretrainedModels/Symphomotion/...
/home/225015066/PretrainedModels/Diffusers/Wan2.1-I2V-14B-720P-Diffusers/...
```

模型权重独立下载，不包含在 pip requirements 内。后端 worker 显式指定权重路径，并将 HF/Torch 模型缓存定向到 PretrainedModels；不依赖默认 `~/.cache` 下载模型。

项目提供 `python scripts/download-workflow-models.py`，从官方 Apple、Meta 和 SymphoMotion Hugging Face 地址下载这三个模型的检查点；`--dry-run` 仅列路径，`--models sam2 depthpro` 可选择子集。文件先写入同目录临时文件，完成后原子发布并记录下载 SHA256，不覆盖已有文件。该 SHA256 是本次下载校验记录，不能冒充发布者提供的校验和。

现有 Wan 模型经文件清单及分片索引检查没有缺失分片；这不是模型加载测试。`python scripts/prepare-symphomotion-source.py` 将已确认的本地 SymphoMotion 固定版本推理源码复制到 `third_party/SymphoMotion`，不会复制模型、数据集或修改原仓库。该目录存在时脚本拒绝覆盖。

安装后复制 `backend/config.example.json` 为 `backend/config.local.json`，核对环境 prefix、checkpoint 和 `workflow.tasks`。先完成计算节点依赖探测，再逐项启用任务并重启后端。`depth`、`associate`、`export` 使用 `depthpro`，`sam2` 使用 `sam2`；生成模型使用原有 `symphomotion`。

基础导入与 `pip check` 可在登录节点做；所有模型加载推理及 GPU 可用性验收通过 sbatch 到计算节点。2026-09-10 用户已完成两个环境及源码准备，depthpro 的 PyTorch3D 0.7.9 CUDA 扩展已在 RTX 5090 验证通过。Depth Pro、SAM2、点簇关联、动态导出和官方 loader 的真实模块测试及 HTTP 调度通过，真实条件包完成双卡短生成；本轮没有安装或升级依赖，详见 [模块验收](workflow-module-validation.md)。

## 5. 安装后的计算节点探测

`scripts/probe-workflow-environment.py` 必须在 Slurm 内执行；检查版本、CUDA 张量运算和任务依赖。`export` 额外运行 9 点的 PyTorch3D CUDA 光栅化测试，不加载模型检查点。它证明运行依赖可用，仍不能替代真实图像的模型质量验收。

```bash
cd /home/225015066/dev-projects/DiffusionControl
mkdir -p var/probes
sbatch --chdir="$PWD" --output="$PWD/var/probes/%j.log" docs/examples/job.gpu ENVNAME=sam2 python scripts/probe-workflow-environment.py sam2
sbatch --chdir="$PWD" --output="$PWD/var/probes/%j.log" docs/examples/job.gpu ENVNAME=depthpro python scripts/probe-workflow-environment.py depth
sbatch --chdir="$PWD" --output="$PWD/var/probes/%j.log" docs/examples/job.gpu ENVNAME=depthpro python scripts/probe-workflow-environment.py export
```

这里复用仓库默认资源脚本；若已在全局面板修改分区等参数，应使用从面板下载的实际脚本。每次探测成功后记录日志对应的 Slurm ID，再启用相应任务。

## 6. SymphoMotion 的 RTX 5090 最小兼容升级

升级前环境含 torch 2.6.0+cu126、torchvision 0.21.0+cu126、torchaudio 2.6.0+cu126、triton 3.2.0；未安装 flash-attn、xformers 或 deepspeed。Slurm 344272 已实测 CUDA 内核不支持 sm_120。用户随后明确要求**在最大兼容性下尽可能只升级 torch/CUDA，保持其他库**，因此采用原环境最小升级，替代先前等待选择的 clone 方案。

```bash
conda activate symphomotion
python -m pip install -r backend/environments/symphomotion/requirements-cu128.txt -c var/validation/20260909-gpu/preserve-other-packages.txt
python -m pip check
```

清单固定 torch 2.7.1、torchvision 0.22.1、torchaudio 2.7.1 的 cu128 wheel；后两者含与 Torch 对应的二进制扩展，不能把旧 cu126 扩展视为已兼容新 Torch。pip 同步安装必要的官方 CUDA 运行库和 Triton。升级前保存 `symphomotion-packages-before.json`，并约束其他所有已安装包的版本；先 `--dry-run --report`，确认精确差异后安装。如严格约束无法满足，只对冲突所需的最小项目另作决定。之后保存包版本差异、pip check、计算节点日志。

第一次严格预演被官方元数据约束阻止：torch 2.7.1 需要 `sympy>=1.13.3`，现有版本是 1.13.1。用户已明确批准**仅额外将 sympy 升至 1.13.3**；其他非 Torch/CUDA 包继续锁定原版本。

原 upstream `infer.py` 将整条 pipeline 放入单 GPU；RTX 5090 约 32 GiB 已实测不足。现使用本项目多 GPU wrapper，分配完整 Transformer blocks 到多张显卡，真实短生成已通过；原生入口申请多 GPU 仍不会自动分片。

本节点实测从 PyTorch 索引获取部分 NVIDIA 运行库非常缓慢；命令同时配置官方 PyPI，以便解析和下载 NVIDIA 在 PyPI 发布的相同版本。实际 SymphoMotion 升级已冻结为官方 wheel URL 和发布 SHA256，清单位于测试目录的 `torch-upgrade-lock.txt`。

升级完成后核对 121 个原包：104 个版本不变，17 个升级，新增一个必要的 `nvidia-cufile-cu12`。变更仅为 Torch 三件套、Triton、对应 NVIDIA 运行库及已批准的 sympy 1.13.3；diffusers 0.33.1、transformers 4.46.2、NumPy 1.26.4 等均未改变。精确差异见 [`package-diff.json`](../var/validation/20260909-gpu/package-diff.json)。

`pip check` 没有报告依赖版本冲突，但返回非零：原有 decord 0.6.0 的 wheel 标记为 cp36，不匹配当前 Python 3.10。其版本未改变，实际 CPU 导入成功；暂不重装该包，继续以视频解码和真实模型测试检查运行影响。原始输出见 [`pip-check.txt`](../var/validation/20260909-gpu/pip-check.txt) 和 [`cpu-imports.json`](../var/validation/20260909-gpu/cpu-imports.json)。

## 7. 多 GPU 测试发现的缺失依赖（已批准安装）

Slurm 344388 已将完整模型装入两张 RTX 5090；在原版 `prompt_clean` 进入 T5 前暴露了缺少 `ftfy` 的错误，未完成生成。此包在升级前后均不存在，与 Torch 升级无关。建议仅新增 `ftfy==6.3.1`；该版本要求 Python ≥3.9，唯一依赖 `wcwidth` 已存在（0.8.3），可以 `--no-deps` 安装而不更改任何现有包。官方发布信息见 [PyPI 6.3.1](https://pypi.org/project/ftfy/6.3.1/)。

精确 wheel 和 SHA256 已写入 [`requirements-missing.txt`](../backend/environments/symphomotion/requirements-missing.txt)，大小 44,821 字节。用户已另行批准并完成安装；[`ftfy-package-diff.json`](../var/validation/20260909-gpu/ftfy-package-diff.json) 确认仅新增 ftfy 6.3.1，没有任何现有包版本变化。最终完整版本快照为 `symphomotion-packages-final.json`，双卡复测为 Slurm 344399。
