import csv
import hashlib
import os
import re
import subprocess
from pathlib import Path

from .common import Problem, load_json, within


def clean_environment():
    # Do not inherit Bash hooks or hidden sbatch options from the API shell.
    return {key: value for key, value in os.environ.items()
            if not key.startswith("SBATCH_") and key not in ("BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS")}


def validate_script(script, settings, env_name=None):
    if env_name is not None and env_name not in settings.environments:
        raise Problem("ENVNAME %s 未在服务端注册；已注册：%s" % (env_name, "、".join(sorted(settings.environments))), field="execution.envName")
    if env_name is not None and not (settings.environments[env_name] / "bin/python").is_file():
        raise Problem("注册的 Conda 环境缺少 Python", field="execution.envName")
    # This is a protocol check for an authenticated author's script, not a Bash sandbox.
    if re.search(r"\bconda\s+init\b", script):
        raise Problem("旧脚本包含 conda init，请导入 docs/examples/job.gpu 的部署模板", field="execution.scriptContent")
    active = [line.strip() for line in script.splitlines() if line.strip() and not line.lstrip().startswith("#")]
    if (not active or active[-1] != 'exec "$@"' or not any("ENVNAME=" in line for line in active)
            or "shift" not in active or not any('conda activate "$ENVNAME"' in line for line in active)
            or "set -euo pipefail" not in active):
        raise Problem('脚本需保留失败即停、ENVNAME 解析、激活和末尾 exec "$@" 转发协议', field="execution.scriptContent")
    for line in script.splitlines():
        if line.lstrip().startswith("#SBATCH"):
            options = line.lstrip()[7:].strip()
            # Exclude scheduling modes that invalidate single-job recovery/ownership.
            if re.search(r"(?:^|\s)(?:--(?:array|clusters|cluster-constraint|het-group|wrap|uid|gid|requeue|wait)(?:=|\s|$)|-[aMW](?:\S|\s|$))", options):
                raise Problem("首版不支持数组、多集群、异构、requeue 或阻塞提交选项")
    try:
        result = subprocess.run(["/bin/bash", "--noprofile", "--norc", "-n"], input=script,
                                text=True, capture_output=True, timeout=5, env=clean_environment())
    except (OSError, subprocess.TimeoutExpired):
        raise Problem("Bash 语法检查不可用", "script_check_unavailable")
    if result.returncode:
        raise Problem("Bash 语法检查失败：" + result.stderr[-1500:], field="execution.scriptContent")


def validate_inputs(model, request, settings):
    workdir = model["workdir"]
    if not workdir.is_dir():
        raise Problem("模型工作目录不存在", "model_not_ready")
    if request["execution"]["envName"] not in model.get("environmentNames", []):
        raise Problem("此模型允许的 ENVNAME：" + "、".join(model.get("environmentNames", [])), field="execution.envName")
    parameters = request["parameters"]
    paths, evidence = {}, []

    def check(value, field, directory=False):
        path = within(workdir / value, settings.read_roots)
        if not (path.is_dir() if directory else path.is_file()):
            raise Problem("输入目录或文件不存在：" + field, "input_missing", field=field)
        if not directory and path.stat().st_size == 0:
            raise Problem("输入文件为空：" + field, "input_empty", field=field)
        stat = path.stat()
        evidence.append({"field": field, "path": str(path), "size": stat.st_size, "mtimeNs": stat.st_mtime_ns})
        return path

    for p in model["profile"]["parameters"]:
        key = p["key"]
        if p["type"] != "path" or key == "output_dir" or not parameters.get(key):
            continue
        if model["adapter"] == "symphomotion" and key == "obj_injector_path" and not parameters.get("use_object_prompt"):
            continue
        paths[key] = check(parameters[key], key, key in model.get("directoryParameters", ["pretrained_model_path"]))
    if model["adapter"] == "symphomotion":
        check("infer.py", "model.entrypoint")
        entrypoint = model["profile"]["commandPrefix"][1]
        if entrypoint != "infer.py":
            check(entrypoint, "model.adapterEntry")
        for key in ("pretrained_model_path", "config_path", "controlnet_path", "validation_csv_path"):
            if key not in paths:
                raise Problem("必需模型路径缺失", field=key)
        base = paths["pretrained_model_path"]
        check(str(base / "model_index.json"), "model_index")
        # Verify listed shards without reading multi-GB checkpoint contents.
        for subdir, index_name in (("transformer", "diffusion_pytorch_model.safetensors.index.json"),
                                   ("text_encoder", "model.safetensors.index.json")):
            index_path = check(str(base / subdir / index_name), "checkpoint_index")
            for shard in set(load_json(index_path).get("weight_map", {}).values()):
                check(str(base / subdir / shard), "checkpoint_shard")
        if parameters.get("use_object_prompt") and "obj_injector_path" not in paths:
            check("pretrained_checkpoints/object_control/object_injector.pth", "obj_injector_path")
        load_json(paths["config_path"])
        with paths["validation_csv_path"].open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            if "path" not in (reader.fieldnames or []):
                raise Problem("条件 CSV 必须包含 path 列", field="validation_csv_path")
            samples = []
            for row in reader:
                if row.get("path", "").strip():
                    samples.append(row["path"].strip())
                if len(samples) > 1000:
                    raise Problem("单次条件包最多 1000 个 sample")
        samples = samples[:parameters.get("max_samples", len(samples))]
        if not samples:
            raise Problem("条件 CSV 没有可用 sample")
        names = [Path(sample).name for sample in samples]
        if len(set(names)) != len(names):
            raise Problem("sample 文件夹名称重复，会覆盖输出")
        for sample in samples:
            directory = check(sample, "sample", True)
            required = ["first_image.png", "full_prompt.json", "render_output/render_with_2d_bbox.mp4", "render_output/render_mask.mp4", "spatialtracker2.npz"]
            if parameters.get("use_object_prompt"):
                required.append("prompt-didi.json")
            for name in required:
                check(str(directory / name), "sample." + name)
            prompt = load_json(directory / "full_prompt.json")
            if not isinstance(prompt.get("full_prompt"), str):
                raise Problem("full_prompt.json 缺少字符串 full_prompt")
            manifest_path = directory.parent / "manifest.json"
            if manifest_path.is_file():
                manifest = load_json(check(str(manifest_path), "sample.manifest"))
                if manifest.get("strategy") == "reference_scene_with_projected_boxes_v2":
                    if bool(parameters.get("use_object_prompt")) != manifest["controls"]["object"]:
                        raise Problem("物体控制与 Rendered Frames 不一致，请重新导出并填入配置", field="use_object_prompt")
                    if parameters.get("num_frames") != manifest["options"]["numFrames"] or parameters.get("fps") != manifest["options"]["fps"]:
                        raise Problem("生成帧数／FPS 与 Rendered Frames 不一致", field="num_frames")
                    if parameters.get("use_object_prompt") and not parameters.get("normalize_object_to_first_frame", True):
                        raise Problem("OMM 点轨迹必须归一化到参考相机", field="normalize_object_to_first_frame")
            if parameters.get("use_object_prompt"):
                from .workflow import npz_shapes
                entities = load_json(directory / "prompt-didi.json")
                objects = entities.get("objects")
                if not isinstance(objects, dict) or not 1 <= len(objects) <= parameters.get("max_entities", 2) or entities.get("object_number") != len(objects):
                    raise Problem("OMM 实体数量无效或超过 max_entities", field="max_entities")
                shapes = npz_shapes(directory / "spatialtracker2.npz")
                expected = None
                for key, prompt in objects.items():
                    shape = shapes.get("camera_3d_pred_%s_sampled" % key)
                    if not isinstance(prompt, str) or not prompt.strip() or shape is None or len(shape) != 3 or shape[0] != parameters.get("num_frames") or shape[1] < 1 or shape[2] != 3 or (expected is not None and shape != expected):
                        raise Problem("OMM 缺少完整的实体文本或逐帧 3D 点轨迹", field="validation_csv_path")
                    expected = shape
    return evidence


