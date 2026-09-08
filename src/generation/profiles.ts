import type { ModelProfile } from './types';

const SYMPHOMOTION_REVISION = 'bf9af6666c0f8cbb594e64f165be79b44c962763';

/** Scalar bounds below validate usable counts in the UI. They do not assert
 * that all values supported by argparse are compatible with a given checkpoint.
 * Paths are upstream repository examples, not verified CE installations.
 */
export const BUILTIN_MODEL_PROFILES: ModelProfile[] = [
  {
    id: 'symphomotion-single-gpu',
    version: 1,
    name: 'SymphoMotion · 单 GPU 推理',
    model: 'SymphoMotion',
    commandPrefix: ['python3', 'infer.py'],
    description: '本系统的单进程推理模板，按固定版本官方 infer.py 参数构建；CE 执行器需配置仓库工作目录、CUDA 环境和权重。',
    inputRequirements: [
      '工作目录为 CE 上的 SymphoMotion 仓库根。以下默认路径取自官方示例，尚未验证其在 CE 上存在。',
      '条件 CSV 需包含 path 列；sample 路径相对于推理进程工作目录，不是 CSV 所在目录。面板要求显式填写 CSV 与 ControlNet 路径。',
      '每个 sample 需包含 first_image.png、full_prompt.json、spatialtracker2.npz 与 render_output 条件视频；全局提示词来自 full_prompt.json，不存在 --prompt 参数。',
      '启用物体控制需匹配的 Object Injector 权重、prompt-didi.json 与逐实体点集轨迹。未填写 obj_injector_path 时，上游回退仓库 pretrained_checkpoints/object_control/object_injector.pth；CE 必须校验该文件。',
      '输出视频写入 output_dir/generated_videos；拼接视频写入 output_dir/concat_videos。生成配置不会自动导出当前浏览器场景。',
      '计数参数下限是前端有效性校验，不是上游模型的完整取值限制。帧数、像素面积、实体数和网络结构参数必须与条件包及权重匹配。',
      '官方配置可覆盖 camera_embedding，当前模板保留该配置行为；单进程入口不同于官方 joint shell 的多 GPU 启动方式。',
    ],
    source: {
      url: `https://github.com/grenoble-zhang/SymphoMotion/blob/${SYMPHOMOTION_REVISION}/infer.py`,
      revision: SYMPHOMOTION_REVISION,
    },
    parameters: [
      {
        key: 'pretrained_model_path', flag: '--pretrained_model_path', label: '基础模型路径',
        type: 'path', defaultValue: 'pretrained_models/Wan2.1-I2V-14B-720P-Diffusers', required: true,
        description: '上游必需；Wan Diffusers 模型目录，需由 CE 安装与核实。',
      },
      {
        key: 'config_path', flag: '--config_path', label: '模型配置路径',
        type: 'path', defaultValue: 'configs/uni3c_controlnet_config.json', required: true,
        description: '上游必需；配置中的 camera_embedding 可覆盖同名 CLI 控制。',
      },
      {
        key: 'validation_csv_path', flag: '--validation_csv_path', label: '条件 CSV 路径',
        type: 'path', defaultValue: 'assets/demo.csv', required: true,
        description: '面板要求显式填写。默认是官方演示清单；自有场景需先准备对应条件包。',
      },
      {
        key: 'controlnet_path', flag: '--controlnet_path', label: 'Camera ControlNet 权重',
        type: 'path', defaultValue: 'pretrained_checkpoints/camera_control/controlnet.pth', required: true,
        description: '上游接受路径或 CONTROLNET_PATH 环境变量；面板要求显式路径，以便请求可追溯。',
      },
      {
        key: 'output_dir', flag: '--output_dir', label: '输出目录',
        type: 'path', defaultValue: 'outputs/inference', required: true,
        description: '上游必需；CE 执行器检查目录权限与作业输出隔离。',
      },
      {
        key: 'num_frames', flag: '--num_frames', label: '生成帧数',
        type: 'integer', defaultValue: '81', min: 1,
        description: '官方默认 81。需与条件包、采样时间和权重能力一致。',
      },
      {
        key: 'max_area', flag: '--max_area', label: '最大像素面积',
        type: 'integer', defaultValue: '399360', min: 1,
        description: '官方默认 480 × 832；控制 loader 的尺寸调整，不等同于任意宽高接口。',
      },
      {
        key: 'num_inference_steps', flag: '--num_inference_steps', label: '推理步数',
        type: 'integer', defaultValue: '40', min: 1,
      },
      {
        key: 'guidance_scale', flag: '--guidance_scale', label: 'Guidance scale',
        type: 'number', defaultValue: '5',
      },
      {
        key: 'fps', flag: '--fps', label: '输出帧率',
        type: 'integer', defaultValue: '16', min: 1,
        description: '编码视频的帧率；不会修改当前项目时间轴或已保存轨迹。',
      },
      {
        key: 'seed', flag: '--seed', label: '随机种子',
        type: 'integer', defaultValue: '42',
      },
      {
        key: 'negative_prompt', flag: '--negative_prompt', label: '负向提示词',
        type: 'string', defaultValue: '',
      },
      {
        key: 'max_samples', flag: '--max_samples', label: '最多处理的 sample 数',
        type: 'integer', defaultValue: '', min: 1,
        description: '留空使用 CSV 中全部有效 sample；不等同于为一个 sample 生成多个随机结果。',
      },
      {
        key: 'use_object_prompt', flag: '--use_object_prompt', label: '启用物体控制',
        type: 'boolean', defaultValue: 'false',
        description: '无值开关。启用后需要 Object Injector 权重、实体提示词和点集轨迹；官方 joint shell 会显式启用。',
      },
      {
        key: 'obj_injector_path', flag: '--obj_injector_path', label: 'Object Injector 权重',
        type: 'path', defaultValue: 'pretrained_checkpoints/object_control/object_injector.pth',
        description: '只在启用物体控制时读取；留空时上游回退仓库内同名默认文件，存在性由 CE 校验。',
      },
      {
        key: 'obj_cross_attn_interval', flag: '--obj_cross_attn_interval', label: '物体交叉注意力间隔',
        type: 'integer', defaultValue: '2', min: 1,
        description: '物体模块结构参数，需与加载权重匹配。',
      },
      {
        key: 'obj_scale', flag: '--obj_scale', label: '物体控制强度',
        type: 'number', defaultValue: '1',
        description: '启用物体控制时使用。',
      },
      {
        key: 'obj_traj_mid_dim', flag: '--obj_traj_mid_dim', label: '物体轨迹中间维度',
        type: 'integer', defaultValue: '512', min: 1,
        description: '物体模块结构参数，需与加载权重匹配。',
      },
      {
        key: 'max_entities', flag: '--max_entities', label: '最大实体数',
        type: 'integer', defaultValue: '2', min: 1,
        description: '官方默认 2；提高数值不代表已经验证更多实体的权重兼容性。',
      },
      {
        key: 'max_text_tokens', flag: '--max_text_tokens', label: '每实体最大文本 token 数',
        type: 'integer', defaultValue: '50', min: 1,
        description: '物体模块参数，需与加载权重和实体提示词配置匹配。',
      },
      {
        key: 'normalize_object_to_first_frame', flag: '--normalize_object_to_first_frame',
        falseFlag: '--no-normalize_object_to_first_frame', label: '转换到首帧相机坐标',
        type: 'boolean', defaultValue: 'true',
        description: '官方默认开启：把逐帧相机坐标中的物体轨迹变换到首帧相机坐标；需与 NPZ 的坐标约定一致。',
      },
      {
        key: 'save_concat_video', flag: '--save_concat_video', label: '保存拼接对比视频',
        type: 'boolean', defaultValue: 'false',
        description: '无值开关；拼接依赖 CE 环境中的 ffmpeg。',
      },
    ],
  },
];
