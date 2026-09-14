# 真实算力节点验收

用户已授权使用 `youlab-gpu` 做真实测试并保留结果。所有 GPU 探测、模型加载与推理均通过 sbatch；测试报告和日志保存在项目 `var/validation/20260909-gpu/`。先使用现有 `symphomotion` 探测 CUDA、显存及模型入口依赖，再根据实际显存提交小规模生成测试。Depth Pro、SAM2 和动态点云光栅化待用户提供已安装环境后分别执行；SymphoMotion 环境仅做下文另行批准的最小兼容升级。

已确认用户下载的附加权重目录为 **`/home/225015066/PretrainedModels/Symphomotion`**（注意大小写），其 `pretrained_checkpoints/camera_control/controlnet.pth` 为 3,991,620,779 字节，`pretrained_checkpoints/object_control/object_injector.pth` 为 1,773,269,636 字节。配置和前端填充参数使用这个实际路径，不移动或复制用户权重。

测试将缩短作业时限并申请单 GPU，仍复用 `docs/examples/job.gpu` 的 Conda hook、ENVNAME 和 argv 转发约定。基础探测不代表模型生成成功；合成条件仅用于接口验收，不作为真实 Depth Pro／SAM2 重建结果或模型效果样例。

## 实际执行记录

| Slurm ID | 节点 | 内容 | 结果 |
| --- | --- | --- | --- |
| 344272 | youlab-gpu01 | 现有 symphomotion 的 CUDA 运算探测；1 GPU，4 CPU | FAILED，退出 1:0，耗时 5 秒；torch 2.6/cu126 缺少 sm_120 内核 |
| 344274 | youlab-gpu01 | 分配到的 GPU 硬件信息；1 GPU，1 CPU | COMPLETED，退出 0:0，耗时 2 秒；RTX 5090，32607 MiB，驱动 580.105.08，计算能力 12.0 |
| 344347 | youlab-gpu01 | 最小升级后的 symphomotion CUDA 运算与推理入口导入 | COMPLETED，退出 0:0，耗时 32 秒；Torch 2.7.1/cu128，sm_120，CUDA tensor sum=4 |
| 344350 | youlab-gpu01 | 5 帧、2 步原生 SymphoMotion 生成；1 GPU，8 CPU，125 GiB 主存 | FAILED，退出 1:0，耗时 4 分 5 秒；pipeline.to(cuda) 时 GPU 显存不足，未生成视频 |
| 344388 | youlab-gpu01 | 两张 RTX 5090 的模型分片，单进程 | FAILED，1:0，1 分 26 秒；完整模型已装入两卡，提示词清理缺少 ftfy，未输出视频 |
| 344399 | youlab-gpu01 | 补齐 ftfy 后双卡生成；256×144，5 帧，2 步 | COMPLETED，0:0，1 分 18 秒；输出 MP4 5,860 字节，解码 5 帧通过 |
| 344435 | youlab-gpu01 | 实际 HTTP→持久化→sbatch→发布→下载链路；同一短条件包 | COMPLETED，0:0，1 分 15 秒；下载 5,791 字节，SHA256 与 ETag 一致，解码 5 帧通过 |

原始证据：[`probe-344272.log`](../var/validation/20260909-gpu/probe-344272.log)、[`probe-344272.err`](../var/validation/20260909-gpu/probe-344272.err)、[`inventory-344274.log`](../var/validation/20260909-gpu/inventory-344274.log)、[`slurm-accounting.txt`](../var/validation/20260909-gpu/slurm-accounting.txt)。对应的 `*-command.json` 和 `*-slurm-id.txt` 保存在同目录。清单仅显示实际分配的 GPU，不据此声称已检查节点全部显卡。

用户已批准原 symphomotion 的最小 Torch/cu128 升级及 sympy 1.13.1→1.13.3 补丁例外。已保存升级前 121 个包版本，其他非 Torch/CUDA 包继续通过 constraints 锁定。两个新模型环境仍由用户安装。

升级已完成：104 个原包版本不变，17 个升级，新增一个所需 NVIDIA 运行库；没有未批准的包变更。见 [`package-diff.json`](../var/validation/20260909-gpu/package-diff.json)、[`torch-install.log`](../var/validation/20260909-gpu/torch-install.log) 和 [`probe-344347.log`](../var/validation/20260909-gpu/probe-344347.log)。`pip check` 唯一包问题是原有 decord 的 cp36 wheel 平台标记与 Python 3.10 不匹配，实际导入及 5 帧 CPU 视频解码均成功（[`decord-decode.json`](../var/validation/20260909-gpu/decord-decode.json)），未改动版本。Conda 激活仍输出原有 libmamba/libarchive 警告，但实际选中正确环境并完成 CUDA 测试；没有改动 base 来修复此警告。

## 代码与 HTTP 验证

