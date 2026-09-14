# DiffusionControl

面向 SymphoMotion 工作流的交互式三维场景与轨迹编辑系统。输入首帧图像，在重建点云中分割和控制物体，建立随时间变化的场景，再录制相机轨迹并导出模型条件。

最终形态已确定为浏览器应用、前后端分离：后端 HTTP 服务部署于 CE 登录节点，通过 Slurm 把模型推理提交到计算节点；浏览器承担实时交互、轨迹采样及点云预览。

当前阶段：**真实模型模块与 HTTP → Slurm 工作流验收通过，本机重建任务已启用**。修订日期：2026-09-10。Depth Pro、SAM2.1 Large、mask 到原场景点簇关联、初始 AABB、PyTorch3D 动态条件 RGB／空洞 mask 导出均已通过真实计算节点验证；模型文件位于 PretrainedModels，推理复用 `sam2`、`depthpro`、`symphomotion` 环境。HTTP 上传到动态导出的四类任务通过；双卡 Slurm 344573 使用其真实条件包生成 384×256、5 帧、2 步视频，解码与下载通过。前端真实点云解码、场景组装及项目恢复测试通过，浏览器交互尚未实测；2 步视频存在明显畸变，正式画质、复杂运动和高清长视频仍需独立验收。详见 [GPU 验收记录](docs/gpu-validation.md) 和 [重建模块测试](docs/workflow-module-validation.md)。

全局设置集中管理公共 Slurm 脚本，各任务保留自己的 ENVNAME；旧生成配置继续保留本地脚本，用户可选择采用全局设置。真实点云、分割候选和条件视频从同源 API 读取，作业保存在 FastAPI + SQLite 后端。完整项目协作同步与单视角遮挡区域补全尚未实现。

正式项目入口已移除默认示例与演示首帧。项目面板支持删除／恢复、本地完整包导入导出、集群版本快照及完整包存取；删除保留作业和产物，正在运行的任务继续执行。完整包与回收规则见 [项目管理](docs/project-management.md)。集群项目目录为 `var/projects`，浏览器草稿仍采用本机自动保存。

项目缩略图下支持重命名，左上角下拉列表可切换项目。首次 Depth Pro 成功后自动绑定点云；SAM2 候选通过「添加物体」自动关联并加入物体面板。模型结果和日志统一放在 `projects/<项目 ID>/jobs/<作业 ID>`，`var/projects` 继续保存快照及交换包。历史迁移及验证见 [目录与交互修复](docs/workflow-usability-and-storage.md)。

v0.5 的模型／命名配置、命令双向编辑和任务客户端保持可用；历史实现与验证见 [生成面板记录](docs/generation-panel.md)。

v0.4 已实现物体中心参考轴与滚轮调速，见 [历史规格与验证](docs/changes-v0.4.md)。D22／D23 暂采用已说明的推荐方案，尚未视为用户确认。

v0.3 增加深浅色切换和整体可控的几何人物；物体卡片可独立展开或全部收起；重新录制同步更新轨迹缩略图；预选目标仍保留自由观察。鼠标偏航／俯仰与 Q/E 横滚分开维护，按 D21 将俯仰限制在 ±89°，避免局部旋转叠加造成额外横滚。实现与验证见 [修订记录](docs/changes-v0.3.md)。

v0.2 已确定的调整：采用简洁的学术工具界面，删除宣传文案与装饰性英文；主视区仅保留 **2D／3D**，动态场景播放、自由观察与跟随相机统一在 3D 中完成；每个物体和相机各占一条并行时间轨道；松开全部平移键立即停止平移，所有平移采用相机局部坐标，取消鼠标左右键加减速功能。D17–D19 现已确认：每条轨迹固定但可编辑预览的镜头参数、绑定物体正面的虚拟相机控制、整段等比例变速。

## 运行前端原型

```bash
npm install
npm run dev
```

打开终端显示的本地地址，默认 `http://127.0.0.1:5173/`。真实工作流操作见 [重建与分割说明](docs/reconstruction-workflow.md)，依赖安装见 [模型环境](docs/model-environments.md)。先导入首帧并上传，再重建和分割、关联物体、编辑轨迹、提交条件导出，最后填入生成配置。动态预览统一放在 3D 视区；项目和生成配置保存在当前浏览器，真实资产保存在后端，备份恢复需要保留两者。

使用生成面板时，先选择模型与命名配置，再填写 CE 可读取的输入／权重路径、ENVNAME 与作业脚本；本节点 SymphoMotion 的 ENVNAME 填 `symphomotion`。可参考 [自定义模型定义](docs/examples/custom-model.profile.json) 和 [job.gpu 示例](docs/examples/job.gpu)。默认通过同源 `/api` 连接后端，先在 `/login` 登录，再点击“连接并检查模型”；地址覆盖位于“高级连接设置”。生产入口由后端提供 `dist` 与 API，Vite 开发配置已代理 `/api` 和 `/login` 至后端 8000 端口。实际启动前请完成 [后端部署说明](docs/backend-deployment.md)；未连接时仍可编辑与导出请求。旧 API v1 记录仅保留查询与导出。

