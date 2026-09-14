# 运动控制与渲染验证结果（2026-09-11）

对应设计：[生成环境、定向包围盒与 OMM](motion-controls-and-rendering.md)。按用户要求先完成设计，再修改代码；未安装或升级依赖。

## 真实计算节点验证

测试使用既有卡车验证项目 `workflow-validation-7d765556596b`，复用其 Depth Pro 和 SAM2 产物，不修改用户正式项目或集群项目快照。所有计算均通过 `sbatch` 提交到 `youlab-gpu`。

| 验证 | Slurm | 环境 | 结果 |
| --- | --- | --- | --- |
| 物体点簇与定向框 | 347248 | depthpro | 459,731 点完整包含；框体积 5.471456，原 AABB 6.028475，减少 9.24% |
| Rendered Frames | 347249 | depthpro | 5 帧、384×256、4 fps；参考场景保留原处物体，仅叠加运动投影框 |
| 双 GPU 生成 | 347250 | symphomotion | 2 张 RTX 5090；5 帧、2 个采样步；完整 pipeline 成功生成 MP4 |
| 独立光栅化复核 | 347251 | depthpro | 全点包含性通过；最后一帧空洞 mask 与原处完整场景 GPU 渲染逐像素一致；框外 RGB 平均绝对误差 2.08/255（视频有损编码） |
| 官方 loader 与 OMM 复核 | 347256 | symphomotion | 参考相机坐标、稳定点 ID、刚体运动、Entity Text 映射与真实网络调用通过 |

OMM 审计：一个有效实体，补齐后的点张量 `[2,5,500,3]`，参考相机归一化开启；轨迹编码器执行 1 次，物体注意力执行 40 次；融合特征 `[1,500,5120]`，范数 1784.734；首个注意力输出范数 6.296，控制强度 1.0。以上来自真实模块 forward hook，而非只检查 CLI 参数存在。

此结果证明数据与执行链路接通，不代表正式画质或运动精度验收。2 步生成仍有明显模糊与形变；完整 81 帧、高分辨率和正式采样步数的资源与效果需要另行实测。

## 浏览器与自动化

Firefox 使用独立配置验证通过：旧 base 草稿修复到 symphomotion；模型环境清单可读；开关自动跟随轨迹、隐藏专属参数、关闭保留轨迹；刷新保持状态；恢复开关后原有效条件可执行；过期条件拒绝提交；项目往返切换后控件仍可操作。

测试发现并修复了跨引擎四元数归一化的微小浮点差异被误判为条件过期的问题。生成面板另外取消按项目强制重挂载，使用显式状态恢复并验证切换后的事件响应。测试脚本自身还修复了重复生成轨迹/clip ID 的问题，正式脚本保留导出身份。

本节点 Firefox 无可用 WebGL2，因此不声称已验证浏览器中的 3D 像素。定向框数学、旋转正面、真实点云解码、刚体变换和独立 GPU 渲染已分别验证。

- 前端常规套件：175 项通过；真实历史点云与旧项目恢复的可选测试单独通过，总计 176 项。
- 后端全套：83 项中的 82 项通过，1 项因 base 没有模型栈跳过；该项随后在 symphomotion 计算节点通过。另新增 OMM 异常输入回归测试通过。
- 生产构建通过。沿用现有 Node 20.12.2，Vite 的 Node 版本建议与大 bundle 警告仍存在，没有为此升级环境。

## 可查看文件

测试证据根目录：`var/validation/20260911-motion/`。下列路径均相对项目根目录。

| 内容 | 路径 |
| --- | --- |
| Rendered Frames 视频 | `var/validation/20260911-motion/export/sample/render_output/render_with_2d_bbox.mp4` |
| 空洞 mask 视频 | `var/validation/20260911-motion/export/sample/render_output/render_mask.mp4` |
| 实际生成视频 | `var/validation/20260911-motion/generation/generated_videos/sample.mp4` |
| 渲染首／末帧图片 | `var/validation/20260911-motion/verify-render/rendered-frame-00.png`、`rendered-frame-04.png` |
| 完整原处场景的独立渲染 | `var/validation/20260911-motion/verify-render/reference-scene-final-camera.png` |
| 生成首／末帧图片 | `var/validation/20260911-motion/verify-consumer/generated-frame-00.png`、`generated-frame-04.png` |
| OMM 实际调用审计 | `var/validation/20260911-motion/generation/omm-audit.json` |
| 浏览器截图 | `var/validation/20260911-motion/browser-check/01-controls-disabled.png`、`02-controls-enabled.png` |
| 浏览器结果 | `var/validation/20260911-motion/browser-check/result.json` |
| 真实渲染／消费复核 | `var/validation/20260911-motion/verify-render/result.json`、`verify-consumer/result.json` |

完整作业产物按项目保存：

```text
projects/workflow-validation-7d765556596b/jobs/322c28a7-e4da-4312-8e70-1112b1faa8e6/outputs/  # 物体点簇与定向框
projects/workflow-validation-7d765556596b/jobs/e354ae47-989c-49ab-b26b-f8140bed2dd2/outputs/  # Rendered Frames 与完整条件包
projects/workflow-validation-7d765556596b/jobs/f398cbec-fe27-4cab-bd11-3ac44f26f001/outputs/  # 实际生成与 OMM 审计
```

`scripts/validate-motion-http.py` 保存原请求并按同一 requestId 恢复，避免重复提交；重新实验应指定新的 `--output` 目录。该脚本使用 base 提交 HTTP，实际生成任务显式注册 `ENVNAME=symphomotion`。`scripts/verify-motion-artifacts.py` 只能经 sbatch 在相应环境运行。Firefox 脚本不提交 GPU 作业。

## 使用提示

服务已恢复到当前配置的 `0.0.0.0:8000`。用户批准更换过短的访问令牌，新令牌只在 `var/access-token`，需重新登录；旧文件权限 0600，备份保存在验证目录中，报告未包含令牌内容。

刷新页面后，新建物体关联使用 OBB；旧物体保留原来的框与轨迹。旧版动态点云条件包保留下载，但需重新导出“导出SymphoMotion Rendered Frames”才能填入当前生成工作流。开关、轨迹、镜头或提示词改变后重新导出，再点击“填入生成配置”。
