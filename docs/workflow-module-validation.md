# 重建工作流模块验收（2026-09-10）

用户已确认 sam2／depthpro 环境及项目内源码就绪。本轮沿用现有环境和权重，不重新安装依赖；所有 CUDA 探测、模型加载、推理、点簇关联及动态渲染均通过 `youlab-gpu` 的 sbatch 执行。先记录本方案，再编写验收脚本与修复测试发现的问题。

## 范围与判定

1. 核对 Python、Torch、CUDA、源码 revision 和权重路径，分别提交 SAM2、Depth Pro、PyTorch3D CUDA 探测。
2. 使用项目内固定版本 SAM2 官方示例 `notebooks/images/truck.jpg`，保存本轮输入副本和提示坐标。Depth Pro 与 SAM2 独立提交任务；分别检查深度有效率／内参／点云、候选 mask 尺寸／前景像素／分数，不把置信分数当作标注精度。
3. 将选择的真实 SAM2 mask 关联到同一参考图的 Depth Pro 场景，核对输出点 ID 精确等于 `scene.point_ids[mask.flat[scene.point_ids]]`，点位置不被重建或偏移，AABB 包含全部选中点。
4. 若 PyTorch3D CUDA 扩展可用，移动物体点云并导出短 RGB／hole-mask 条件视频和轨迹，核对首帧、运动、相机／内参及 SymphoMotion loader 的实际读取。
5. 通过模块验收后启用相应 HTTP 任务，验证上传、持久化调度、依赖绑定和产物下载；未通过的模块保留停用原因。必要时用已通过的双卡生成入口验收真实条件包。

测试复用 `docs/examples/job.gpu` 的 Conda hook、ENVNAME 和 argv 转发。单模型探测／推理申请 1 GPU，双卡生成申请 2 GPU；测试副本限制 CPU 与时限，不改写用户全局 Slurm 设置。证据保存于 `var/validation/20260910-workflow/`，包括输入、任务 JSON、提交命令、Slurm ID、stdout/stderr、结构化结果及可视化预览。任何失败也归档，只有实际输出满足断言才判通过。

## 初始检查

两环境 Python 均为 3.10.21、Torch 2.7.1+cu128、torchvision 0.22.1+cu128；SAM2 源码 `2b90b9f5ceec907a1c18123530e92e794ad901a4`，Depth Pro 源码 `9efe5c1def37a26c5367a71df664b18e1306c708`，与部署约定一致。SAM2 未注册 pip distribution，但 worker 显式导入项目内源码，因此以真实导入与推理为准。depthpro 中暂未检测到 PyTorch3D，项目内也没有其源码目录；通过计算节点探测确认是否存在其他可用安装后，再决定导出模块测试范围。

## 首轮结果与修复

- 344445：SAM2 的 CUDA 和真实源码导入通过。
- 344446：Depth Pro 的 CUDA 和依赖导入通过。
- 344447：导出探测失败，`ModuleNotFoundError: No module named 'pytorch3d'`。不更换渲染算法来掩盖缺失依赖；已向用户确认安装位置，其他测试继续。
- 344449：SAM2 模型已产生分割结果，但 worker 保存 overlay 时失败。该固定版本 predictor 将二值 mask 转为 float32 NumPy 返回；原适配器只在写 NPZ 时转 bool，后续仍用浮点 mask 索引 RGBA。修复为 predictor 返回后统一转换 bool，使 NPZ、PNG、overlay 和点簇关联使用同一二值数据；输入 RGB 数组显式可写，避免 torchvision 对只读 NumPy 的警告。新增回归测试覆盖官方 float32 二值返回类型，再提交真实 GPU 复测。

## 本轮最终记录

| 模块 | Slurm ID | 结果 | 证据 |
| --- | --- | --- | --- |
| Depth Pro 与场景重建 | 344448 | 通过；1800×1200 深度全部有限且为正，重建 2,145,590 点；与固定版原函数对照 2,160,000 像素，过滤决定差异为 0 | [数值报告](../var/validation/20260910-workflow/depth-outputs/validation.json) |
| SAM2.1 Large | 344451 | 修复后通过；3 个候选，选择候选 2，641,288 前景像素；正负提示点均满足 | [数值报告](../var/validation/20260910-workflow/sam2-fixed-outputs/validation.json) |
| mask→点簇→AABB | 344457 | 通过；选中 638,168 个原场景点，ID／XYZ／RGB 精确一致，全部点位于拟合 AABB 内 | [数值报告](../var/validation/20260910-workflow/associate-outputs/validation.json) |
| PyTorch3D 与动态导出 | 344447 | 缺失 PyTorch3D；用户确认尚未安装完成，要求先暂停验收 | [探测日志](../var/validation/20260910-workflow/probe-export-344447.log) |