- 前端 18 个文件、160 项测试通过（全量 159 项后新增分片命令往返测试通过），TypeScript 和 Vite 生产构建通过；保留 Node 20.12.2 低于 Vite 声明版本的提示。
- 后端 63 项核心／几何／工作流／HTTP／分片规划测试通过；另 1 项 loader 测试在 base 跳过、在 symphomotion 单独通过。HTTP TestClient 在沙箱外执行，模拟 Slurm，不混入真实 GPU 结果。
- 合成条件导出测试使用替身光栅化器并真实编码 MP4，成功通过固定版本 SymphoMotion 原 loader（CPU）的读取，核对帧／尺寸、mask、相机 embedding 和物体坐标变换。此项不代表真实 PyTorch3D 或模型效果验证。
- 上述 loader 测试在 Torch/cu128 升级后再次通过，记录见 [`export-loader-cu128.txt`](../var/validation/20260909-gpu/export-loader-cu128.txt)。
- 30 组小型合成深度的压缩与 Sobel 点选择直接对照固定版本 SymphoMotion 原函数，点 ID 一致。
- 更新后的 HTTP 服务 PID 记录于 `var/backend.pid`；回环及 `10.27.130.15:8000` 的登录、静态页面、工作流状态和全局设置均通过，报告为 [`http-local-final.txt`](../var/validation/20260909-gpu/http-local-final.txt) 和 [`http-network-final.txt`](../var/validation/20260909-gpu/http-network-final.txt)。这不替代个人电脑上的实际访问确认。

尚待：用户新环境就绪后的 Depth Pro／SAM2／真实动态光栅化，以及长视频／720p 的性能与质量评估。保留失败证据，不把文件齐备或 Slurm 接收成功当作模型推理成功。

短生成测试使用 `scripts/validate-symphomotion-gpu.py`：在计算节点制作明确标记的合成参考图与条件（256×144、5 帧、500 个稳定物体点），以 2 个去噪步执行项目内固定版本原生 infer.py，启用相机和物体控制并读取用户提供的全部检查点。日志、输入、精确 argv、结果 JSON 和任何生成视频保存在 `var/validation/20260909-gpu/generation-<Slurm ID>/`。合成输入仅验证运行接口；不声称来自 Depth Pro／SAM2，也不作为质量评估。若原生脚本不适合单卡 32 GiB，保留失败证据后再选择内存适配方式。

## 原生生成的显存限制（2026-09-10）

344350 已读取 Transformer 14 个分片、T5 5 个分片、ControlNet 和 Object Injector 检查点；失败发生在 `infer.py:241` 的 `pipeline.to(device)`，早于样本推理。错误记录 GPU 总显存 31.36 GiB，进程占用 31.26 GiB，无法再分配 136 MiB。减小帧数或图像尺寸不能解决这一加载阶段问题；原脚本的多 GPU 分配按样本分工，不自动把一个模型分片到多卡。

保留 [`完整推理日志`](../var/validation/20260909-gpu/generation-344350/inference.log)、[`结果 JSON`](../var/validation/20260909-gpu/generation-344350/result.json)、[`合成参考图`](../var/validation/20260909-gpu/generation-344350/synthetic_sample/first_image.png) 和 [`合成条件视频`](../var/validation/20260909-gpu/generation-344350/synthetic_sample/render_output/render_with_2d_bbox.mp4)。后两者是测试输入，不能当作生成结果。

用户已选择**优先实现多 GPU 模型分片**。使用下述方案继续验证，保持模型原始精度和现有依赖版本。

### 多 GPU 分片执行设计

项目内 `backend/workers/symphomotion.py` 复用固定版本 `infer.py` 的参数、权重构建、数据读取与生成逻辑，`--memory_mode multi_gpu` 启用分片；`native` 保留原生行为。采用一个 Slurm task、一个 Python 进程、至少两张可见 GPU；拒绝 torchrun 多进程上下文，防止每个进程再次占满全部显卡。ENVNAME 仍为 `symphomotion`，sbatch 脚本继续复用全局设置。

先在 CPU 构建模型，按每个模块实际参数及 buffer 字节数分配：VAE、ControlNet、物体编码器及主 Transformer 的非 block 模块在 cuda:0；完整 Transformer blocks 按剩余显存预算分散到各卡。文本／图像编码器也在 cuda:0 执行，但自 2026-09-12 起仅在编码阶段载入，其余阶段放在 CPU 内存，释放 VAE 和去噪需要的显存，详见 [81 帧显存修复](inference-memory-20260912.md)。放置预算仍计入编码器临时权重，每张卡预留至少 5 GiB 或总显存的 15% 给激活和 CUDA 开销。预算只能排除明显无法装载的配置，不保证任意 720p／帧数的运行显存都足够。

