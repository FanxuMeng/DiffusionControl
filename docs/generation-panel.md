# Diffusion 生成面板 v0.6

2026-09-09 更新：后端部署位置和新提交 API v2 以 [Slurm 执行规格](slurm-execution.md) 为准。新增 ENVNAME、Bash 脚本编辑／导入和完整 sbatch 预览；下文 v1 API 保留为历史兼容说明。

日期：2026-09-08。已按先更新本文与关联需求、后实现代码的顺序完成 v0.5。D24–D26 已确认：首批 SymphoMotion 与自定义模型 profile；通过可配置 CE 任务 API 执行，未连接时可编辑／校验／导出请求；模型 profile 定义字段与命令模板，项目 profile 保存可命名的运行配置。

## 面板与流程

副面板排列为“项目 → 物体控制 → 相机控制 → Diffusion 生成”。新面板可独立折叠，沿用深浅主题。选择模型 profile → 选择／新建／复制／重命名项目运行 profile → 填写参数或编辑命令 → 查看解析／校验 → 连接 CE → 执行并查看作业状态、消息与输出链接。无 CE 时不模拟模型生成成功。

项目、模型和命名配置分别保留草稿；切换不取消已提交任务。轨迹录制／倒计时／暂停保存期间锁定生成编辑与提交，已有作业状态查询独立继续。

## 两层 profile

模型 profile 声明 ID、版本、名称、模型名称、固定入口 tokens、参数 schema、输入要求和源码来源。字段包括 key、CLI flag、类型、默认值、必需性、范围／枚举与说明；表单、命令生成和解析均使用这一份定义。v1 支持单条 argv、命名标量参数、布尔开关及成对正／反开关，以及固定长度／变长列表。入口例如 `python3 infer.py`，实际执行目录和环境由 CE 注册的模型 adapter 提供。

项目运行 profile 保存名称、模型 ID／版本、各字段原始输入、命令原文与最近编辑来源。每模型可有多份，切换时恢复上次选择；数字尚未输入完整、引号未闭合的草稿也应保留。未知模型关联显示不可用，不静默套另一模型。

自定义模型定义通过 JSON 导入／导出，校验结构、唯一 key／flag、参数类型、默认值和入口。定义随项目备份保存，冲突 ID 拒绝覆盖。前端导入不等于 CE 已安装该模型；服务端需注册相同 ID／版本才可执行。

可直接导入 [自定义模型格式示例](examples/custom-model.profile.json) 查看 8 项不同类型的控件；其 `ce_custom_infer.py` 是待替换的示例入口，不对应已安装服务。SymphoMotion 的完整定义可在面板选择该模型后点击“导出定义”获取。当前上限为每项目 50 个自定义模型、100 份命名配置；每个模型最多 200 个参数。

`defaultValue` 始终是输入框原文字符串，例如数值 `"30"`、布尔 `"true"`、列表 `"[\"832\",\"480\"]"`。执行前转换为类型化 parameters。布尔类型以 flag 存在表示 true，默认 true 时必须声明 `falseFlag`；枚举需声明 `choices`；列表需声明正整数或 `"+"` 的 `nargs`。schema 不包含任意 JavaScript 或模板求值表达式。

## 参数与命令双向编辑

- 字符串／路径、整数、小数提供输入框，长文本用文本框；枚举与布尔值使用明确值控件；列表用 JSON 数组输入。空数字和负号中间态保留，不能变成零。
- 整数使用十进制整数字面量，避免前端接受而上游 argparse 拒绝；可选字符串清空时显式传入空字符串，表单显示值须与实际 argv 一致。可选数值留空仅在模型本身无默认值时表示省略，否则作为待修正草稿。
- 修改字段即更新 POSIX 风格命令，正确处理中文、空格、引号和空字符串。
- 命令可以直接编辑。支持空白、单／双引号、反斜线转义、续行、`--key value` 和 `--key=value`；成功识别后反向更新字段。删除参数后恢复模型默认值或空值，不保留被删除参数的旧值。
- 未闭合引号、未知参数、重复参数、错误入口、类型／范围错误均说明原因。无法解析时保留原命令和最近可解析表单，禁止使用陈旧值提交。提供“从参数重建命令”显式恢复。
- 执行和请求导出前重新检查当前命令及字段。切换模板不向其他模型搬运同名字段，不修改轨迹或项目时间轴。
- 推理命令编辑器表示单个进程 argv，不支持管道、重定向、命令连接、变量／命令替换；需要另一参数集合／入口时导入相应 profile。正确加引号的普通文本保持原义。v0.6 的独立 Bash 编辑区支持完整脚本，Slurm 包装不进入模型参数解析。

## SymphoMotion 模板

