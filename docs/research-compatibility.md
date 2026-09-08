# SymphoMotion、ViewCrafter、Uni3C 兼容性核实

初次核实日期：2026-09-05。2026-09-06 补充 [轨迹时间、相机预览与镜头调研](trajectory-camera-research.md)。本文区分「官方源码已确认」「论文描述」「本系统建议」和「尚未验证」，未运行模型推理，未证明端到端兼容。4D 数据保留，界面修订为仅 2D／3D；旧 D01／D02 操控规则已被新需求覆盖。

## 1. 结论及项目身份

用户所称 symphomotion 对应 **SymphoMotion: Joint Control of Camera Motion and Object Dynamics for Coherent Video Generation**，官方仓库为 [grenoble-zhang/SymphoMotion](https://github.com/grenoble-zhang/SymphoMotion)，论文为 [arXiv:2604.03723](https://arxiv.org/abs/2604.03723)。与另外两个项目的关系如下。

| 项目 | 已确认的几何表示/控制方式 | 对本系统的直接意义 |
| --- | --- | --- |
| SymphoMotion | 首帧深度点云；相机 Plücker embedding 与点云渲染条件；多物体三维点集轨迹和实体提示词 | 首要导出目标；只保存中心点曲线、包围盒或 PLY 均不足以直接驱动官方推理 |
| ViewCrafter | DUSt3R 重建的彩色点云，沿相机姿态序列渲染后交给视频模型 | 借鉴点云表示、相机重渲染和点云可视化；其三行轨迹 TXT 不能完整承载自由 6DoF 录制 |
| Uni3C | Depth-Pro 反投影场景点云；将 SMPL-X 人体与场景对齐后联合渲染 | 借鉴统一世界坐标和同步渲染；其人体运动接口不能直接视为任意物体轨迹接口 |

依据：[SymphoMotion 方法与推理流程](https://arxiv.org/html/2604.03723v1#S3)、[ViewCrafter 官方实现](https://github.com/Drexubery/ViewCrafter/blob/97cdb8634b28708cbd50912d57c52f23c5ffbf09/viewcrafter.py)、[Uni3C 论文](https://arxiv.org/abs/2504.14899)。

**建议架构：**本系统维护统一场景、原始录制轨迹和对象局部坐标；通过独立导出适配器生成各模型要求的文件。不要用某个模型的推理 NPZ 代替可编辑的 project 主数据。

**已确认部署边界：**采用浏览器前端与后端分离架构，GPU 推理由 CE 集群后端承载。浏览器负责交互、轨迹采样与点云预览；分割、重建、模型条件渲染和导出适配由后端服务执行，并返回带版本的产物与任务状态。具体集群调度接口另行设计，不将浏览器中的坐标或渲染对象直接视作模型输入。

## 2. 调研版本

| 仓库 | 本次核实版本 |
| --- | --- |
| SymphoMotion | `bf9af6666c0f8cbb594e64f165be79b44c962763` |
| ViewCrafter | `97cdb8634b28708cbd50912d57c52f23c5ffbf09` |
| Uni3C | `75ed6e2180316b7f07398e4e88ea8bdba3e6970c` |

后续实现应在导出 manifest 中保存仓库版本、模型权重版本与适配器版本。仓库 `main` 会变化，不能仅用模型名称说明格式兼容。

## 3. SymphoMotion 的文件级输入

### 3.1 官方推理读取的目录

```text
sample_name/
├── first_image.png
├── full_prompt.json
├── prompt-didi.json
├── spatialtracker2.npz
└── render_output/
    ├── render_with_2d_bbox.mp4
    └── render_mask.mp4
```

官方 `assets/demo.csv` 使用 `path` 列列出 sample 目录。`infer.py` 读取 `full_prompt.json` 的 `full_prompt` 字段，再调用 `src/dataset_from_npz.py` 读取上述几何和视频条件。开启物体控制时还需要 `prompt-didi.json`；README 的简略目录未列出该文件，但实际 loader 会读取它。[推理入口](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/infer.py#L259)、[loader](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/dataset_from_npz.py#L38)、[CSV 示例](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/assets/demo.csv)。

### 3.2 NPZ 字段与坐标

`F` 为帧数，`P` 为每物体采样点数，`E` 为物体数。

| 键名 | loader 消费的形状 | 语义 |
| --- | --- | --- |
| `cam_c2w` | `[F, 4, 4]` | 每帧 camera-to-world 齐次变换；loader 求逆得到 w2c |
| `intrinsic` | `[3, 3]` | 像素单位的相机内参 K；loader 复制成 F 帧，当前接口对应固定 K |
| `camera_3d_pred_{key}_sampled` | `[F, P, 3]` | 与实体 key 对应的三维点集轨迹；按当前默认转换逻辑，输入位于**各帧相机坐标系** |

源码注释采用 `[81, 500, 3]` 示例约定，推理入口默认 `num_frames=81`、`fps=16`、`max_area=480*832`、`max_entities=2`。PointNet 沿 P 维聚合，没有把 P 硬编码为 500；因此 500 应成为本系统初始兼容导出预设，而不能声称是模型唯一合法点数。`max_entities` 可配置，但多于默认实体数的效果和资源开销仍须验证。[字段读取与示例形状](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/dataset_from_npz.py#L74)、[默认参数](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/infer.py#L30)、[PointNet/轨迹编码器](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/models/pcd_controller.py#L80)。

开启默认 `normalize_object_to_first_frame=True` 时，loader 实际执行：

```text
p_camera0(t) = w2c(0) · c2w(t) · p_camera_t(t)
```

因此本系统如果保存世界坐标物体点 `p_world(t)`，官方文件适配器应先输出：

```text
p_camera_t(t) = inverse(cam_c2w[t]) · p_world(t)
```

不能把世界坐标点或已转到首帧相机系的点写入该键后，又让默认 loader 重复转换。若选择直接传入首帧相机坐标，必须同步关闭此转换并记录导出约定。[实际变换函数](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/dataset_from_npz.py#L15)。

### 3.3 提示词与实体顺序

`full_prompt.json` 存全局提示词；`prompt-didi.json` 的必要映射为：

```json
{
  "objects": {
    "0": "第一个物体的描述与运动提示词",
    "1": "第二个物体的描述与运动提示词"
  },
  "scene_description": "场景描述"
}
```

上述中文是本系统的结构示意，非官方示例内容。官方 loader 对 `objects.keys()` 进行字符串排序，用同一 key 读取 `camera_3d_pred_{key}_sampled`。`object_number` 可读但不是示例必需项，代码随后按成功加载的轨迹数重新计数。适配器必须生成明确的 `project_object_id → export_entity_key` 映射，防止提示词和轨迹错配；不能依赖界面临时排序。缺少实体轨迹不应任由官方 loader 用零值补齐或降级，应在本系统导出校验时阻止。[官方实体 JSON](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/assets/demo_samples/104378-666197758_medium_part01/prompt-didi.json)、[排序、补齐和计数逻辑](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/dataset_from_npz.py#L104)。

### 3.4 实际注入模型的内容

相机位姿不是独立轨迹 JSON 直接送进模型：官方将 K、w2c 转成射线 embedding，通道顺序为 `[direction, origin × direction]`，最终形状 `[B, 6, F, H, W]`；同时输入点云渲染视频条件。相机 embedding 内还有首视角处理、中心化和位移缩放，应复用固定版本官方函数，而非凭「Plücker」名称自行拼接不同顺序。[射线构造与相机归一化](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/camera.py#L7)。

物体输入 tensor 为 `[B, E, F, P, 3]`，另带逐实体提示词和 `num_entities`。公开实现以 PointNet 编码点集后与文本特征融合。这意味着包围盒中心和朝向属于编辑层数据，需要进一步生成物体点集轨迹，不能直接将一条中心曲线宣称为完整的官方输入。[模型输入校验与接口](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/pipelines/pipeline_pcd.py#L449)、[轨迹编码实现](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/models/pcd_controller.py#L133)。

**注意 render mask 的语义。**官方 README 对 `render_mask.mp4` 的文字描述较简略，而 `src/pointcloud.py` 实际以 `zbuf == -1` 生成空洞 mask：1 表示无有效点云渲染，首帧设为 0。它不能直接替换成 SAM 物体二值分割图。联合物体框预处理是否还会额外修改此 mask，公开源码中尚未找到足够证据；实施时须检查官方示例视频并完成条件渲染对照。[mask 生成](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/pointcloud.py#L150)。

## 4. 坐标、尺度、投影必须形成显式契约

SymphoMotion 点云渲染函数明确把输入 w2c 标为 OpenCV 约定，随后将 c2w 的前两列翻转以适配 PyTorch3D。因此应区分：编辑器世界坐标、OpenCV 相机坐标（右、下、前）、PyTorch3D 渲染坐标、对象局部坐标。不要因各处都叫 `extrinsic` 就直接互拷矩阵。[SymphoMotion 渲染转换](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/pointcloud.py#L75)。

建议每个 project 显式记录 world 原点/轴向/尺度单位、camera convention、矩阵方向、参考相机 c2w、K、K 对应图像宽高、图像裁剪/缩放变换、重建算法及其版本。当前数据设计建议采用首帧 OpenCV 相机系作为编辑世界系，即 X 向右、Y 向下、Z 向前，界面升高方向 `world_up=[0,-1,0]`；这是本系统选定的统一约定，其他后端输出仍必须显式转换。对象的正面法向是对象局部 `+X`，不等于相机光轴 `+Z`。只选一个正面法向无法唯一确定完整局部旋转，还需要上方向/剩余轴的确定规则；正面与上方向共线时应要求修正。

**已确认的适配风险：**当前 SymphoMotion loader 会 resize 输入图与视频，但对 K 的「调整」实际是原值赋回，没有尺寸比例缩放。因此本系统应在导出阶段计算与最终推理分辨率严格一致的 K，并校验参考图、mask、渲染视频尺寸。不要先导出原始 K，再期待 loader 自动修正。[resize 与 K 处理](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/dataset_from_npz.py#L41)。

## 5. 已确认：SymphoMotion 相机轨迹从参考视角起录

SymphoMotion 论文要求目标相机第一帧对齐参考相机，并且公开 loader 将条件视频第 0 帧替换为参考图。用户已据此确认 **D05-B：用于 SymphoMotion 的相机轨迹必须回到参考图相机位姿后录制**。预览探索仍可自由移动；正式录制开始前恢复参考相机的完整位置与旋转，并使用与参考图一致的 K，随后进入 3 秒倒计时。任意起始视角的绝对路径不应在维持原参考图时被标记为兼容。[论文 3.2](https://arxiv.org/html/2604.03723v1#S3.SS2)、[首帧替换实现](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/src/dataset_from_npz.py#L52)。

导入历史相机轨迹时也必须检查首帧位姿、内参和参考帧关系。首帧不匹配的轨迹可作为未兼容草稿保存或预览，但不能自动成为可直接导出的相机轨迹。相对重定位副本或重新生成参考帧均不是当前默认流程；如未来增加，应独立明确其空间变化和重新校验要求。

## 6. ViewCrafter：可借鉴部分与格式边界

### 6.1 三维表示

官方 `viewcrafter.py` 通过 DUSt3R scene 获取相机姿态、内参/焦距、深度和 `get_pts3d()` 点图，并将几何与图像颜色送入点云渲染器；还会导出 `pcd0.ply` 等文件。单图点云主要覆盖可见表面，不应描述成完整封闭模型。实现会根据参考相机、中心像素深度和 elevation 变换世界坐标，因此不同重建后端的 PLY 不能不带变换信息地混用。[点图提取与重定位](https://github.com/Drexubery/ViewCrafter/blob/97cdb8634b28708cbd50912d57c52f23c5ffbf09/viewcrafter.py#L109)、[世界坐标变换](https://github.com/Drexubery/ViewCrafter/blob/97cdb8634b28708cbd50912d57c52f23c5ffbf09/utils/pvd_utils.py#L506)。

本系统建议保留「点云 + 像素到点索引/点图 + 深度 + 参考相机」。只有 PLY 时未必能可靠地将 SAM mask 映射回每个三维点。对象点索引、稳定采样点 ID 和归属置信信息也应独立保存。

### 6.2 官方 TXT 轨迹

`single_view_txt` 的轨迹文件共三行，依次是 `d_phi`、`d_theta`、`d_r` 序列，官方文档要求各序列从 0 开始，每行 2–25 个值；实际 loader 按三行读取并插值。它是围绕指定中心的参数化运动，不是任意 `[F,4,4]` 相机姿态文件。`single_view_target` 另支持 `d_x/d_y` 平移参数。[官方格式说明](https://github.com/Drexubery/ViewCrafter/blob/97cdb8634b28708cbd50912d57c52f23c5ffbf09/docs/render_help.md)、[TXT 解析](https://github.com/Drexubery/ViewCrafter/blob/97cdb8634b28708cbd50912d57c52f23c5ffbf09/viewcrafter.py#L143)。

用户要求的自由朝向、roll 和任意平移不能无损投影到上述三行 TXT。可行适配方式是在其渲染入口使用完整 c2w 序列与 K 创建相机；这属于新增适配器，不是现成 CLI 已支持。参考其 `generate_traj` 和坐标转换即可，不应将有限参数序列作为本系统唯一轨迹存储。[完整姿态到渲染相机](https://github.com/Drexubery/ViewCrafter/blob/97cdb8634b28708cbd50912d57c52f23c5ffbf09/utils/pvd_utils.py#L234)。

## 7. Uni3C：统一三维世界与相机文件

官方 `cam_render.py` 用 Depth-Pro 估计深度和焦距，以 `K^-1 [u,v,1] depth` 构造点云，再转换至世界坐标，输出 `pcd.ply`。相机文件 `cam_info.json` 包含 `intrinsic`（3×3）、`extrinsic`（F×4×4 **w2c**）、`height` 和 `width`；它与 SymphoMotion NPZ 的 c2w 方向相反。[点云与相机文件生成](https://github.com/alibaba-damo-academy/Uni3C/blob/75ed6e2180316b7f07398e4e88ea8bdba3e6970c/cam_render.py#L94)。

人体联合控制的 `alignment.py` 读取人体关节点及 SMPL-X 顶点，通过刚性配准、尺度和重力方向调整与场景对齐；保存 `env_pcd.ply`、`cam_info.json`，渲染人体、手部与环境条件。这里的动态主体是有专门人体表示的 SMPL-X，不能把它的接口描述成所有物体只需一条中心轨迹即可驱动。[人体对齐与渲染](https://github.com/alibaba-damo-academy/Uni3C/blob/75ed6e2180316b7f07398e4e88ea8bdba3e6970c/alignment.py#L244)。

**本系统的 4D 设计：**时间 `t` 下的场景由静态背景点云和各对象经 `T_world_object(t)` 变换的点集共同求值。用户已确认 D04-A：物体轨迹保存完整 SE(3) 位姿，即位置与旋转；不能仅保存中心曲线或默认用路径切线替代录制朝向。主存储可为「静态点云 + 对象点索引/局部点 + 带时间戳的变换序列」，需要时缓存逐帧点云。此定义是本系统设计，并非声称 ViewCrafter/Uni3C 提供统一的 `.4d` 文件格式。初期它是几何运动预览；非刚体变形、遮挡后新表面和生成模型最终像素效果不能由刚体点云自动保证。

用户已确认 D06-A：允许将对象设为静止，也允许整个场景保持静态后直接进行相机控制。静止对象使用恒定的 `T_world_object(t)`；整个静态场景的时间求值返回不变几何，不要求用户先录制无意义的物体轨迹。纯相机导出关闭物体注入；若仍将静止物体纳入实体条件，则必须生成有效的恒定世界点轨迹，并随运动相机逐帧转换坐标，不能用全零轨迹充当静止。

## 8. 导出适配器的最小责任

1. 固定重建世界坐标、参考相机、K 与时间轴；把浏览器/渲染器坐标转换至目标模型约定。
2. 根据物体初始包围盒中心和所选正面构造局部点云；按已确认的完整 SE(3) 方案保存每帧位置与旋转，并以稳定采样的点生成每帧世界点。显式静止对象采用恒定位姿，整场静态时允许纯相机导出。
3. 用统一的时间采样网格生成物体与相机序列，按原时间戳插值保留速度变化，不能未经说明地按弧长重新均速采样。
4. 将世界物体点转成每帧 OpenCV 相机点，写 NPZ 和实体提示词映射；同时沿相机路径投影物体点、计算二维框、渲染所需条件视频。
5. 保存导出参数、有效帧数、帧率、首尾采样时刻、几何/轨迹版本、各产物 hash。81 帧、16 fps 的末帧时间为 80/16=5 秒，按每帧占一帧时长编码的视频名义时长为 81/16 秒；两种时间概念应分别记录。
6. 检查所有产物的 F、H、W、K、实体映射、有限数值和矩阵有效性一致；不把写盘成功当作模型兼容验证。

## 9. 实施前仍须验证的事项

| 项目 | 当前证据/缺口 | 完成条件 |
| --- | --- | --- |
| 官方 NPZ 样本实值 | 已核实 loader 与 Git LFS 指针；选定示例约 114 MB，本次没有下载其二进制内容 | 读取正式样例的实际 key、dtype、范围及帧数；与适配器产物对比 |
| 联合 bbox 条件预处理 | 论文说明投影点拟合二维框；公开目录未发现完整交互器及联合框生成流水线 | 核对官方视频框的颜色、线宽、对象映射、mask 含义和遮挡规则；跑一次官方样例和一次自制简单样例 |
| 新导出与权重兼容 | 已确认代码契约，未加载权重推理 | 静态场景+静态物体、纯相机运动、纯物体运动、相机物体联合运动逐项验证 |
| 可变 K/焦距 | NPZ loader 使用单一 K | D17-A 已确认每条轨迹固定 K／FOV／畸变；非零畸变保留预览但标待适配 |
| 参考视角起录 | 用户已确认 D05-B；尚未实现恢复和校验 | 验证录制前恢复参考 c2w 与 K、倒计时及首帧记录一致；导入轨迹首帧不匹配时不得标为可直接导出 |
| 多对象规模 | 官方默认 2 个，代码可配置 | 明确首期导出上限；更多对象用独立验证结果决定，不静默丢弃 |
| SAM 版本 | 用户已确认采用 SAM；SymphoMotion 论文采用 SAM2 | 在实现选型中固定 SAM 具体版本和 mask 映射规则 |

本次采用 agent-reach 技能的官方源码检索路径；GitHub CLI 未登录，改用公开官方网页和 GitHub 原始源码。结论均基于上文直接链接，没有采用第三方教程推测注入格式。