跨卡 block 使用现有 Accelerate 的 AlignDevicesHook，将输入移到该 block 的卡上，输出回到调用方 cuda:0。这保证原版 forward 中直接相加的 ControlNet 残差、物体注意力和归一化张量处于同一卡；不复制整个模型，不改变数值精度。该实现优先验证正确性，跨卡传输可能限制吞吐，不声称多 GPU 必然加速。所有适配放在项目 wrapper，不修改原仓库或环境库文件。

日志记录实际 device map、各卡权重字节数、硬件及峰值显存。首轮同样生成 5 帧、2 步测试视频，申请两张 GPU、8 CPU、125 GiB 主存；输出必须实际解码通过才判成功。前端新增独立“多 GPU 模型分片”模型 profile；既有单卡配置和提交历史仍可读取，真实条件导出默认填入新 profile。正式启用以该路径实际测试结果为准。

344388 已验证两卡可装载全部权重：cuda:0 为 26,349,375,060 字节，cuda:1 为 26,656,041,984 字节；进入提示词编码时因缺少 ftfy 停止。加载阶段峰值分别为 26,473,897,984 和 26,725,248,000 字节，尚不是完整推理峰值。精确 device map 与错误见 [`inference.log`](../var/validation/20260909-gpu/generation-344388/inference.log)。探测脚本及入口增加提示词清理依赖的提前检查，避免同一缺失项在加载大模型后才暴露。

## 双卡生成成功与后端接入

344399 通过完整模型加载、T5／图像／VAE 编码、相机和物体条件控制、跨卡 Transformer 运算及视频解码。模型加载加推理 75.55 秒，Slurm 总耗时 78 秒；峰值 allocated 显存为 cuda:0 26.61 GiB、cuda:1 24.96 GiB。保留 [`生成视频`](../var/validation/20260909-gpu/generation-344399/outputs/generated_videos/synthetic_sample.mp4)、[`末帧预览`](../var/validation/20260909-gpu/generation-344399/generated-last-frame.png)、[`完整结果与 device map`](../var/validation/20260909-gpu/generation-344399/result.json)。视频仅 2 步、5 帧，用于运行验收，非生成质量评估。

据此启用 `symphomotion-multi-gpu` v1，原单卡 profile 继续停用。最后通过同源 HTTP 登录、提交同一小条件包，经现有协调器真正 sbatch、轮询至成功，再从发布的输出接口下载并核对 SHA256，验证完整后端链路。测试请求使用独立 projectId 和 requestId，保存在验证目录；认证令牌不写入请求记录。重建相关四种任务仍等待用户安装环境后启用。

该链路已由 Slurm 344435 验证成功，API job ID 为 `7089b56b-25b1-4271-bf4c-01539ace6aea`。实际推理输出隔离到 `var/jobs/<job ID>/outputs`，状态依次为 queued、running、succeeded。[`HTTP 验收报告`](../var/validation/20260909-gpu/http-generation-d91992995250/result.json)、原始请求／响应／日志及下载视频在同目录；[`登录后下载测试视频`](http://10.27.130.15:8000/api/inference/jobs/7089b56b-25b1-4271-bf4c-01539ace6aea/outputs/0)。该视频来自明确标记的合成条件，不是 SAM2／Depth Pro 输出。

最终服务重启后再次只读确认：已完成作业仍为 succeeded，多 GPU profile 可用，视频下载 SHA256 与重启前一致；见 [`restart-readback.json`](../var/validation/20260909-gpu/http-generation-d91992995250/restart-readback.json)。

最后只读检查已发现 sam2／depthpro 两个 Python 3.10.21 环境和正确固定版本源码，Torch 均为 2.7.1/cu128；sam2 尚无安装分发元数据，depthpro 尚无 PyTorch3D。源码可由 worker 的项目内路径导入，因此分发元数据缺失不单独等于不可运行；仍等待用户确认安装完成后再提交各自真实模型测试，暂未启用这些任务。

2026-09-10 首轮模块更新：用户确认两个基础环境与源码已就绪。真实 Depth Pro、SAM2（修复 overlay 类型错误后）、点簇关联均通过；当时 PyTorch3D 尚未安装完成，按用户要求暂停其验收。

2026-09-10 恢复更新：PyTorch3D 0.7.9 已安装，RTX 5090 CUDA 光栅化通过。完整点云逐帧移动和 RGB／空洞 mask 导出经 344536／344538 验证；官方 loader 344555 通过。HTTP 作业 344566／344567／344570／344572 分别完成真实深度、分割、点簇与导出，双卡 344573 使用该真实条件包生成 384×256、5 帧、2 步视频，耗时 75 秒；344574 解码确认 5 帧。视频末帧明显畸变，本轮证明链路可执行，不作为正式画质验收。本机四类工作流任务已启用，报告、视频、失败记录及完整范围见 [重建模块测试](workflow-module-validation.md) 和 [离线 HTML 报告](../var/validation/20260910-workflow-resume/report.html)。
