# 81 帧双 GPU 生成显存修复（2026-09-12）

## 故障与依据

用户提供的 API v2 请求启用 `symphomotion-multi-gpu`、`ENVNAME=symphomotion`、2 GPU、81 帧、`max_area=399360`、40 步、CFG 5 和 OMM。首个错误发生在首帧条件的 `VAE.encode`：GPU 0 总容量 31.36 GiB，剩余 159 MiB，申请 884 MiB 失败。还没有进入轨迹编码与去噪，随后报告的 `OMM was enabled but encoder/attention were never executed` 是次生错误。

原分片器把 DiT blocks 分配到两卡，但把 T5、CLIP、VAE、ControlNet 和物体注入模块都常驻 GPU 0，按权重只预留约 5 GiB 激活空间。此前的 5 帧小尺寸验证不能证明完整 81 帧输入可运行。

只读核对现有 symphomotion 环境的 Wan VAE 实现，当前类没有 `enable_tiling` 方法，源码中 `hasattr` 分支未启用切片。因此不能仅通过增加该调用或 `empty_cache()` 解决仍被活跃权重占用的空间。现有模型依赖和权重精度保持不变。

## 修复设计（先文档，后代码）

1. 保留单进程、双 GPU 的 DiT 模型分片，所有模型运算仍在算力节点 GPU 上执行。仅将 T5 和 CLIP 编码器在非使用阶段移回 CPU 内存：完整提示词编码、图像编码和 Entity Text 编码分别在调用前载入 GPU 0，方法完成或报错后释放其 GPU 权重。VAE、ControlNet、DiT、OMM 的 GPU 布局保持原分片约定，40 步去噪期间不逐层搬运主模型。
2. 包装项目 worker 中的编码入口，显式把输入目标设备改为 GPU 0。支持上游以位置参数或关键字传入 device；输出张量留在计算设备。不修改项目外 SymphoMotion 源码、不升级任何环境依赖，不降低帧数、分辨率参数、采样步数或精度。代价是每次编码阶段的 CPU/GPU 权重传输。
3. 分片日志区分常驻权重与编码器临时权重，并记录编码阶段后的显存。原有放置预算仍为编码器同时载入预留空间，避免释放的空间被更多 DiT 权重重新占满。
4. 捕获每个样本真正的异常和 traceback。上游 `infer.main()` 捕获样本错误后继续并返回，项目 worker 必须检查样本成功计数并以原始失败原因退出；不能用 OMM 未执行覆盖先前 VAE OOM，也不能在 OMM 关闭时误报成功。OMM 审计保留，只有成功样本才校验其编码器／注意力调用，审计注明失败阶段与原因。
5. 验证使用用户同一条件包和同一 81 帧／40 步配置，通过 `sbatch` 在 `youlab-gpu` 上运行，推理环境仅 `symphomotion`。新请求 ID 和独立输出目录保留旧失败记录。检查实际 MP4 帧数、分辨率、OMM 调用与峰值显存，并保留视频、预览帧、日志和请求。

CPU 暂存用于释放非当前阶段的 GPU 权重，未改用 CPU 推理。按阶段管理大模型的设备驻留与 [Accelerate 官方模型卸载接口](https://huggingface.co/docs/accelerate/v1.4.0/en/package_reference/big_modeling#accelerate.cpu_offload_with_hook) 的使用场景一致；实现以当前项目 pipeline 的方法边界和本地已安装版本为准。

## 验证记录

后端全套 90 项：89 项通过、1 项因 base 没有模型依赖而跳过。新增回归覆盖编码器设备切换、位置／关键字 device 参数、异常后的释放、原始 OOM 不被 OMM 错误覆盖、逐样本 OMM 验证、跳过／空样本拒绝成功。

真实复测：Slurm `347558`，API 作业 `397bb8a1-fdfc-4294-81db-3f8c39606510`，`symphomotion` 环境，2 张 RTX 5090。请求仅改变 `requestId` 和 `createdAt`，生成参数和执行配置与用户附件完全一致。实际输入 832×480，81 帧、40 步、16 fps。编码后 GPU 0 常驻权重约 11.61 GiB；提示词／图像编码后，含输入张量的 allocated 显存约 12.87 GiB。

验收证据存放在 `var/validation/20260912-inference-memory/attempt1/`，包含原始请求、新请求、worker 源码快照、API 状态和 GPU 监测 CSV。完整后端测试日志为 `var/validation/20260912-inference-memory/backend-tests.log`。

复现脚本：`scripts/replay-generation-validation.py` 用原始请求新建一次验证，指定相同输出目录会复用保存的 requestId；`scripts/verify-generation-replay.py` 在成功后逐帧解码并记录尺寸、帧率、哈希和首／中／末帧图片。视频解码只使用 CPU，不进行模型推理。

### 完整原配置验收通过

Slurm `347558` 和 API 作业均已成功。2026-09-12 12:18:07 开始样本推理，12:34:12 保存 MP4，约 **16 分 5 秒**（不含模型加载）。完整视频逐帧解码通过：**81 帧、832×480、16 fps**，文件 1,982,347 字节，SHA-256 为 `f91892fdafe313e2badc176e5492dc6ed73612183e4e56b57ca34a2e25d71253`。

OMM 实际执行：1 个有效实体、点轨迹 `[2,81,500,3]`（包含实体补齐槽），轨迹编码器 **1 次**、物体注意力 **800 次**，与 40 步、CFG 双次前向、每次 10 个注入模块一致。融合特征 `[1,8100,5120]`，首个注意力输出 `[1,32760,5120]`；审计 `completed=true`。

| GPU | PyTorch peak allocated | PyTorch peak reserved |
| --- | --- | --- |
| cuda:0 | 25.01 GiB | 29.87 GiB |
| cuda:1 | 29.31 GiB | 30.47 GiB |

`nvidia-smi` 包含 CUDA 上下文和缓存，因此其读数不等同于 allocated。附加监测 step 随主作业结束而被 Slurm 清理，这是监测退出，主生成作业已经成功。

保留产物：

- [生成视频](../projects/project_c1f8962c-0231-4e99-892b-faf87b818043/jobs/397bb8a1-fdfc-4294-81db-3f8c39606510/outputs/generated_videos/sample.mp4)
- [首帧](../var/validation/20260912-inference-memory/attempt1/sample-frame-00.png)、[中间帧](../var/validation/20260912-inference-memory/attempt1/sample-frame-40.png)、[末帧](../var/validation/20260912-inference-memory/attempt1/sample-frame-80.png)
- [独立视频与参数核验](../var/validation/20260912-inference-memory/attempt1/verification.json)、[显存峰值](../var/validation/20260912-inference-memory/attempt1/memory-usage.json)、[显存监测](../var/validation/20260912-inference-memory/attempt1/gpu-monitor.csv)
- [OMM 审计](../projects/project_c1f8962c-0231-4e99-892b-faf87b818043/jobs/397bb8a1-fdfc-4294-81db-3f8c39606510/outputs/omm-audit.json)、[完整推理日志](../projects/project_c1f8962c-0231-4e99-892b-faf87b818043/jobs/397bb8a1-fdfc-4294-81db-3f8c39606510/stderr.log)、[后端回归日志](../var/validation/20260912-inference-memory/backend-tests.log)

这次验收确认用户原配置能够完成推理和视频输出，未额外评价运动精度或画质。修复位于项目 worker，新作业自动使用；无须改动此份模型参数，不需要升级依赖或重启 HTTP 服务。