SAM2 候选分数为 0.9453、0.9766、0.9883，它们是模型估计分数；本轮没有人工标注真值，不将其称为实际 IoU。Depth Pro 焦距估计为 3424.13 px，深度 1%／50%／99% 分位数约为 4.17／8.24／15.40 m；没有实测场景尺度，故此项验证输出与几何契约，不验证绝对尺度精度。

物体 AABB 中心为 `[-0.263994, -0.099445, 9.502048]`，半尺寸为 `[2.339478, 0.676835, 1.732508]`，均为重建的 OpenCV 场景坐标。mask 像素数与点簇数不同，是因为重建阶段已过滤部分深度边界像素；关联阶段未另行重建点或改变点坐标。点簇数值计算使用 NumPy，在 Slurm 分配的计算节点执行，GPU allocated 峰值为 0，不能把它声称为 GPU 加速拟合。

输入、深度、掩码和结果表可查看 [独立 HTML 报告](../var/validation/20260910-workflow/report.html)；原始 Slurm 状态见 [accounting](../var/validation/20260910-workflow/slurm-accounting.txt)。新掩码回归测试通过；修复后的真实模型复测也通过。

按用户最新要求，本轮停止提交新的 GPU 测试。动态点云导出、真实条件视频与生成衔接，以及这些任务的 HTTP／前端完整联调，待 PyTorch3D 安装完成后继续。当前工作流能力开关暂未启用，避免将模块测试等同于完整链路验收；现有 SymphoMotion 双卡生成服务仍按此前已通过的部署配置运行。

## 恢复验证方案（2026-09-10）

用户通知环境和源码应已准备完成，恢复上述验收。只读元数据检查已发现 depthpro 中 PyTorch3D 0.7.9、imageio-ffmpeg 0.6.0；项目内 PyTorch3D 源码 revision 为约定的 `0a7d4c1a171e8b768c63f15b17564f9ad495f49b`。sam2／depthpro 的 Python、Torch、torchvision 以及两个模型源码 revision 与首轮一致。元数据存在不等同于 CUDA 扩展可执行，先通过计算节点实测确认。

本次证据单独保存到 `var/validation/20260910-workflow-resume/`，保留首轮成功与失败文件。先分别重测 SAM2、Depth Pro 导入及 CUDA，再运行 PyTorch3D 九点光栅化探测；通过后复用首轮真实卡车场景、候选 2 和关联点簇，导出 5 帧短视频，物体沿场景 X 轴移动 0.5 m，相机固定在重建参考位姿。核对稳定点 ID、逐帧三维位移、相机内参、首帧与零 mask、后续空洞变化、视频可解码性以及固定版本 SymphoMotion loader 实际读取。必要时修复发现的问题并保留失败证据，再进行真实条件包的短双卡生成及 HTTP 任务联调。

本轮不安装或升级依赖；若实际 CUDA 扩展或依赖仍不满足要求，记录精确报错并咨询用户。能力开关仅在相关验收通过后更新，不能用依赖探测替代模型或完整链路验证。

恢复探测 344533／344534／344535 均成功，PyTorch3D 在 RTX 5090 上实际覆盖 12 个测试像素。首次完整导出 344536 已生成全部 5 帧和条件包，但验收脚本 `list(imageio_reader)` 使用视频 reader 的不定长提示预分配，触发 `MemoryError`。这是新增验收脚本的读取问题；改为逐帧迭代收集，并增加仅检查已有产物的模式，保留本次失败报告，在计算节点复核已有输出，无需重复渲染。

复核 344538 通过：五帧始终使用 2,145,590 点，背景坐标精确保持、物体移动 0.5 m、500 个轨迹点 ID 稳定；空洞像素数为 0／1290／2686／4029／5238。官方 loader 344555 在 symphomotion 环境通过：RGB、mask、CUDA 相机 embedding 和补齐到两实体的轨迹张量尺寸正确，解码 mask 和物体轨迹精确一致。

据此创建本机 `backend/config.local.json`，启用 depth／sam2／associate／export，保留示例文件的手动部署门禁与现有全局 Slurm 设置。重启已核实的单进程服务后，以真实 HTTP 请求重新上传照片并依次提交深度、分割、点簇和动态导出，测试同键幂等、项目依赖绑定、状态持久化与带哈希的下载；最后用这份 HTTP 导出包提交双卡、384×256、5 帧、2 步生成。该规模验证执行链路，不评价正式视频质量。前端验证覆盖真实下载点云的解码与场景组装，浏览器实际交互另行标注，不用单元测试冒充浏览器验收。

## 恢复轮最终结果