首批提供本系统的单 GPU `python3 infer.py` 模板，工作目录为 CE 上的 SymphoMotion 仓库根。模型／权重和 Python 环境由 CE 管理。模板使用固定源码版本核对，不声称已经部署。

CLI 必需字段为 `pretrained_model_path/config_path/output_dir`；面板还要求显式填写条件 CSV 和 ControlNet 路径，避免无意使用上游 demo 或未配置的环境变量。可调字段包括帧数、fps、步数、guidance、seed、negative_prompt、实体数及物体控制参数；物体与拼接输出开关按真实旗标生成。参数控件开放不等于已验证任意尺寸／帧数的模型效果。[官方推理入口](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/infer.py)

没有 `--prompt`：全局提示词来自 sample 的 `full_prompt.json`，实体提示词和点集条件通过条件包提供。CSV 中路径相对进程 cwd；输出为 `output_dir/generated_videos`。配置中的 `camera_embedding` 可覆盖 CLI，因此首批不提供看似能独立关闭相机控制的开关。[入口与数据读取](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/infer.py)、[官方配置](https://github.com/grenoble-zhang/SymphoMotion/blob/bf9af6666c0f8cbb594e64f165be79b44c962763/configs/uni3c_controlnet_config.json)

用户可填写已有 CE 条件包路径，因此提交不强制依赖当前演示场景的导出状态；浏览器项目仅提供配置归属。中心轨迹 JSON、WebGL 点云和首帧 data URL 不能冒充上游输入，文件存在性和条件包一致性由服务端检查。

## CE API 契约 v1

本节保留 v0.5 的历史接口语义。v0.6 新提交要求 [API v2 与 Slurm 能力](slurm-execution.md#api-v2-与兼容性)，禁止向只支持 v1 的服务提交推理。历史 v1 作业仍能查询和导出；下述旧 POST 格式不能作为当前 CE 执行器实现依据。

当前连接方式已确定为同源 `/api`，地址覆盖收进高级设置；具体优先级与恢复行为见 [同源连接](slurm-execution.md#同源连接与高级设置)，不保存服务端密钥。跨源覆盖时由后端配置 CORS／认证。

可复制 `.env.example` 为 `.env.local` 设置公开部署默认值 `VITE_CE_API_BASE_URL`，然后重启开发服务器；正常同源部署无需修改 `/api`。浏览器已保存的非空地址优先于构建配置，均为空则回退 `/api`。请求使用 `credentials: include`，不在前端保存 CE 密钥；跨源服务需允许当前前端 origin、GET／POST，以及 `Content-Type`、`Idempotency-Key` 请求头。浏览器只调用 HTTP(S) API，不直接运行 SSH／调度器命令。

| 请求 | 数据与语义 |
| --- | --- |
| `GET {base}/inference/capabilities` | `{apiVersion:1, profiles:[{id,version}]}`；成功读取且匹配当前模型才允许提交 |
| `POST {base}/inference/jobs` | 提交下述请求并返回作业；`requestId` 同时作为幂等键 |
| `GET {base}/inference/jobs/{jobId}` | 查询作业，浏览器读取真实状态／消息／进度，不模拟进度 |

请求字段：`apiVersion:1, requestId, createdAt, projectId, projectName, projectProfileId, profileId, profileVersion, parameters, argv, command`。parameters 为解析后的数值／布尔／字符串／列表，argv 为实际参数数组，command 为显示文本。服务端按注册 profile 校验字段与 argv，以进程参数执行，不以 shell eval 解释前端文本。执行器负责工作目录、模型条件和资源。

作业字段：`id, requestId, status, progress?, message, outputs:[{name,url}]`；status 为 `queued/running/succeeded/failed/cancelled`，progress 为 0–1。输出只作为可访问结果呈现，不自动覆盖首帧或场景。提交快照、请求 ID、接受后的 job ID 与提交时的 endpoint 随项目保存；刷新后可继续查询。网络错误不冒充远端失败；提交结果不确定时保留请求 ID，重试复用以去重。状态查询失败不取消任务。

契约规定 POST 返回 HTTP 400／422 表示请求被明确拒绝、没有创建作业；客户端保存 `{status,message}` 拒绝记录并允许修改配置后新提交。网络断开、超时及其他不明确响应保留“结果待确认”，重试须使用原请求。服务端已接受的作业应返回带 job ID 的响应，不得再使用 400／422。

能力清单示例：

```json
{"apiVersion":1,"profiles":[{"id":"symphomotion-single-gpu","version":1}]}
```

POST 接受及后续 GET 状态响应共用以下结构，`requestId` 必须回显实际提交 ID，GET 的 `id` 必须与查询作业一致：

```json
{"id":"ce-job-001","requestId":"实际请求ID","status":"running","progress":0.25,"message":"推理运行中","outputs":[]}
```

成功后可返回 `status:"succeeded"` 及 `outputs:[{"name":"生成视频","url":"/assets/ce-job-001/video.mp4"}]`。输出 URL 可为 HTTP(S) 或相对 API 的资产路径；客户端解析为完整 URL。拒绝示例：HTTP 422、`{"message":"条件 CSV 不存在"}`。客户端每次请求超时为 15 秒，当前项目非终态作业在一次查询完成约 3 秒后再次查询；切换项目暂停其查询，切回／刷新后恢复，远端作业继续运行。没有 job ID 的待确认提交不会在刷新后自动 POST。

每个运行配置同时只允许一个未结束或结果待确认的请求；需要并行对比时复制为另一命名配置。界面优先保留最近 20 条提交记录，仅清理终态／明确拒绝记录；全部未结束时允许增长到 50 条并停止新提交，避免遗失待确认请求。

本轮实现客户端和接口契约，不实现 CE 后端、权重安装、条件导出器或部署；真实生成取决于兼容服务是否可用。

## 项目数据扩展

原型持久化数据中的 `generation` 可选，旧项目缺字段时初始化；运行时 `Project.generation` 始终存在，格式为 `{version:1, selectedModelId, activeProfileIds, projectProfiles, customProfiles, submissions}`。

- `activeProfileIds`：每个模型上次选中的命名配置 ID。
- `projectProfiles`：`{id,name,modelProfileId,modelProfileVersion,values,commandText,editSource,execution}`；values 保存原始输入字符串，editSource 为 form／command；v0.6 的 execution 保存 ENVNAME、脚本名称和全文，旧配置缺少时补充默认值。
- `customProfiles`：完整模型 schema，保证备份自包含。
- `submissions`：`{endpoint,request,job?,rejection?}`，保存不可变请求与接受后的作业状态，或明确拒绝记录；job 与 rejection 互斥，不包含凭据。

正式 `project.json.generation` 采用同一带版本扩展，与条件包导出的 `export_profiles` 分开。导入时校验；更新首帧／重载示例需保留配置。导入备份到新本机项目 ID 后，已有提交仍保留原请求归属以供追溯，不自动重新提交。

## 验收

1. 项目／模型／命名配置切换、刷新和导入恢复后字段与模板一致，草稿不串用。
2. 命令往返覆盖中文、空格、引号、负数、等号、布尔和列表；语法错误不触发旧命令执行。
3. 自定义 schema 改变入口和字段，冲突／不支持的定义报告错误。
4. 无连接可编辑、校验、导出；连接、版本不匹配、提交和查询错误准确展示。
5. 请求快照及幂等 ID 不受后续表单编辑或项目切换影响，作业按 ID 更新。
6. 运行有意义的解析／持久化／接口回归和生产构建；浏览器与真实 CE 的验证范围如实记录。

## 验证记录

v0.6 的当前验证见 [Slurm 验证记录](slurm-execution.md#验证记录)。以下为 v0.5 历史验证。

2026-09-08：`npm test` 的 **15 个文件、123 项测试通过**，包含 35 项 profile／解析校验、9 项 CE HTTP 客户端测试、4 项项目持久化集成测试及既有 75 项回归。补充空列表草稿校验后，对应 35 项解析测试再次通过。`npm run build` 通过 TypeScript 与 Vite 生产构建；现有主包仍有大于 500 kB 的体积提示。6 份 JSON 示例均能解析，自定义 profile 示例通过运行时校验并生成对应 8 参数命令。

Chrome 实际交互检查使用独立本地端口上的 `generation-qa` 项目，未修改已有项目轨迹。已确认：

- 输入 seed 123 会更新命令；直接改为 seed 777 和含空格 CSV 路径会同步回填字段。
- 引号未闭合时保留最近字段、显示错误并禁用请求导出／执行；从参数重建后恢复。
- 复制为 `seed-777` 命名配置，导入示例模型后切为 8 项参数及 `ce_custom_infer.py` 入口；清空示例提示词生成显式 `--prompt ''`。
- 切回 SymphoMotion 恢复原命名配置和 22 项参数；刷新后重新选择 QA 项目可恢复 seed 与 CSV 草稿，示例项目仍保持默认配置。
- 生成面板可独立折叠／展开，两种主题下布局可读；未连接 CE 时执行禁用，“导出请求”实际下载 JSON 成功。

API 能力匹配、幂等请求内容、HTTP 400／422 拒绝、超时、网络错误、作业 ID 校验及输出 URL 检查由模拟 HTTP 单元测试覆盖。当前没有提供真实 CE 地址，因此未进行服务联调、GPU 推理或真实作业恢复验收；本轮没有部署后端。已有轨迹录制和原生组合键输入未重新进行完整浏览器验收，历史范围见原型指南。
