# Depth Pro、SAM2 与 SymphoMotion 完整工作流

2026-09-11 修订：本轮要求定向包围盒，并将正式生成条件改为“参考场景点云渲染 + 操控物体投影框”，不渲染移动后的物体点云。取代下文早期 AABB 和动态点云导出选择，详见先行建立的 [运动控制与渲染设计](motion-controls-and-rendering.md)。

日期：2026-09-09。本文先于对应代码修改建立；实施与验收结果在文末持续更新。

2026-09-10 修订：作业目录按项目组织，初次重建成功自动绑定点云；SAM2「添加物体」保存定义并自动关联、应用点簇。详细行为与迁移方案见 [目录与交互修复](workflow-usability-and-storage.md)，下文早期「应用重建／加入场景」手动步骤仅用于替换场景或旧关联结果。

## 1. 本轮范围与已确认决定

实现首帧上传 → Depth Pro 深度/相机估计与点云重建 → SAM2 交互分割 → mask 对应物体点簇与初始 3D bbox → 现有物体/相机轨迹编辑 → SymphoMotion 条件包导出 → 既有生成任务的链路。

所有推理以及关联/导出任务经现有作业存储、协调器和 `sbatch` 到计算节点执行。登录节点只处理 HTTP、文件校验、任务组织、状态与下载；浏览器负责交互及点云预览。小型合成数组的单元测试不属于模型推理。

| 项目 | 决定 |
| --- | --- |
| 新推理代码 | 全部位于 `/home/225015066/dev-projects/DiffusionControl`；官方依赖源码固定版本保存在项目内 `third_party/` |
| 模型和权重缓存 | 全部位于 `/home/225015066/PretrainedModels`；DepthPro、SAM2、SymphoMotion 分目录，复用现有 Wan 基础模型目录 |
| HTTP 环境 | 保持现有 base，不升级其 Python |
| 预处理环境 | 用户自行安装 `sam2` 与 `depthpro`，关联与条件渲染使用 `depthpro`；PyTorch3D 扩展单独准备。真实测试后用户另批准原 `symphomotion` 的最小 Torch/cu128 升级及 sympy 补丁例外，其他库锁定不变，见 [安装说明](model-environments.md) |
| SAM 模型 | 用户已确认 SAM2.1 Hiera Large |
| 初始包围盒 | 2026-09-11 改为任意三维朝向的近似最小体积 OBB，完整包含全部点；继续通过现有界面选择物体正面 |
| 公共 Slurm 配置 | 新增全局设置中的脚本文件名、脚本正文及版本；任务各自选择 ENVNAME，提交保存完整不可变快照 |
| 兼容基准 | 本地 SymphoMotion `bf9af6666c0f8cbb594e64f165be79b44c962763` 的 `src/pointcloud.py` 与实际 loader |

