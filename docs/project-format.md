# Project 文件构成与 JSON README

2026-09-09：v0.6 已为命名运行配置增加 execution 草稿，保存 ENVNAME、脚本文件名和全文；新推理请求采用 API v2，冻结内层推理 argv 与外层 sbatch 执行快照。历史 API v1 请求保持原样，只能查询／导出，见 [Slurm 数据扩展](slurm-execution.md#api-v2-与兼容性)。

2026-09-08：v0.5 已实现 generation v1 扩展，保存命名配置、模型定义、命令草稿及提交记录；旧项目缺少此字段时初始化默认配置。原型备份与正式 JSON 的基础导入均保留该扩展，格式见 [生成数据](generation-panel.md#项目数据扩展)。既有 export_profiles 继续仅表示条件包导出。

正式项目格式版本保持 `0.2.0-draft`，原型备份封装保持 version 2，generation 扩展保持 version 1；应用版本为 v0.6。旧运行配置缺少 execution 时补默认 Slurm 草稿，不改写历史提交快照。以下是本系统的持久化契约，不是 SymphoMotion、ViewCrafter 或 Uni3C 的原生格式。浏览器已实现独立时间片段、固定镜头参数、旧工作区迁移及生成配置；正式服务端资产存储、路径解析和模型条件导出仍需实现，不能将原型备份当作上游推理输入。

本次更新的已确认约定是：每个物体独占一行并行时间轨道；原始轨迹与时间片段分开；移动片段改变开始时间，拖动边界伸缩完整运动；相机参数由项目和轨迹共同持久化。**D17-A：每条相机轨迹使用固定、可编辑的 K／FOV／畸变；D18-B：物体虚拟相机绑定物体正面；D19-A：整段按比例变速，移动只改开始时间。**

## 1. 存储位置与环境变量

**已确定的部署约束：** 应用运行在浏览器中，前后端分离，服务端部署于 CE 登录节点，通过 Slurm 调度计算节点。项目与模型所用的长期路径由**服务端**解析；浏览器不直接读取服务器绝对路径。浏览器选中的本机文件先上传，不能把 `C:\\...` 或 `/Users/...` 直接作为 CE 可读路径。

建议服务端配置：

```dotenv
DIFFUSIONCONTROL_PROJECTS_ROOT=/ce/shared/diffusioncontrol/projects
DIFFUSIONCONTROL_ASSETS_ROOT=/ce/shared/diffusioncontrol/assets
DIFFUSIONCONTROL_MODEL_ROOT=/ce/shared/diffusioncontrol/models
DIFFUSIONCONTROL_CACHE_ROOT=/ce/shared/diffusioncontrol/cache
```

上述是示意路径，不声称 CE 集群已有这些目录。Slurm 已确定；实际挂载点与服务运行配置仍需落实。前两项用于持久化文件引用，模型目录和缓存目录由服务配置管理，项目不得保存凭据。

项目 JSON 中所有资产路径统一采用 `PathRef`：

```json
{"root": "projects", "relative_path": "demo_scene/reference/first_frame.png"}
```

解析规则：`projects` 对应 `DIFFUSIONCONTROL_PROJECTS_ROOT`；`assets` 对应 `DIFFUSIONCONTROL_ASSETS_ROOT`。`relative_path` 使用 `/`，不含盘符、开头 `/` 或 `..`。不存在的资产字段用 `null`，数组为空用 `[]`；禁止把空字符串解释为根目录。最终规范化路径（包括符号链接解析）必须位于相应授权根目录之内。

**[待定 D08]** 建议项目母路径在服务端 projects root 下选择／输入相对目录；新建 API 接受 `{name, parent_relative_path}`。如果想允许任意服务器目录，应增加明确配置的 root ID，不能直接接受浏览器传来的任意服务器绝对路径。添加服务器母目录与上传本机母目录是两种入口：前者服务端扫描，后者上传后按项目结构重建。

项目目录整体迁移到另一个根下且目录内相对布局不变，只需改环境变量；如目录在根下的位置发生变化，导入器根据旧 `directory` 前缀重写该项目内引用。预设从 assets 应用时复制所用版本到项目，另留来源引用，避免删除全局预设后项目失效。

## 2. 目录结构

```text
projects/                                  # PROJECTS_ROOT
└── demo_scene/
    ├── project.json                        # 唯一项目索引，由系统维护
    ├── reference/
    │   └── first_frame.png                 # 导入或生成并确认的首帧
    ├── geometry/
    │   ├── scene.ply                       # 静态彩色点云，适合交换／预览
    │   ├── scene.meta.npz                  # 点ID、像素对应、有效性、实例归属等
    │   ├── depth.npz                       # 对齐首帧的深度与有效性
    │   └── background.indices.npz          # 静态背景点索引
    ├── objects/
    │   └── obj_001/
    │       ├── 小车.png                    # 2D mask，默认按物体名称命名
    │       ├── 小车_mask_preview.png       # 原图裁剪+mask 叠加缩略图
    │       └── points.indices.npz          # scene 中的稳定点ID／索引
    ├── trajectories/
    │   ├── camera/
    │   │   ├── demo_scene_camtrj.json      # 当前相机轨迹
    │   │   └── demo_scene_camtrj.png       # 独立预览图
    │   └── objects/obj_001/
    │       ├── 小车_objtrj.json             # 当前物体轨迹
    │       └── 小车_objtrj.png              # 独立预览图
    ├── scene4d/
    │   ├── scene4d.json                    # 4D组成、绑定版本与时间轴
    │   └── cache/                         # 可删除并重建的逐帧／分块缓存
    ├── history/                           # 旧轨迹和项目索引快照
    ├── exports/symphomotion/run_001/       # 目标适配器生成，非手写维护
    └── .recovery/                         # 尚未完成保存的录制会话

assets/                                    # ASSETS_ROOT
├── camera_trajectories/<preset_id>/
│   ├── preset.json
│   ├── trajectory.json
│   └── preview.png
└── object_trajectories/<preset_id>/
    ├── preset.json
    ├── trajectory.json
    └── preview.png
```

仅创建项目时，只有项目目录与 project.json 是必需的；首帧可为空。进入后续功能时再按门禁要求生成文件。路径扩展名是本系统建议：轨迹 JSON、预览 PNG，数值量较大时可迁移到带 manifest 的 NPZ 等格式，必须升级格式版本。

文件名按用户要求默认为 `<项目名>_camtrj.*` 和 `<物体名>_objtrj.*`。显示名可为中文；非法文件名字符经明确规则清理，同名物体以 ID 子目录隔离。替换不静默覆盖历史版本，改名后由系统更新引用，禁止靠文件名关联身份。

上述“当前轨迹”路径可作为用户可读的当前版本副本。服务端资产注册表必须把 `(asset_id, revision)` 解析到不可变的历史文件或内容寻址文件；提交任务时冻结输入快照。长时间作业不得只记住这个可能被下一次录制替换的当前路径，必须读绑定版本并校验 hash。小型部署也可在提交时复制输入到作业目录实现该约束。

## 3. Project 顶层字段

参见 [空项目示例](examples/project.empty.json) 与 [完整结构示例](examples/project.populated.json)。示例没有真实资产，不能直接当作可运行项目。

| 字段 | 类型 | 要求与含义 |
| --- | --- | --- |
| schema_version | string | 必需，项目格式版本 |
| project_id / name | string | 必需，稳定 ID／显示名称 |
| directory | PathRef | 必需，项目目录相对配置根的路径 |
| created_at / updated_at | ISO 8601 string | 必需，UTC 时间 |
| revision | integer | 每次有效保存递增，防止并发覆盖 |
| reference | object | 首帧资产、尺寸、哈希、全局 prompt、来源和生成配置；image 可为空 |
| coordinates | object | 世界轴、长度单位、世界上方向及参考系 ID |
| reference_camera | object/null | 首帧标定 ID／版本、完整 K、图像尺寸、派生 FOV、畸变模型和五系数、c2w 及来源 |
| scene3d | object | 点云、深度、像素映射、背景索引、状态和几何版本 |
| objects | array | 所有已确认分割实例 |
| timeline | object | 公共秒单位、fps、frame_count、duration_seconds；物体行并行，片段边界策略见 6.3 |
| scene4d | object | manifest 路径、状态和依赖版本 |
| camera_control | object | 当前相机轨迹、独立 clip、与轨迹一致的 intrinsics 镜头参数快照、历史及起始策略 |
| recording_preferences | object | 键鼠配置、原始采样率、倒计时配置，带配置版本 |
| export_profiles | array | 目标模型、适配器／上游版本和导出参数 |
| generation | object | 可选 v1 扩展：当前模型、命名运行配置、自定义模型 schema、推理命令、Slurm execution 草稿及提交快照；旧项目缺字段时补默认配置 |
| provenance | object | 可选，导入来源与迁移记录，不保存秘密信息 |

资产 `AssetRef` 建议结构为 `{path, status, revision, sha256, source_revisions, error}`。不适用的字段可省略；缺失资产 `path:null,status:"missing"`。哈希必须是对实际文件计算的值，示例中的 `null` 不代表已经做了完整性验证。

### 3.1 v0.2 录制控制配置

`recording_preferences.version=2`。平移采用 `speed_mode:"fixed"` 与可设置的 `move_speed`（场景单位／秒）；`translation_basis` 和 `vertical_basis` 均为 `control_camera_local`，即 WASD、Shift、Control 全部沿当前控制参考相机的局部轴。相反方向输入抵消，多方向合成归一化；`release_behavior:"stop"` 表示松开全部平移键立即停止，`mouse_buttons_change_speed:false` 表示鼠标左右键不改变速度。v0.2 不再保存或使用旧的 `initial_speed/min_speed/max_speed/acceleration/deceleration` 控制配置。

物体录制遵循 D18-B：`object_camera_binding:"object_front"`，虚拟相机前方为物体局部 `+X`、上方为 `+Z`，记录锚点仍为 bbox 中心；相机录制直接使用相机自身局部轴。横滚、鼠标灵敏度、倒计时和采样率继续独立保存。轨迹 `source.control_preferences` 使用录制当时的配置版本；本版示例统一展示 v2 配置，迁移真实旧记录时保留其历史 provenance，不能把 v1 记录伪称为 v2 控制产生。

## 4. 坐标系与相机约定

为减少与 SymphoMotion 的变换歧义，建议内部世界坐标系 `reference_camera_opencv`：

- 右手系，世界原点位于首帧参考相机光心。
- 世界 +X 向首帧图像右方，+Y 向下，+Z 向前；默认世界上方向 `[0,-1,0]`。该“上”是图像定义，不声称已估计真实重力。
- 首帧参考相机 `T_world_from_camera(0)=I`。导入点云的外部世界系必须保存到本系统世界系的完整变换和尺度。
- 位置长度默认 `scene_unit`，尺度类型 `relative`；单目重建不能未经标定宣称是米。
- 位姿使用列向量：`p_world = T_world_from_local * p_local`。JSON 矩阵外层是行，显式使用 `c2w`／`w2c` 字段，不使用含糊的 `pose` 存相机矩阵。
- 旋转使用归一化四元数 `[x,y,z,w]`，文件记录 `quaternion_order:"xyzw"`。不靠欧拉角猜旋转次序。
- K 为像素单位 `[[fx,0,cx],[0,fy,cy],[0,0,1]]`；同时保存图像宽高、像素中心规则、裁剪／缩放变换和畸变处理状态。

浏览器渲染引擎若使用 +Y 向上、相机看 -Z，使用 `B=diag(1,-1,-1)` 在世界与相机两端转换：`p_viewer=B*p_world`，`T_viewer=H*T_c2w*H^-1`，`H=diag(1,-1,-1,1)`。物体局部轴转换另按对象契约处理，不能把这个相机双端公式盲用到所有数据。原始保存坐标始终保持规范世界系。

### 4.1 相机标定与镜头参数的持久化

每份 `CameraCalibration` 包含 `calibration_id`、不可变 `revision`、`model:"pinhole"`、`image_width`、`image_height`、`pixel_centers:"integer_coordinates"`、完整 `intrinsic[3,3]`、派生 `fov`、`distortion` 和 `source`。`reference_camera` 使用相同字段，另存首帧 `c2w`。不能只保存一个 FOV 数字后丢弃 K、图像宽高或畸变。

K 是投影的权威值；FOV 是方便界面显示及核验的派生数据，保存单位 `degrees` 与 `derived_from:"intrinsic_and_image_bounds"`。本版 K 无 skew，`fx,fy>0`，最后一行为 `[0,0,1]`。像素中心编号为 `0..W-1`、`0..H-1`，图像边界在 `-0.5` 与 `W-0.5`／`H-0.5`，因此：

```text
fov_x = degrees(atan((cx+0.5)/fx) + atan((W-0.5-cx)/fx))
fov_y = degrees(atan((cy+0.5)/fy) + atan((H-0.5-cy)/fy))
# 居中的主点 cx=(W-1)/2、cy=(H-1)/2 时：
fov_y = degrees(2*atan(H/(2*fy)))
```

保存的 FOV 与上述结果不一致时提示错误，不能任选一个覆盖另一个。界面改变 FOV 时通过明确的焦距／像素纵横比规则更新 K，再重新计算两个 FOV。视口 CSS 大小变化只改变显示布局，不改参考图尺寸、K 或已保存镜头参数。裁剪／缩放图像则需要显式更新 K 并记录变换。

畸变对象使用 `model:"none"` 或 `model:"brown_conrady_5"`，明确 `coefficient_order:["k1","k2","p1","p2","k3"]`，`coefficients` **始终是五个有限数值**。`none` 必须对应 `[0,0,0,0,0]`；再用 `state:"assumed" / "estimated" / "calibrated"` 表明是原型假设、模型估计还是标定结果。未知畸变不可被解释为全零。其他模型或系数数量需要显式适配，不可截断。若浏览器或上游暂未支持非零畸变，应显示该能力限制并阻止把不一致投影当作已验证结果；原始系数仍需保留。

首帧标定与后续镜头设置分开。修改待录镜头的参数不会悄悄改写首帧标定或已有点云。当前镜头轨使用 `camera_control.intrinsics`，相机轨迹使用 `camera_intrinsics`；二者必须有相同 `intrinsics_id`、`revision` 和同一份参数内容。轨迹内包含完整快照，使单独导出的 JSON 仍可解释。历史轨迹保留当时快照，应用历史时检查它与当前参考图、输出尺寸及目标导出能力的兼容性。

固定镜头的公共示例：

```json
{
  "intrinsics_id": "lens_camera_001",
  "revision": 1,
  "mode": "fixed",
  "time_domain": "trajectory_local_seconds",
  "calibration": {"calibration_id": "calibration_reference_001", "revision": 1}
}
```

上面的 `calibration` 仅缩写展示身份；实际文件必须如 [相机轨迹示例](examples/camera.trajectory.json) 那样嵌入完整标定。项目当前镜头与轨迹快照的 ID／版本相同但参数不同，是无效数据。

**已确认 D17-A：** 每条相机轨迹使用 `mode:"fixed"`，整个片段中 K／FOV／畸变保持不变，不提供镜头关键帧。用户可编辑这些固定参数并预览，参数改动生成新的镜头版本，保存时同步项目当前镜头与相机轨迹快照；历史版本继续保留。非零畸变可编辑并持久化，但当前预览／目标导出若未实现畸变适配，必须提示限制，不能把未畸变的渲染称为对应的准确效果。导入动态镜头数据应提示本版不支持，不可只保留首帧参数。

### 4.2 从 mask 关联物体点云

对于深度图反投影点，保留其来源像素 `(u,v)`、深度有效性和点 ID。若深度定义为相机 Z 深度：

```text
p_camera = z(u,v) * inverse(K) * [u,v,1]^T
p_world = T_world_from_reference_camera * p_camera
```

射线距离深度需先转换，不能直接代入上述公式。2D mask 通过**同一张参考图**的像素对应选择点，允许边缘去噪和连通性清理，但需可预览／修正并记录处理参数。

外部点云没有像素对应时，需要有效 K、外参、投影和深度遮挡检查；所有投影在 mask 内的点不能无条件都视为物体，尤其不能把后方背景划给前景。无法可靠映射时显示待校准，不自动生成看似确定的物体 bbox。

至少保存点 ID、XYZ、RGB、有效性／置信度、源图像像素或可再投影信息、instance ID。PLY 只承担基本几何交换；额外字段可在 `scene.meta.npz` 中按相同点顺序存储，点序与版本变化必须使索引缓存失效。

## 5. Object 字段与 bbox 正面

| 字段 | 含义 |
| --- | --- |
| object_id / name / color | 稳定身份、显示名称和 2D 实例颜色 |
| prompt | 可编辑实例提示词，独立于全局场景 prompt |
| segmentation | 方法 SAM、具体模型版本、mask、缩略图、原图尺寸、交互提示、置信度／用户确认状态 |
| geometry | 点索引／子点云引用、点数、关联的 scene3d 版本、校验状态 |
| bbox | AABB 或 OBB、世界中心、局部半尺寸、bbox→world 旋转、可选派生八角点 |
| front | 已选面 ID、世界法向、平面上一点、平面方程、上方向及用户确认记录 |
| initial_pose | 以 bbox 中心为原点的物体局部坐标系到世界的平移和旋转 |
| motion | `unassigned / static / trajectory`，当前源轨迹及预览、历史 |
| clip | 独立时间片段；引用源轨迹 ID／版本，记录全局开始时间、播放时长、时间映射与起止 hold；无当前运动轨迹时为 null |

**bbox 与物体坐标系分开：** bbox 的面 ID 固定为 `positive_x / negative_x / positive_y / negative_y / positive_z / negative_z`，相对于 bbox 自身的轴。选中 bbox 的 `negative_z` 面也可以成为物体语义上的 +X，不能因此把 bbox 六面的身份重命名。

建议六面配色：+X 红 `#E53935`、-X 青 `#00ACC1`、+Y 绿 `#43A047`、-Y 品红 `#D81B60`、+Z 蓝 `#1E88E5`、-Z 黄 `#FDD835`；配有固定面 ID 标签和图例。2D 物体颜色与这组六面颜色含义不同。

对 bbox 中心 c、bbox 旋转 R、半尺寸 h，选中的面轴 j 和符号 σ：

```text
n_world = sigma * R[:, j]           # 该面朝外单位法向
face_point_world = c + n_world * h[j]
plane: n_world · p + d = 0
d = -n_world · face_point_world
```

保存 `face_id`、`normal_world`、`point_world`、`plane_world:[nx,ny,nz,d]`。这就是用户要求的“x 轴正向法平面”：选定的 bbox 面法向定义物体局部 +X，物体原点仍在 bbox 中心，而非面中心。

只选正面还不能决定完整姿态。建议 `x=n_world`；把所选世界上向量 u 投影到与 x 垂直的平面，`z=normalize(u-dot(u,x)*x)`，`y=z×x`；物体旋转矩阵按列 `[x,y,z]`。如正面与 u 平行，要求用户从剩余面选择上方，不能除以零或静默改变朝向。保存最终上方向和旋转。自动 bbox 拟合可用 AABB 或 OBB，待 D07。

**已确认 D18-B：** 物体轨迹控制器的虚拟相机绑定选定正面。控制起点是 bbox 中心，前进方向为物体局部 `+X`，上方为物体局部 `+Z`；切换到不同正面后，虚拟相机前向随初始物体姿态一起改变。相机自身仍使用 OpenCV 的 `+Z` 前、`+Y` 下，因此需固定转换，不能把物体姿态四元数直接当作相机姿态。以物体局部坐标表示相机轴：右方 `-Y`、下方 `-Z`、前方 `+X`。观察用跟随偏移可以独立设置，但不能改变记录轨迹的 bbox 中心锚点。

## 6. 统一轨迹格式

[相机示例](examples/camera.trajectory.json) 和 [物体示例](examples/object.trajectory.json) 使用相同头部结构：

| 字段 | 约定 |
| --- | --- |
| schema_version / trajectory_id / revision | 文件契约与不可变版本身份 |
| kind | `camera` 或 `object` |
| target_id | 当前绑定项目内目标；通用 preset 可为空 |
| coordinate_frame / length_unit | 必須明确，不能假定外部轨迹单位 |
| time_unit / duration_seconds | 秒与**源轨迹**有效运动时长；不是片段在公共时间轴上的长度 |
| rotation_representation / quaternion_order | quaternion / xyzw |
| samples | 从 0 起严格递增的源轨迹局部 `t_seconds`、`position_world`、`quaternion_xyzw`，可选 `velocity_world` |
| source | 录制或导入来源、源版本、控制配置和录制采样率 |
| binding | 参考图／scene3d 版本／object 初态／scene4d 版本等依赖 |
| interpolation | 平移 linear、旋转 slerp；任何平滑另存处理版本 |
| camera_intrinsics | 相机轨迹必需：与项目当前镜头同 ID／版本的完整固定参数快照，包含 K／分辨率／FOV／五系数畸变；D17-A 已确认 |

轨迹样本的世界位置和姿态是权威数据，速度可派生以核验和着色；记录速度不能替代时间戳。最少含首末有效时间点，静止或原地旋转也有意义。文件格式不限定原始采样点数。

输出采样时线性插值位置，四元数采用符号一致化和 slerp，不能直接线性插值四元数四个数。不默认平滑、匀速化或裁剪，以免丢失用户绘制的速度变化。处理后轨迹保留原始版本并记录参数。

### 6.1 物体刚体变换

设初始物体到世界变换为 `T_o(0)`，初始物体点为 `p_world(0)`，记录轨迹为 `T_o(t)`：

```text
p_object = inverse(T_o(0)) * p_world(0)
p_world(t) = T_o(t) * p_object
```

不得直接将初始世界点乘以 `T_o(t)`，否则中心平移会被重复叠加。首个位置必须等于初始 bbox 中心，首个旋转必须等于已确认的物体初始旋转。本版本用户已选 D04-A：平移和旋转都记录。

### 6.2 预设重用

预设保存自身的局部原点、初始朝向、单位和时间。物体预设可先计算相对初态的变换：`Delta(t)=inverse(T_src(0))*T_src(t)`，再应用 `T_dst(t)=T_dst(0)*Delta(t)`。默认保持原始长度，若用户选择按 bbox 缩放，只缩放相对平移，不能缩放旋转矩阵；相关比例显式写入绑定记录。待 D12 确认尺度策略。

相机预设也需坐标转换、时间与首帧校验。**D05-B 已确认：用于 SymphoMotion 的相机轨迹从参考相机位姿开始。** 导入预设不能跳过这一要求；不符合时显示不兼容，并让用户显式重锚定后查看变化，或选其他轨迹。原始导入文件不可被悄悄修改。

### 6.3 独立轨道、时间片段与速度映射

每个已分割物体拥有独立的一行时间轨道，相机另占一行；各行共享同一全局时间 `g` 并行播放。物体在列表中的顺序只决定轨道显示顺序，不改变运动时间，也不把前一个物体的时长累加给后一个物体。静止物体显示贯穿公共时间轴的静止行，待定义物体显示空行，二者都不伪造运动片段。

首阶段每个动态目标使用一个当前片段，字段位于 `objects[].clip` 和 `camera_control.clip`，不能混入源轨迹 `samples`。浏览器原型分别映射到 `SceneObject.clip` 与 `Project.cameraClip`。片段基本结构：

```json
{
  "clip_id": "clip_obj_001",
  "revision": 1,
  "trajectory_id": "trajectory_obj_001",
  "trajectory_revision": 1,
  "start_time_seconds": 1.0,
  "duration_seconds": 2.5,
  "time_mapping": {"mode": "linear"},
  "before_start": "hold_first_pose",
  "after_end": "hold_last_pose"
}
```

设源轨迹时长为 `D_src`，片段全局开始时间为 `s`，播放时长为 `D_clip>0`。线性映射与速度倍率为：

```text
source_time(g) = clamp((g-s) * D_src/D_clip, 0, D_src)
pose(g) = interpolate(source.samples, source_time(g))
speed_multiplier = D_src / D_clip
```

例如 5 秒源轨迹放在全局 `[1,3.5]` 秒，仍完整经过原始首末位姿，播放倍率为 `2×`；全局 2.25 秒对应源轨迹 2.5 秒。`g<s` 保持首位姿，`g>s+D_clip` 保持末位姿，因此片段外物体不会消失。相机开始前保持参考相机首位姿，结束后保持末位姿；镜头参数采用相同时间映射与端点保持规则。

移动片段主体只修改 `s`，保留 `D_clip`。拖动左边界固定右端点 `e`，令 `s'=拖动时间`、`D_clip'=e-s'`；拖动右边界固定 `s`，令 `D_clip'=拖动时间-s`。边界操作**伸缩完整轨迹，不裁剪原始样本**，不改变原始 `t_seconds`、位姿、源轨迹 ID、预览图或来源记录；原有速度起伏按时间比例保留。片段有独立 revision，修改片段后更新该版本和项目版本。

开始时间不得为负；片段长度建议最小一个输出帧间隔。界面可吸附公共帧刻度，存储仍使用秒。编辑器不得静默把越界部分截掉或改写轨迹：优先限制拖动在当前公共时间轴内；导入超长片段时要求用户扩展公共时长或明确缩短播放时长。现存源轨迹时长不受公共时长硬编码限制。

**已确认 D19-A：** 使用 `time_mapping:{mode:"linear"}` 对整条轨迹做比例变速，不提供分段速度节点。移动仅改 `start_time_seconds`，边界拖拽改变整段播放时长；源运动已有的加减速与旋转节奏按同一个时间比例缩放，不能因此重新变成匀速。分段映射输入应提示不受支持，不可当作线性映射读取。

原始轨迹 JSON 是可复用的运动资源；项目 clip 是该资源在当前项目中的时间编排。导出项目备份需同时保存二者；单独导出原始轨迹须明确它不包含当前项目的全局排期。生成逐帧条件时才按公共 `g=f/fps` 计算映射并重采样。若用户另行导出经过变速处理的轨迹，必须生成派生版本并记录源轨迹与片段版本，不能覆盖原始文件。

## 7. 4D 场景 manifest

建议主文件 `scene4d.json` 保存静态背景点索引、静态物体、动态物体点索引、初态、源轨迹与 clip 绑定、公共时间轴、坐标系及依赖版本。参见 [4D manifest 示例](examples/scene4d.json)。每个目标分别由自身 clip 把同一个全局时间映射到源轨迹时间。

```text
P(t) = P_background
     ∪ 所有 static 物体的 P_object(0)
     ∪ 所有动态物体的 T_object(source_time_object(t)) * P_object_local
```

同一个点不能同时留在背景和动态物体层，避免出现“物体移动了但原地残留一份”。mask 重叠造成多物体归属冲突时需有明确处理并让用户确认。该场景是刚体点云合成，不自动产生物体背面、移开后背景或非刚体形变。

首版无需强制保存 F 份完整点云：静态点＋变换轨迹即为可重建的 4D 表示，逐帧缓存为可选派生资产。**[待定 D09]** 如果另一个系统要求逐帧点云，则由导出器物化；不要把自定义 manifest 直接交给上游模型。

修改物体 clip 的开始时间或播放时长会改变 4D 场景，必须使旧 4D 派生资产失效并更新 `source_revisions`。只修改相机 clip 不改变物体 4D 几何，但会使相机条件及合成预览失效。场景预览、相机录制时背景播放、时间轴拖动和导出必须共用同一映射函数。

## 8. SymphoMotion 导出契约

具体证据和尚未核实项见 [兼容性报告](research-compatibility.md)。导出包至少需要首帧、全局和实体提示词、相机与物体数值条件以及渲染条件文件，而非直接使用编辑 JSON。

以下是适配器的转换职责：

1. 固定上游代码与模型 profile 版本，统一帧数、fps、输出宽高和实体映射；81 帧、16 fps、500 个稳定物体采样点属于当前参考配置，不当作所有模型的通用硬限制。
2. 使相机首姿态与首帧参考相机一致。用户可自由探索，进入 SymphoMotion 相机录制前显示“回到参考相机并准备录制”，确认定位后才允许倒计时。
3. 按公共输出时间戳，经各自 clip 映射重采样相机与物体源轨迹；生成 `cam_c2w[F,4,4]`。从已保存的固定镜头快照读取对应图像尺寸下的 `intrinsic[3,3]`，核验 FOV 和畸变；禁止导出时临时硬编码一个默认 K。非零畸变需先完成目标适配或显式去畸变并记录转换，不能丢弃系数。
4. 对每个受控物体稳定采样同一组点，按对象刚体位姿变换到各时刻世界坐标，再通过各帧 `inverse(cam_c2w[t])` 转为该帧相机坐标，生成 `camera_3d_pred_{key}_sampled[F,P,3]`。不同帧不能重新随机抽样导致点身份跳变。
5. 生成全局 prompt 和物体 key→prompt 映射。项目允许多个实例，目标 profile 的实体数量能力单独校验，超限不能默默丢对象。
6. 生成重渲染条件视频及目标代码所期望的有效性／空洞 mask。**SAM 的实例 mask 不能直接充当 `render_mask.mp4`。** 联合 bbox 条件细节仍需验证，未验证时导出标为实验性，不宣称完全兼容。
7. 写导出 manifest，保存所有源版本、缩放／裁剪变换、实体顺序、采样种子与验证结果。集群上的适配器做这些计算，浏览器只请求任务并预览结果。

## 9. 保存、迁移与校验

- 保存 JSON 前校验结构、引用、时间单调性、数值有限性、四元数归一、bbox 正尺寸、正面法向和初态一致性。
- 相机 K、mask 尺寸、点云投影与参考图必须匹配；没有图像尺寸元数据的输入不可直接 ready。
- 服务端采用临时文件写完后原子替换 project.json；更新须携带预期 revision，冲突返回可理解错误，避免两个浏览器覆盖同一项目。
- 浏览器使用资产 ID 和短期访问 URL 获取文件；短期 URL 不写入永久 PathRef。CE 任务保存输入／输出版本，旧输入上的任务结果不覆盖已更新项目。
- 录制在浏览器产生实时位姿，分块提交服务端会话；网络中断保留本地缓冲及服务端已确认部分。只有服务端完成保存并返回资产版本后 UI 才显示“已保存”。详见 [部署架构](deployment-architecture.md)。
- 预览图是轨迹的派生资产，绑定 trajectory revision；旧预览不可配在新轨迹上。预览失败标 pending/error 并允许重试。
- `.recovery` 和历史可有保留策略，但用户当前项目资产不能作为临时缓存被自动删除。
- 未知高版本格式只读或提示迁移，不静默重写。重建几何／mask 后进行依赖失效传播，规则见软件需求。
- 项目导入不执行 JSON 中的代码或 shell 命令；外部轨迹只接受已声明的结构和有限数值。GPU 任务配置由服务端允许的后端管理。

### 9.1 浏览器旧原型数据迁移

旧原型使用 `diffusioncontrol.prototype.v1` 保存 Project 数组，轨迹没有 clip，镜头 K 只在导出时临时构造。升级必须先识别来源版本、迁移，再执行新结构校验；不能把缺少新字段当作损坏项目过滤掉，随后用示例项目覆盖用户数据。

迁移规则：

1. 保留旧键原始内容，成功写入 `diffusioncontrol.prototype.v2` 后才把新键设为活动工作区；不删除旧键。新工作区使用显式 `{format,version:2,projects}` 包装。部分项目失败时报告项目名称和原因，原始备份继续保留。
2. 对每个已有当前轨迹生成 `start=0`、`duration=源轨迹.duration`、线性映射和首末 hold 的独立 clip，绑定原轨迹身份。**逐个原样保留所有源样本的时间戳、位置、四元数、ID、source、createdAt 和历史**；不能把它们重采样或拉伸到默认 5 秒。无运动轨迹的目标 `clip=null`。
3. 若迁移得到的片段超出旧公共时长，保留片段时长并标出需要扩展时间轴的迁移问题；不得为了通过校验而偷偷压缩运动。正常旧项目的片段在公共范围内，无需修改时长。
4. 对已知旧版程序化示例，可恢复当时实际使用的 1120×700、垂直 FOV 55°、居中主点与零畸变，计算 K，并标 `source:"legacy_prototype_default"`、畸变 `state:"assumed"`。对来源不明的外部图像或标定数据不得套用这一默认，保留未知状态并要求补全后再进入依赖投影的操作。
5. 当前相机轨迹及历史相机轨迹分别获得原有来源可确定的完整镜头快照。旧数据中已经存在的有效镜头元数据优先保留；不被默认值覆盖。单独导入旧轨迹但缺少镜头参数时，也须明确选择沿用当前标定后记录该操作。
6. 迁移标记必须幂等：再次读取 v2 不生成新 clip ID、不改源轨迹 ID、不重复追加历史。内存迁移成功但 localStorage 写入失败时显示未持久化状态，允许导出备份。

### 9.2 本次应覆盖的验证

测试应核验独立物体在同一全局时间得到各自的源时间；5 秒源轨迹压缩到 `[1,3.5]` 秒得到 2× 速度及正确首末 hold；移动片段不改变时长；两个边界各自保持另一端不动；预览与条件导出使用同一映射。确认拖拽后原 `samples`、源 ID 和历史没有改变，负开始时间、零长度、不支持的映射模式及错误轨迹绑定被拒绝。

相机验证覆盖项目与轨迹镜头 ID／版本／参数一致、K 与分辨率／FOV 一致、五系数完整往返、非零畸变不被清零，以及视口缩放不改变持久化参数。迁移测试至少包含有效旧项目、短轨迹、超长轨迹、已有镜头元数据、未知外部图像、重复迁移及存储失败；不能用删除失败项目来让测试通过。

## 10. 前端类型与纯函数接口提案

以下记录时间片段与镜头参数的接口设计。前端使用 camelCase，正式项目文件使用上述 snake_case，后端序列化需显式映射；不把前端备份直接冒充服务端 `project.json`。保留 `Vec3`、`Quat`、`Pose`、`Sample`；界面使用 `View='2d'|'3d'`，内部 4D 资产继续存在，控制配置为 `ControlSettings {moveSpeed,rollSpeed,sensitivity,pointSize}`。数据接口新增／扩展为：

```ts
type Mat3 = [[number, number, number], [number, number, number], [number, number, number]];
type Vec2 = [number, number];
type Distortion5 = [number, number, number, number, number];

interface CameraCalibration {
  id: string;
  revision: number;
  model: 'pinhole';
  imageWidth: number;
  imageHeight: number;
  pixelCenters: 'integer_coordinates';
  intrinsic: Mat3;
  fov: { horizontalDegrees: number; verticalDegrees: number; derivedFrom: 'intrinsic_and_image_bounds' };
  distortion: {
    model: 'none' | 'brown_conrady_5';
    coefficientOrder: ['k1', 'k2', 'p1', 'p2', 'k3'];
    coefficients: Distortion5;
    state: 'assumed' | 'estimated' | 'calibrated';
  };
  source: string;
}

interface CameraIntrinsicsTrack {
  id: string;
  revision: number;
  mode: 'fixed'; // D17-A
  timeDomain: 'trajectory_local_seconds';
  calibration: CameraCalibration;
}

type ClipTimeMap = { mode: 'linear' }; // D19-A
interface MotionClip {
  id: string;
  revision: number;
  trajectoryId: string;
  trajectoryRevision: number;
  start: number;
  duration: number;
  timeMap: ClipTimeMap;
  before: 'hold_first_pose';
  after: 'hold_last_pose';
}

// 在既有接口上增加；源轨迹 duration 和 samples.t 保持原语义。
interface TrajectoryAdditions {
  revision: number;
  cameraIntrinsics?: CameraIntrinsicsTrack; // camera 必需，object 不使用
}
interface SceneObjectAdditions { clip: MotionClip | null }
interface ProjectAdditions {
  referenceCamera: CameraCalibration | null;
  cameraIntrinsics: CameraIntrinsicsTrack | null;
  cameraClip: MotionClip | null;
}

interface MigrationResult {
  projects: Project[];
  issues: { projectId: string | null; code: string; message: string }[];
  sourceVersion: number;
  targetVersion: 2;
}

interface TrajectoryKinematics {
  velocity: Vec3;        // 规范世界系，场景单位/秒
  speed: number;
  angularVelocity: Vec3; // 规范世界系轴角速度，弧度/秒
  angularSpeed: number;
}

function makeDefaultClip(trajectory: Trajectory): MotionClip;
function validateClip(clip: unknown, trajectory: Trajectory, projectDuration: number): MotionClip;
function sourceTimeAt(clip: MotionClip, sourceDuration: number, globalTime: number): number;
function sampleClip(trajectory: Trajectory, clip: MotionClip, globalTime: number): Pose;
function trajectoryVelocity(trajectory: Trajectory, sourceTime: number): TrajectoryKinematics;
function clipKinematics(trajectory: Trajectory, clip: MotionClip, globalTime: number): TrajectoryKinematics;
function editClip(clip: MotionClip, action: 'move' | 'resize-start' | 'resize-end', time: number, projectDuration: number, fps: number): MotionClip;
function deriveFov(intrinsic: Mat3, width: number, height: number): CameraCalibration['fov'];
function validateCameraCalibration(raw: unknown): CameraCalibration;
function validateCameraIntrinsics(raw: unknown, sourceDuration: number): CameraIntrinsicsTrack;
function sampleCameraIntrinsics(track: CameraIntrinsicsTrack, sourceTime: number): CameraCalibration;
function distortNormalized(point: Vec2, distortion: CameraCalibration['distortion']): Vec2;
function pixelToCameraRay(pixel: Vec2, calibration: CameraCalibration): Vec3;
function speedColor(speed: number, maximumSpeed: number): string;
function migratePrototypeWorkspace(raw: unknown, sourceVersion: number): MigrationResult;
```

`editClip` 只返回新片段，不修改源轨迹。`sampleClip` 在现有线性位置／slerp 旋转插值外统一加时间映射；场景渲染器不再各自实现一套时间解释。`sampleCameraIntrinsics` 接收映射后的源时间，从而与相机位姿同步。新增轨迹的 `revision` 从 1 开始；迁移缺失版本的旧轨迹也设为 1，源 ID 不变。

`trajectoryVelocity` 返回源轨迹区间的线速度与世界系角速度，四元数差采用最短旋转并明确弧度单位。`clipKinematics` 按 `D_src/D_clip` 同比例缩放线速度与角速度；片段范围外保持位姿，速度为零，端点处采用片段内单侧值。轨迹波形、场景箭头与 PNG 预览共用该函数及 `speedColor`，不在三处分别计算不同的速度。

`pixelToCameraRay` 先反解 K，再对畸变归一化坐标进行有迭代上限和误差校验的逆畸变，返回规范 OpenCV 相机系中的单位射线；不能只乘 `inverse(K)` 后忽略五系数。逆解不收敛时返回明确错误，不输出看似准确的射线。`distortNormalized` 则用于正向投影校验；零畸变退化为恒等映射。这组纯数学函数放在不依赖项目状态的模块，使场景与轨迹预览共享同一投影约定。

当前轨迹与独立片段必须成对存在：`motion:'trajectory'` 要求非空 `trajectory+clip`，静止或待定义时二者为空；相机也采用同样配对。替换轨迹时新建绑定当前源 ID 的片段；历史源轨迹本身保持不变。是否连同旧 clip 恢复历史编排属于显式恢复动作，不能把别的项目的全局开始时间隐藏在通用预设里。

## v0.3 前端扩展与派生预览一致性

本次交互更新不改变 v2 时间片段与固定镜头格式。主题及卡片展开是浏览器偏好，不属于相机／物体轨迹的模型条件。控制器鼠标转向改为独立 yaw／pitch／roll，pitch 限制 ±89°；录制源姿态仍保存完整四元数，旧轨迹不被重新解释或修改。

程序化示例的 `shape` 可增加 `humanoid`，表示一个由球体头部和方块身体构成的整体实例；它仍采用普通对象的 bbox、初始姿态、mask、轨迹和提示词字段。该形状标识只描述前端演示几何，不能当作后端模型格式。示例资产升级仅作用于有明确 `demoScene` 标记的项目，需可重复执行而不重复添加人物，并保留已有对象与运动数据。几何升级后清除并重建首帧和 mask 派生缓存，记录几何版本；外部项目保持原样。

当前轨迹的预览必须由同一版本的 `samples`、clip 和镜头生成，轨迹身份／版本是预览更新依据。保存录制结果时一起更新轨迹及预览引用；UI 的放大预览按身份解析当前版本，不能使用过期快照。主题变更不重生成科学轨迹 PNG。

`demoSceneRevision` 是浏览器示例几何版本：旧示例为 1，新增人物后的版本为 2，外部项目为 null。它独立于工作区格式版本和轨迹 revision。

## v0.4 参考轴与滚轮控制的数据语义

物体参考轴由 bbox 中心与当前位姿派生；统一轴向色表只影响编辑显示，不改变 `color` 实例色、mask 或轨迹坐标。具体显示参考系以 D22 为准。

滚轮调节本次会话的 `moveSpeed`，不直接改写既有轨迹或片段。新的录制以 `samples.t` 与位姿记录速度变化，回放仍从时间戳求值，不依赖滚轮事件或当时的导航设置。原型目前未将 `ControlSettings` 写入浏览器项目备份；本轮不以新增 UI 控件冒充正式 `recording_preferences` 序列化。上文 v2 `speed_mode:"fixed"` 描述历史配置，不应据此认定 v0.4 新录制全程匀速；正式配置版本扩展需与后端一同实现，历史 provenance 保持原样。