def check_input_evidence(evidence, roots):
    for item in evidence:
        path = within(item["path"], roots)
        stat = path.stat()
        if stat.st_size != item["size"] or stat.st_mtime_ns != item["mtimeNs"]:
            raise Problem("输入在作业创建后发生变化：" + item["field"], "input_changed")


def resolved_argv(model, request, output_dir):
    argv = list(request["argv"])
    flag = next(p["flag"] for p in model["profile"]["parameters"] if p["key"] == "output_dir")
    for index in range(len(model["profile"]["commandPrefix"]), len(argv)):
        if argv[index] == flag:
            argv[index + 1] = str(output_dir)
            return argv
        if argv[index].startswith(flag + "="):
            argv[index] = flag + "=" + str(output_dir)
            return argv
    raise Problem("模型命令必须显式指定输出目录", field="output_dir")


def collect_outputs(directory, model):
    directory = Path(directory)
    if model.get("adapter") == "workflow":
        from .workflow import validate_outputs
        validate_outputs(directory, model)
    patterns = model.get("outputGlobs", ["generated_videos/*.mp4", "concat_videos/*.mp4"])
    files = sorted(set(path for pattern in patterns for path in directory.glob(pattern)))
    if not files or len(files) > 100:
        raise Problem("产物为空或数量超过 100", "outputs_invalid")
    if model.get("adapter") == "symphomotion" and (directory / "omm-audit.json").is_file():
        files.append(directory / "omm-audit.json")
    outputs = []
    for path in files:
        relative = path.relative_to(directory)
        if any(part.is_symlink() for part in [path] + list(path.parents)[:len(relative.parts)]):
            raise Problem("产物不允许符号链接", "outputs_invalid")
        within(path, [directory.resolve()])
        if not path.is_file() or path.stat().st_size == 0:
            raise Problem("产物缺失或为空", "outputs_invalid")
        hasher = hashlib.sha256()
        with path.open("rb") as stream:
            if path.suffix == ".mp4":
                header = stream.read(12)
                if len(header) < 12 or header[4:8] != b"ftyp":
                    raise Problem("视频不是可识别的 MP4 容器", "outputs_invalid")
                stream.seek(0)
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
        stat = path.stat()
        path.chmod(0o400)
        outputs.append({"id": str(len(outputs)), "name": str(relative), "size": stat.st_size,
                        "mtimeNs": stat.st_mtime_ns, "inode": stat.st_ino,
                        "sha256": hasher.hexdigest(), "relativePath": str(relative)})
    return outputs