| 模块 | Slurm ID | 实际结果 |
| --- | --- | --- |
| 环境／CUDA 探测 | 344533、344534、344535 | 全部通过；SAM2、Depth Pro 和 PyTorch3D CUDA 可用 |
| 完整动态点云渲染与数值复核 | 344536、344538 | 渲染输出成功，首次验收读取失败；修正读取后全部断言通过，失败报告保留 |
| 官方 loader／CUDA 相机 embedding | 344555 | 通过；RGB `[1,3,5,256,384]`、mask `[1,1,5,256,384]`、相机 `[1,6,5,256,384]`、轨迹 `[2,5,500,3]` |
| HTTP → Depth Pro | 344566 | 通过，24 秒；2,145,590 点，焦距与首轮一致 |
| HTTP → SAM2.1 Large | 344567 | 通过，9 秒；再次选择候选 2 |
| HTTP → 点簇／AABB | 344570 | 通过，3 秒；638,168 点，AABB 与首轮一致 |
| HTTP → 动态条件导出 | 344572 | 通过，6 秒；视频、轨迹、CSV、ZIP 已发布并下载 |
| HTTP → 双卡 SymphoMotion | 344573 | 通过，75 秒；实际使用上一步条件包，384×256、5 帧、2 步 |
| HTTP 产物 loader 与生成视频解码 | 344574 | 通过；真实视频解码 5 帧，54,753 字节，首尾帧保留 |

所有作业在 `youlab-gpu01` 的 RTX 5090 上运行；生成使用两卡，其余作业分配一卡。直接动态渲染的 GPU allocated 峰值为 416,654,336 字节；双卡生成峰值分别为 28,734,011,392 与 26,856,242,176 字节。复核作业不重复渲染，因此其 GPU allocated 峰值不能当作渲染显存用量。

HTTP 项目 `workflow-validation-7d765556596b` 的作业如下，产物位于 `var/jobs/<ID>/outputs/`：

- depth：`b1089322-f9b0-42dd-80d3-117760053d98`
- sam2：`9bfc6916-eeed-4e0f-bdee-5b71800d29d3`
- associate：`62676270-724a-4422-a2d1-2c02407ecfab`
- export：`97ac5414-5a9f-4d4f-8bd0-640864256a2d`
- generation：`a8408b75-2c6b-4afe-a497-39c994ded976`

上传照片被规范化成 PNG 后，资产 ID 为 `15e81917220838dc444f8ef05d4556ed3f8c0c889e1ba7f8c20ec73893f9197a`；与首轮原始 JPEG 文件哈希不同是预期行为。同一上传、同键任务重复提交均幂等，全局 Slurm 设置未被测试改写，下载内容 SHA-256 与 ETag 一致。生成视频 SHA-256 为 `f6540016df1a9d419140c6707e47c2224075f9faf54446105e3298258f229a8d`。

前端相关 9 项测试通过，其中新增真实 HTTP 产物验收：读取 180,000 场景预览点、100,000 物体预览点和完整 638,168 个物体 ID；剔除后背景预览为 126,453 点，验证真实场景组装及项目保存恢复。此测试只用真实文件验证前端函数，未运行浏览器 WebGL／鼠标交互。命令：

```bash
DIFFUSIONCONTROL_WORKFLOW_EVIDENCE=var/validation/20260910-workflow-resume/http-workflow-ready \
  npm test -- tests/realWorkflow.test.ts src/workflow/workflow.test.ts
```

本轮添加／完善 `scripts/validate-workflow-modules.py`、`validate-export-consumer.py`、`validate-workflow-http.py` 和可指定真实条件 CSV 的 `validate-generation-http.py`，不修改原 SymphoMotion 仓库、不安装或升级任何依赖。启动辅助命令曾使用 base Python 3.8 不支持的 `Popen(umask=...)`，在 HTTP 提交前失败；改为调用 `os.umask` 后服务恢复，最终 PID 为 `1124596`，没有因此产生 GPU 作业。前端验收初版夹具未采用编辑器 `frontPose`，已修正为与真实 UI 相同的初始姿态约定；不是修改产品的姿态规则。

本机四类工作流任务现已启用，`http://10.27.130.15:8000/login` 的页面、认证和 API 检查通过；用户个人电脑的实际访问及交互仍未代验。可查看 [本轮独立 HTML 报告](../var/validation/20260910-workflow-resume/report.html)、[HTTP 链路记录](../var/validation/20260910-workflow-resume/http-workflow-ready/result.json)、[解码记录](../var/validation/20260910-workflow-resume/generated-check/result.json) 与 [Slurm accounting](../var/validation/20260910-workflow-resume/slurm-accounting.txt)。

**范围限制：** 本轮真实 GPU 样例为单物体平移、固定相机、小分辨率短视频；未验收多物体、旋转、移动相机及高清长视频的真实 GPU 效果。2 步生成末帧可见明显车身畸变，本轮仅证明推理链路可执行，不能作为正式画质或运动遵循度验收。动态条件本身的灰色区域是原图遮挡后无点覆盖的空洞，随附 mask 明确标记，未伪造不可见背景。