当前构建、测试和浏览器验证范围统一记录在 [v0.6 验证记录](docs/slurm-execution.md#验证记录)；v0.3–v0.5 的历史结果保留在各自文档。

## 文档入口

| 文档 | 内容 |
| --- | --- |
| [软件需求](docs/software-requirements.md) | 系统范围、操作顺序、面板职责、功能依赖与验收标准 |
| [交互规格](docs/interaction-spec.md) | 键鼠控制、录制状态机、3D 动态时间同步和预览行为 |
| [原型使用说明](docs/prototype-guide.md) | 启动方式、v0.6 操作、实现边界与实际验证范围 |
| [CE 登录节点与 Slurm 提交](docs/slurm-execution.md) | ENVNAME、脚本、完整提交预览、API v2 能力门禁与验证 |
| [Slurm 作业脚本示例](docs/examples/job.gpu) | 用户提供的资源配置与 ENVNAME／推理参数转发逻辑 |
| [Diffusion 生成面板](docs/generation-panel.md) | 模型与项目 profile、命令双向编辑、CE 任务 API、生成配置保存与验证 |
| [自定义模型定义示例](docs/examples/custom-model.profile.json) | 可导入的参数 schema 与命令入口示例；需另行注册对应 CE adapter |
| [v0.4 修订记录](docs/changes-v0.4.md) | 物体中心参考轴、共享配色、滚轮调速和验证 |
| [v0.3 修订记录](docs/changes-v0.3.md) | 六项修改、横滚诊断、浏览器验收与存储恢复 |
| [项目构成与 JSON README](docs/project-format.md) | 文件夹、环境变量、项目 JSON、坐标系、轨迹格式与存储规则 |
| [待决定事项](docs/decisions.md) | 有歧义的问题、可选方案、建议及影响 |
| [上游兼容性调研](docs/research-compatibility.md) | SymphoMotion、ViewCrafter、Uni3C 的官方证据及适配差距 |
| [轨迹时间与镜头预览调研](docs/trajectory-camera-research.md) | 时间重映射、论文中的视锥画法、K／FOV／畸变设计与兼容边界 |
| [浏览器与 CE 部署架构](docs/deployment-architecture.md) | 前后端边界、上传和服务端路径、异步计算、分级加载及断网恢复 |
| [登录节点后端技术方案](docs/backend-implementation.md) | 生成 API v2、校验、持久化、Slurm 状态恢复、路径与身份边界 |
| [后端部署与运维](docs/backend-deployment.md) | base Web 服务、复用 symphomotion 环境、内网访问、模型启用与实际验证结果 |
| [最小项目 JSON](docs/examples/project.empty.json) | 仅创建项目时的合法数据示例 |
| [完整项目 JSON](docs/examples/project.populated.json) | 包含场景、物体、轨迹和导出信息的结构示例 |
| [相机轨迹示例](docs/examples/camera.trajectory.json) / [物体轨迹示例](docs/examples/object.trajectory.json) | 本系统建议的编辑格式，不是上游原生格式 |

## 核心工作流

创建或导入项目 → 加载首帧 → 2D 分割物体 → 重建或导入 3D 点云 → 将 mask 对齐到点云 → 确认包围盒与物体正面 → 逐物体录制或导入运动轨迹 → 构建动态场景并在 3D 中预览 → 在同一 3D 视区录制或导入相机轨迹 → 保存、预览及适配导出。

3D 重建可以与 2D 分割独立进行，但物体轨迹编辑必须等待二者就绪。相机轨迹录制必须等待动态场景就绪。取消独立 4D 标签不会删除内部的时间维度、动态场景资产或失效依赖。项目读取与浏览按已有资产开放，不要求为了预览重新执行完整流程。

2026-09-06 的要求已覆盖 D01／D02：取消鼠标按钮调速，松开平移键停止运动；v0.4 增加滚轮调速。D07-升降确定为相机局部方向。D03–D06 继续有效：SAM 分割、物体完整位姿、SymphoMotion 相机从参考位姿起录、允许显式静态场景。D24–D26 已确认本轮模型范围、CE API 执行方式和两层 profile；其他待定事项和历史覆盖记录见 [决策清单](docs/decisions.md)。

示例中的路径和数值仅用于说明格式；没有附带真实图像、点云、mask、预览图或模型输出。所有提议的格式均需在实现阶段通过官方样本和导出验证固定版本。