SAM2 官方要求 Python ≥3.10、PyTorch ≥2.5.1；不向 Python 3.8 base 安装模型栈。[官方安装说明](https://github.com/facebookresearch/sam2#installation)。Depth Pro 使用官方 `create_model_and_transforms` 和 `infer`，读取深度与像素焦距结果。[官方接口](https://github.com/apple/ml-depth-pro#running-from-python)。

## 2. 共享资产和几何契约

上传图像经过格式、字节数和像素数限制，统一方向及 RGB 表示，以内容哈希分配不可变资产 ID。浏览器显示和所有任务使用同一份规范化图像，防止 EXIF 方向或缩放造成点击错位。单个上传允许至多 32 MiB，像素数上限 1600 万；不接收 SVG 等主动内容。

Depth Pro 产物保存原始米制 Z 深度、处理后深度、K、参考 c2w、边缘删除标记、保留点 ID、XYZ/RGB、预览点云及 `result.json`。完整几何用非 pickle NPZ，预览用有明确长度和字段的二进制文件；不能把数百万点写进浏览器 localStorage。

采用首帧 OpenCV 相机坐标作为世界坐标（右、下、前），参考 c2w 为单位矩阵。前端保持整数像素中心的 K。进入上游半整数反投影/渲染契约时显式转换 principal point：`K_legacy.cx = K_front.cx + 0.5`，`K_legacy.cy = K_front.cy + 0.5`，保留两种约定的元数据，禁止隐式互换。

每个源像素有稳定 `point_id = v * width + u`。对正且有限的 Z 深度：

```text
p_camera = D_processed(u,v) * inverse(K_legacy) * [u+0.5,v+0.5,1]
p_world = reference_c2w * [p_camera,1]
```

兼容处理顺序：复制深度 → `median(depth) * contract` 远景压缩 → 逆深度全图归一化 → 未归一化 Sobel → `exp(-10*|gradient|) < threshold` 删除边缘 → 反投影并保留源像素 ID。默认 `contract=8.0`、`threshold=0.35`。无效深度显式标记，不允许 NaN/Inf 污染全图统计；与原函数在正常有效输入上的一致性单独测试。

相机焦距默认由 Depth Pro 估计；可在任务面板显式提供像素焦距覆盖。主点初始取图像中心，畸变标记为假设无畸变，不冒充真实标定。重建依赖参考标定快照，之后修改拍摄镜头不悄悄改变源几何。

## 3. SAM2、点簇与包围盒

2026-09-11 新增 [3D View 包围盒可视化编辑](bounding-box-editor.md)：支持平移、旋转、尺寸与精确数值输入。应用复用 `associate` 和全局 Slurm 配置，从完整场景筛选框内非占用点；成功后以新产物原位替换物体、保留手工框并清除当前物体轨迹。此选择以用户编辑的 3D 框为准，原 SAM2 结果继续作为历史来源。

前端在规范化首帧上收集正/负点击与可选矩形框，按实际图像显示区域换算为原图像素，排除留白区域。请求保存提示点、标签、框与源图像 ID。每次点击修改先在本地形成提示，用户提交后启动一个 Slurm 任务，避免每个鼠标事件排一个 GPU 作业。

SAM2ImagePredictor 输出完整二值 mask、预览 PNG、预测评分和提示快照。初次多候选分割展示各候选及评分，用户选择后再关联点云；追加提示可重新提交。禁止把彩色缩略图当二值 mask。

关联任务检查图像 ID、分辨率和重建版本一致，直接以 `mask.flat[scene.point_ids]` 筛选已重建且未被边缘剔除的点。保留物体点、原始点 ID、颜色、bbox 和局部坐标，不重新估计深度；同一来源像素不会误选遮挡物体后面的背景。

初始框采用 NumPy 多起点旋转搜索和完整点簇极值复核，输出场景中心、局部半尺寸及 `boxQuaternion`，算法记录为 `multistart_support_refined_obb`。这是用户接受的高精度数值近似，不承诺全局最优。对极薄轴保留 2 mm 最小厚度；点数不足则返回可理解错误。不做统计离群点删除或只保留最大连通块。旧 AABB 结果缺少四元数时按单位旋转读取，不自动改变已有轨迹起点。

不同实例点 ID 不允许重叠绑定；冲突时要求修正 mask，保留原结果供查看。场景背景从原始场景点中排除已绑定对象的点，移动对象时不会在原地重复出现。单视角数据不自动补全物体背面或被遮挡背景。

## 4. 任务与 API

复用现有 `Store`、Slurm 协调器、日志、取消和下载。工作流 API 只负责类型化校验、解析依赖资产并构建 worker argv，不另写一套 sbatch 实现。任务类型为 `depth`、`sam2`、`associate`、`export`。

| API | 用途 |
| --- | --- |
| `GET/PUT /api/settings/execution` | 带 revision 的公共 Slurm 脚本，冲突返回 409 |
| `GET /api/workflow/capabilities` | 任务配置、已注册环境、模型就绪状态及原因 |
| `POST /api/workflow/assets` | 上传首帧，返回资产 ID、尺寸、哈希与下载地址 |
| `GET /api/workflow/assets/{id}/image` | 读取规范化首帧 |
| `POST /api/workflow/jobs` | 幂等提交类型化工作流请求，返回通用作业记录 |
| `GET /api/workflow/projects/{projectId}/jobs` | 恢复此项目的任务及来源快照 |
| 既有 `/api/inference/jobs/{id}` 及子路由 | 复用查询、取消、日志和已发布输出下载 |

任务请求包含 `requestId/createdAt/projectId/projectName/kind/inputs/options/execution`。`execution` 采用现有 Slurm 配置字段；后台仅接受注册任务入口。任务输入引用已发布作业产物和上传资产 ID，不接受任意浏览器提供的服务器路径。

每作业建立独立 `submission/task.json`、脚本、执行计划和 `outputs/`。worker 读取已解析的绝对路径及参数，通过参数数组启动；要求存在 Slurm 作业上下文。服务端将注册的 ENVNAME 解析到准确环境 prefix，实际提交命令记录解析结果。

任务成功须检查类型对应的必需产物、结果 manifest、来源版本及文件完整性。失败不能把项目标为 geometry ready；取消结果保留为历史。浏览器将任务来源和当时输入保存在提交记录中；恢复轮询或晚到结果时，只有项目 ID、源图像及依赖作业仍匹配才允许应用。

## 5. 全局 Slurm 设置与旧配置迁移

公共设置保存 `revision/scriptName/scriptContent`，仍使用已验证的 ENVNAME 参数和末尾 `exec "$@"` 协议。资源参数由 `#SBATCH` 指定，沿用当前集群分区与用户模板；单独任务只选择环境和模型参数。新任务在提交时固定公共脚本版本及正文，后续设置更新不影响队列任务。

生成面板提供使用公共脚本的方式，并保留历史运行配置的脚本快照与复现能力。旧项目导入不静默覆盖用户自定义脚本；用户选择采用全局设置时更新当前草稿。全局面板可从当前生成配置导入脚本，避免重复编辑两份模板。

模型参数、ENVNAME 和生成配置继续在各自任务面板，不混入全局资源配置。HTTP 连接及会话继续使用既有同源入口。

## 6. 条件导出及最终生成

导出任务读取完整场景点、已绑定物体点 ID、对象初始位姿、轨迹、clip、相机标定和相机轨迹。按统一帧时间采样位置及四元数，将同一组稳定物体点转换到各帧相机系。默认参考预设为 81 帧、16 fps、每物体 500 点；帧数与分辨率须符合生成模型配置。

导出前检查首帧相机对齐参考相机、固定 K、无未适配畸变、物体运动已分配、实体提示词非空、源版本一致；仅相机运动允许没有受控实体。输出至少包括：

```text
sample/first_image.png
sample/full_prompt.json
sample/prompt-didi.json
sample/spatialtracker2.npz
sample/render_output/render_with_2d_bbox.mp4
sample/render_output/render_mask.mp4
validation.csv
manifest.json
conditions.zip
```

`spatialtracker2.npz` 使用 `cam_c2w`、`intrinsic` 和 `camera_3d_pred_{key}_sampled`，实体 key 与提示词固定映射。K 与最终视频分辨率一致，显式处理 resize 的像素中心变换，不依赖上游 loader 修正。

2026-09-11 起，正式导出改为**参考场景点云渲染 + 运动点投影框**。按相机路径渲染完整原处场景点云（包括物体原位置的点），变换后的物体点只参与轨迹保存和红色投影框，不加入光栅化输入；空洞仍定义为最近层 `zbuf==-1`。首帧替换原图并将 mask 清零，框线不改变空洞 mask。前端 4D 点云预览仍显示物体实际运动，便于编辑。旧 `dynamic_pointcloud_with_projected_boxes` 包仅保留下载，新填入生成要求策略 `reference_scene_with_projected_boxes_v2`。

前端展示条件视频、空洞视频和校验结果，提供将已发布 `validation.csv`、帧数、fps 及模型权重路径填入现有生成配置的操作，随后由原生成面板提交最终推理。填入前比较完整导出快照：场景版本、物体点簇、初始位姿、轨迹、时间片段、相机标定、时长和提示词；任何相关编辑都会要求重新导出。已经冻结的历史生成请求仍可独立复现。

配置样例注册 `sam2`、`depthpro` 和既有 `symphomotion` 的准确环境路径，模型代码工作目录使用项目内 `third_party/SymphoMotion`。任务默认保持禁用，完成用户安装及计算节点验收后在 `backend/config.local.json` 显式启用；`available` 只表示配置与必要文件检查通过，不等于 GPU 或模型效果已经验证。

## 7. 验证计划与状态

必要验证：正常深度压缩/Sobel 与上游一致；非方图、像素中心与坐标往返；mask 精确选点及重叠冲突；AABB 包含所有物体点；公共时间轴和稳定点集；输入版本失效；上传边界；共享调度幂等/取消/恢复；真实资产的前端保存恢复与三维显示；导出包被官方 loader 正确读取。

用合成数据完成 CPU 单元测试和模拟调度/HTTP 集成，前端执行相关回归及生产构建。环境和权重就绪后，通过真实 sbatch 执行环境探测、Depth Pro、SAM2、关联与导出，最后完成一个小规模 SymphoMotion 生成任务。排队成功、文件存在与模型推理成功分别记录。

实施记录：本文方案及前后端代码已实现，前端 160 项、后端 63 项回归通过；合成导出包通过上游 loader 的 CPU 契约验证。用户自行安装 `sam2`／`depthpro`，所有检查点已齐备。已按用户批准的最小范围升级现有 symphomotion，并补齐 ftfy；Slurm 344399 的两张 RTX 5090 模型分片生成成功，5 帧视频已保存；测试命令、日志、失败证据和后续进展见 [GPU 验收记录](gpu-validation.md)。

后续模块验收：Depth Pro 对 1800×1200 真实照片重建、SAM2 分割及原场景点簇关联已通过；已修复 SAM2 float32 二值 mask 的 overlay 索引错误。用户完成 PyTorch3D 安装后，真实动态导出、官方 loader、四类任务 HTTP 调度及真实条件包双卡短生成也通过；本机 `backend/config.local.json` 已启用工作流。前端真实产物解码／场景组装／保存恢复已验证，浏览器交互及正式生成质量未验收，详见 [模块记录](workflow-module-validation.md)。
