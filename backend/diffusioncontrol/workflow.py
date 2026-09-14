"""Typed workflow requests feeding the existing persistent Slurm coordinator."""
import base64
import hashlib
import io
import math
import re
import struct
import zipfile
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from .adapter import validate_script
from .common import Problem, atomic_write, canonical, identifier, load_json, within
from .config import PROJECT_ROOT

KINDS = {"depth", "sam2", "associate", "export"}
OUTPUTS = {
    "depth": ["result.json", "scene.npz", "preview.bin", "depth.png"],
    "sam2": ["result.json", "masks.npz", "mask-0.png", "overlay-0.png"],
    "associate": ["result.json", "object.npz", "preview.bin", "point-ids.bin", "mask.png", "overlay.png"],
    "export": ["result.json", "manifest.json", "conditions.zip", "validation.csv", "sample/first_image.png",
               "sample/full_prompt.json", "sample/prompt-didi.json", "sample/spatialtracker2.npz",
               "sample/render_output/render_with_2d_bbox.mp4", "sample/render_output/render_mask.mp4"],
}


def object_fields(value, required, optional=()):
    if not isinstance(value, dict) or not set(required) <= set(value) or set(value) - set(required) - set(optional):
        raise Problem("工作流字段缺失或包含不支持的字段")
    return value


def number(value, low, high, name, integer=False):
    if type(value) not in ((int,) if integer else (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise Problem("数值范围无效：" + name, field=name)
    return value


def regular_path(path, root):
    """Check unresolved components as well as containment; within() resolves links."""
    path, root = Path(path), Path(root)
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise Problem("资产路径不在允许目录内")
    for component in [path] + list(path.parents)[:len(relative.parts)]:
        if component.is_symlink():
            raise Problem("资产不允许符号链接", "asset_invalid", 409)
    return within(path, [root.resolve()])


def execution_config(value):
    object_fields(value, ("kind", "version", "envName", "scriptName", "scriptContent"))
    if value["kind"] != "slurm_sbatch" or type(value["version"]) is not int or value["version"] != 1:
        raise Problem("不支持的 Slurm 配置")
    for key, maximum in (("envName", 128), ("scriptName", 255)):
        if not isinstance(value[key], str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,%d}" % (maximum-1), value[key]):
            raise Problem("Slurm 名称无效", field="execution." + key)
    script = value["scriptContent"]
    if not isinstance(script, str) or not 1 <= len(script.encode()) <= 262144 or "\0" in script or "\r" in script:
        raise Problem("脚本须为 LF 换行且不超过 256 KiB")
    if not re.fullmatch(r"#![ \t]*(?:/bin/bash|/usr/bin/bash|/usr/bin/env[ \t]+bash)[ \t]*", script.split("\n", 1)[0]):
        raise Problem("工作流脚本需要 Bash shebang")
    return value


class Workflow:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.assets = settings.state / "assets"

    def global_execution(self):
        path = self.settings.state / "execution-settings.json"
        within(path, [self.settings.state.resolve()])
        if path.exists():
            return load_json(path)
        return {"revision": 0, "scriptName": "job.gpu",
                "scriptContent": (PROJECT_ROOT / "docs/examples/job.gpu").read_text()}

    def save_execution(self, raw):
        object_fields(raw, ("revision", "scriptName", "scriptContent"))
        number(raw["revision"], 0, 100000000, "revision", True)
        execution_config({"kind": "slurm_sbatch", "version": 1, "envName": "base",
                          "scriptName": raw["scriptName"], "scriptContent": raw["scriptContent"]})
        validate_script(raw["scriptContent"], self.settings)
        with self.store.lock:
            current = self.global_execution()
            if raw["revision"] != current["revision"]:
                raise Problem("全局设置已由另一页面修改，请刷新后再保存", "revision_conflict", 409)
            result = dict(raw, revision=current["revision"]+1)
            atomic_write(self.settings.state / "execution-settings.json", canonical(result))
        return result

    def capability(self, kind):
        config = self.settings.workflow.get("tasks", {}).get(kind, {})
        env = config.get("environment", "sam2" if kind == "sam2" else "depthpro")
        reason = None
        if not config.get("enabled", False):
            reason = config.get("disabledReason", "任务尚未部署验证")
        elif env not in self.settings.environments or not (self.settings.environments[env] / "bin/python").is_file():
            reason = "Conda 环境尚未安装：" + env
        elif kind in ("depth", "sam2"):
            checkpoint = config.get("checkpoint", "")
            if not checkpoint or not within(checkpoint, self.settings.read_roots).is_file():
                reason = "模型权重尚未准备好"
            source = self.settings.root / ("third_party/sam2/sam2/build_sam.py" if kind == "sam2" else "third_party/ml-depth-pro/src/depth_pro/depth_pro.py")
            if not source.is_file():
                reason = "官方模型源码尚未准备好"
        return {"kind": kind, "environment": env, "available": reason is None, "reason": reason,
                "checkpoint": config.get("checkpoint")}

    def capabilities(self):
        return {"version": 1, "tasks": [self.capability(kind) for kind in sorted(KINDS)],
                "projectsRoot": str(self.store.projects_root),
                "environments": sorted(self.settings.environments), "maxUploadBytes": 32*1024*1024,
                "modelRoot": self.settings.workflow.get("modelRoot", "/home/225015066/PretrainedModels")}

    def asset(self, asset_id):
        if not isinstance(asset_id, str) or not re.fullmatch("[a-f0-9]{64}", asset_id):
            raise Problem("图像资产 ID 无效")
        directory = regular_path(self.assets / asset_id, self.settings.state)
        metadata = directory / "asset.json"
        if not metadata.is_file():
            raise Problem("图像资产不存在", "asset_not_found", 404)
        result = load_json(regular_path(metadata, self.settings.state))
        path = regular_path(directory / "image.png", self.settings.state)
        if not path.is_file():
            raise Problem("图像资产不可用", "asset_invalid", 409)
        return result, path

    def upload(self, raw):
        object_fields(raw, ("image",))
        data_url = raw["image"]
        if not isinstance(data_url, str) or len(data_url) > 45*1024*1024:
            raise Problem("图像超过大小限制", "image_too_large", 413)
        match = re.fullmatch(r"data:image/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=\r\n]+)", data_url)
        if not match:
            raise Problem("请上传 PNG、JPEG 或 WebP 图像")
        try:
            data = base64.b64decode(match[1], validate=True)
            if not 1 <= len(data) <= 32*1024*1024:
                raise Problem("图像超过 32 MiB", "image_too_large", 413)
            with Image.open(io.BytesIO(data)) as original:
                if original.format not in ("PNG", "JPEG", "WEBP") or original.width*original.height > 16000000:
                    raise Problem("图像格式无效或超过 1600 万像素")
                image = ImageOps.exif_transpose(original).convert("RGB")
                if min(image.size) < 16:
                    raise Problem("图像宽高至少为 16 像素")
                encoded = io.BytesIO()
                image.save(encoded, format="PNG")
        except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError):
            raise Problem("无法读取图像", "image_invalid")
        data = encoded.getvalue()
        asset_id = hashlib.sha256(data).hexdigest()
        directory = self.assets / asset_id
        result = {"id": asset_id, "sha256": asset_id, "width": image.width, "height": image.height,
                  "url": "/api/workflow/assets/" + asset_id + "/image"}
        with self.store.lock:
            regular_path(directory / "image.png", self.settings.state)
            regular_path(directory / "asset.json", self.settings.state)
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
            if not (directory / "asset.json").exists():
                atomic_write(directory / "image.png", data)
                atomic_write(directory / "asset.json", canonical(result))
                (directory / "image.png").chmod(0o400)
                (directory / "asset.json").chmod(0o400)
        return result

    def dependency(self, job_id, kind, project_id, reference_id, filename, scene_id=None):
        identifier(job_id, "dependency")
        job = self.store.get(job_id)
        if job["status"] != "succeeded" or job["cancelRequested"] or job["request"].get("kind") != kind:
            raise Problem("依赖任务尚未成功或类型不匹配", "dependency_invalid")
        if job["request"]["projectId"] != project_id or job["request"]["inputs"].get("referenceAssetId") != reference_id:
            raise Problem("依赖任务来自不同项目或首帧", "dependency_mismatch")
        if scene_id and job["request"]["inputs"].get("sceneJobId") != scene_id:
            raise Problem("物体点簇来自另一重建版本", "dependency_mismatch")
        item = next((entry for entry in job["outputs"] if entry["relativePath"] == filename), None)
        if item is None:
            raise Problem("依赖产物不存在")
        path = self.store.output_path(job, filename)
        if not path.is_file():
            raise Problem("依赖产物已移除", "dependency_changed")
        stat = path.stat()
        if path.is_symlink() or stat.st_size != item["size"] or stat.st_mtime_ns != item["mtimeNs"] or stat.st_ino != item["inode"]:
            raise Problem("依赖产物已变化", "dependency_changed")
        return path

    def submit(self, raw, key):
        object_fields(raw, ("version", "requestId", "createdAt", "projectId", "projectName", "kind", "inputs", "options", "execution"))
        if type(raw["version"]) is not int or raw["version"] != 1 or not isinstance(raw["kind"], str) or raw["kind"] not in KINDS:
            raise Problem("不支持的工作流版本或类型")
        for field in ("requestId", "projectId"):
            identifier(raw[field], field)
        if key != raw["requestId"]:
            raise Problem("Idempotency-Key 必须与 requestId 一致", "idempotency_key_mismatch", 400)
        if not isinstance(raw["projectName"], str) or not 1 <= len(raw["projectName"]) <= 200:
            raise Problem("项目名称无效")
        try:
            if datetime.fromisoformat(raw["createdAt"].replace("Z", "+00:00")).tzinfo is None:
                raise ValueError()
        except (ValueError, TypeError, AttributeError):
            raise Problem("createdAt 必须是带时区的 ISO 时间")
        previous = self.store.replay(raw)
        if previous:
            return previous
        kind = raw["kind"]
        capability = self.capability(kind)
        if not capability["available"]:
            raise Problem(capability["reason"], "task_not_ready")
        execution = execution_config(raw["execution"])
        config = self.settings.workflow["tasks"][kind]
        if execution["envName"] not in config.get("environmentNames", [capability["environment"]]):
            raise Problem("任务未注册此环境", field="execution.envName")
        validate_script(execution["scriptContent"], self.settings, execution["envName"])
        allowed = () if kind in ("depth", "sam2") else (("sceneJobId", "segmentationJobId", "objectJobIds", "replaceObjectJobId") if kind == "associate" else ("sceneJobId", "objectJobIds"))
        source = object_fields(raw["inputs"], ("referenceAssetId",), allowed)
        asset, image_path = self.asset(source["referenceAssetId"])
        evidence = []

        def record(path, field):
            path = within(path, self.settings.read_roots)
            stat = path.stat()
            evidence.append({"field": field, "path": str(path), "size": stat.st_size, "mtimeNs": stat.st_mtime_ns})
            return str(path)

        spec = {"kind": kind, "requestId": raw["requestId"], "source": source,
                "referencePath": record(image_path, "reference"), "modelRoot": self.settings.workflow.get("modelRoot", "/home/225015066/PretrainedModels")}
        options = raw["options"]
        if kind == "depth":
            object_fields(options, (), ("contract", "sobelThreshold", "focalLengthPx", "precision"))
            spec["options"] = {"contract": number(options.get("contract", 8), .1, 100, "contract"),
                               "sobelThreshold": number(options.get("sobelThreshold", .35), .001, .999, "sobelThreshold"),
                               "precision": options.get("precision", "float16")}
            if spec["options"]["precision"] not in ("float16", "float32"):
                raise Problem("Depth Pro precision 无效")
            if options.get("focalLengthPx") is not None:
                spec["options"]["focalLengthPx"] = number(options["focalLengthPx"], 1, 100000, "focalLengthPx")
        elif kind == "sam2":
            object_fields(options, ("points",), ("box",))
            points, box = options["points"], options.get("box")
            if not isinstance(points, list) or len(points) > 100:
                raise Problem("最多支持 100 个提示点")
            for point in points:
                if not isinstance(point, list) or len(point) != 3:
                    raise Problem("提示点需要 x、y、label")
                number(point[0], 0, asset["width"]-1, "point.x")
                number(point[1], 0, asset["height"]-1, "point.y")
                number(point[2], 0, 1, "point.label", True)
            if box is not None:
                if not isinstance(box, list) or len(box) != 4:
                    raise Problem("框需要四个像素坐标")
                for i, value in enumerate(box):
                    number(value, 0, asset["width" if i % 2 == 0 else "height"]-1, "box")
                if box[0] >= box[2] or box[1] >= box[3]:
                    raise Problem("矩形框必须有正宽高")
            if not any(point[2] == 1 for point in points) and box is None:
                raise Problem("至少需要一个正提示点或矩形框")
            spec["options"] = {"points": points, "box": box}
        else:
            scene_id = source.get("sceneJobId")
            spec["scenePath"] = record(self.dependency(scene_id, "depth", raw["projectId"], asset["id"], "scene.npz"), "scene")
            object_ids = source.get("objectJobIds", [])
            if not isinstance(object_ids, list) or len(object_ids) > 20 or any(not isinstance(item, str) for item in object_ids) or len(set(object_ids)) != len(object_ids):
                raise Problem("物体作业列表无效或超过 20 个")
            object_paths = [record(self.dependency(job_id, "associate", raw["projectId"], asset["id"], "object.npz", scene_id), "object") for job_id in object_ids]
            if kind == "associate":
                object_fields(options, ("candidate",), ("selectionBox",))
                candidate = number(options["candidate"], 0, 2, "candidate", True)
                segmentation_id = source.get("segmentationJobId")
                spec["masksPath"] = record(self.dependency(segmentation_id, "sam2", raw["projectId"], asset["id"], "masks.npz"), "masks")
                result = load_json(self.dependency(segmentation_id, "sam2", raw["projectId"], asset["id"], "result.json"))
                if candidate >= len(result["candidates"]):
                    raise Problem("分割候选不存在")
                spec["options"] = {"candidate": candidate}
                spec["existingObjectPaths"] = object_paths
                if ("selectionBox" in options) != ("replaceObjectJobId" in source):
                    raise Problem("编辑框必须同时指定被替换的物体作业")
                if "selectionBox" in options:
                    box = object_fields(options["selectionBox"], ("center", "halfExtents", "quaternion"))
                    for field, size, low, high in (("center", 3, -1000000, 1000000), ("halfExtents", 3, .0001, 1000000), ("quaternion", 4, -1, 1)):
                        if not isinstance(box[field], list) or len(box[field]) != size:
                            raise Problem("编辑框参数维度无效", field=field)
                        for value in box[field]:
                            number(value, low, high, "selectionBox." + field)
                    if abs(sum(v*v for v in box["quaternion"]) - 1) > 1e-5:
                        raise Problem("编辑框旋转必须为归一化四元数")
                    parent = source["replaceObjectJobId"]
                    if parent in object_ids:
                        raise Problem("被替换物体不能同时作为排除点簇")
                    record(self.dependency(parent, "associate", raw["projectId"], asset["id"], "object.npz", scene_id), "replacedObject")
                    prior = self.store.get(parent)["request"]
                    if prior["inputs"].get("segmentationJobId") != segmentation_id or prior["options"].get("candidate") != candidate:
                        raise Problem("编辑框与原物体分割来源不一致")
                    spec["options"]["selectionBox"] = box
            else:
                object_fields(options, ("project",), ("numFrames", "fps", "width", "height", "pointsPerObject", "radius", "pointsPerPixel", "seed"))
                defaults = {"numFrames": 81, "fps": 16, "width": 832, "height": 480, "pointsPerObject": 500,
                            "radius": .005, "pointsPerPixel": 8, "seed": 42}
                limits = {"numFrames": (5, 241), "fps": (1, 60), "width": (64, 1920), "height": (64, 1920),
                          "pointsPerObject": (16, 2000), "radius": (.0001, .1), "pointsPerPixel": (1, 32), "seed": (0, 2147483647)}
                spec["options"] = {name: number(options.get(name, default), *limits[name], name, name != "radius") for name, default in defaults.items()}
                if (spec["options"]["numFrames"]-1) % 4 or spec["options"]["width"] % 16 or spec["options"]["height"] % 16:
                    raise Problem("帧数需为 4n+1，视频宽高需为 16 的倍数")
                project = object_fields(options["project"], ("prompt", "duration", "calibration", "camera", "cameraClip", "objects"), ("controls", "renderStrategy"))
                if "renderStrategy" in project and project["renderStrategy"] != "reference_scene_with_projected_boxes_v2":
                    raise Problem("Rendered Frames 策略无效，请刷新页面")
                if "controls" in project:
                    controls = object_fields(project["controls"], ("object", "camera"))
                    if any(type(value) is not bool for value in controls.values()):
                        raise Problem("运动控制开关必须为布尔值")
                    if (not controls["object"] and project["objects"]) or (not controls["camera"] and (project["camera"] or project["cameraClip"])):
                        raise Problem("关闭控制时不得提交对应运动条件")
                    if (controls["object"] and not project["objects"]) or (controls["camera"] and not project["camera"]):
                        raise Problem("控制已开启但缺少对应轨迹")
                if not isinstance(project["prompt"], str) or not project["prompt"].strip() or len(project["prompt"]) > 10000:
                    raise Problem("请填写全局提示词")
                number(project["duration"], .01, 600, "duration")
                items = project["objects"]
                if not isinstance(items, list) or len(items) != len(object_paths):
                    raise Problem("物体描述与点簇作业数量不一致")
                for item, job_id in zip(items, object_ids):
                    object_fields(item, ("id", "jobId", "prompt", "initialPose", "motion", "trajectory", "clip"))
                    identifier(item["id"], "object.id")
                    if item["jobId"] != job_id or not isinstance(item["prompt"], str) or not item["prompt"].strip():
                        raise Problem("物体点簇映射或提示词无效")
                validate_export_project(project, spec["options"], asset)
                spec["project"] = project
                spec["objects"] = [{"object": item, "path": path} for item, path in zip(items, object_paths)]
        if kind in ("depth", "sam2"):
            spec["checkpoint"] = record(config["checkpoint"], "checkpoint")

        def prepare(directory):
            task = directory / "submission/task.json"
            if execution["scriptName"] == "task.json":
                raise Problem("脚本文件名不能使用 task.json")
            atomic_write(task, canonical(spec))
            task.chmod(0o400)
            return {"workdir": str(self.settings.root), "argv": ["python", "-m", "backend.workers.run", "--task", str(task),
                    "--output-dir", str(directory / "outputs")], "environmentPrefix": str(self.settings.environments[execution["envName"]]),
                    "outputDirectory": str(directory / "outputs"), "inputEvidence": evidence, "adapter": "workflow",
                    "kind": kind, "requestId": raw["requestId"], "source": source,
                    "outputGlobs": ["*.json", "*.npz", "*.bin", "*.png", "*.csv", "*.zip",
                                    "sample/*.png", "sample/*.json", "sample/*.npz", "sample/render_output/*.mp4"],
                    "scriptSha256": hashlib.sha256(execution["scriptContent"].encode()).hexdigest()}
        return self.store.create(raw, prepare)


def validate_outputs(directory, plan):
    for name in OUTPUTS[plan["kind"]]:
        path = regular_path(directory / name, directory)
        if not path.is_file() or path.stat().st_size == 0:
            raise Problem("工作流缺少产物：" + name, "outputs_invalid")
    result = load_json(directory / "result.json")
    if not isinstance(result, dict) or result.get("version") != 1 or result.get("kind") != plan["kind"] or result.get("requestId") != plan["requestId"] or result.get("source") != plan["source"]:
        raise Problem("工作流产物来源不匹配", "outputs_invalid")
    try:
        kind = plan["kind"]
        if kind in ("depth", "associate"):
            count = number(result["pointCount"], 9, 16000000, "pointCount", True)
            with (directory / "preview.bin").open("rb") as stream:
                magic, preview_count, stride = struct.unpack("<4sII", stream.read(12))
            limit = 180000 if kind == "depth" else 100000
            if magic != b"DCP1" or preview_count != min(count, limit) or stride != 28 or (directory / "preview.bin").stat().st_size != 12+preview_count*28:
                raise ValueError("invalid preview")
            shapes = npz_shapes(directory / ("scene.npz" if kind == "depth" else "object.npz"))
            for name, shape in (("xyz", (count, 3)), ("rgb", (count, 3)), ("point_ids", (count,)), ("image_size", (2,))):
                if shapes.get(name) != shape:
                    raise ValueError("invalid point array: " + name)
            if kind == "associate":
                from backend.workers.geometry import finite_array
                finite_array(result["center"], (3,))
                if "boxQuaternion" in result:
                    from backend.workers.geometry import quaternion_matrix
                    quaternion_matrix(result["boxQuaternion"])
                    if shapes.get("box_quaternion") != (4,) or shapes.get("local_xyz") != (count, 3):
                        raise ValueError("invalid oriented bbox arrays")
                if (finite_array(result["halfExtents"], (3,)) <= 0).any() or (directory / "point-ids.bin").stat().st_size != count*4:
                    raise ValueError("invalid bbox or point ids")
        if kind in ("depth", "sam2"):
            width, height = result["width"], result["height"]
            number(width, 16, 16000000, "width", True)
            number(height, 16, 16000000, "height", True)
            if width*height > 16000000:
                raise ValueError("invalid image dimensions")
            if kind == "depth":
                from backend.workers.geometry import legacy_intrinsic
                legacy_intrinsic(result["intrinsic"])
                if shapes.get("depth") != (height, width) or shapes.get("keep") != (height, width):
                    raise ValueError("invalid depth shape")
            else:
                candidates = result["candidates"]
                if not isinstance(candidates, list) or not 1 <= len(candidates) <= 3:
                    raise ValueError("invalid candidates")
                shapes = npz_shapes(directory / "masks.npz")
                if shapes.get("masks") != (len(candidates), height, width) or shapes.get("scores") != (len(candidates),):
                    raise ValueError("invalid masks shape")
                for index, candidate in enumerate(candidates):
                    if candidate["index"] != index or not math.isfinite(candidate["score"]):
                        raise ValueError("invalid candidate score")
                    for key in ("mask", "overlay"):
                        if candidate[key] != "%s-%d.png" % (key, index):
                            raise ValueError("invalid candidate path")
                        with Image.open(regular_path(directory / candidate[key], directory)) as img:
                            if img.size != (width, height):
                                raise ValueError("invalid candidate size")
                            img.verify()
        if kind == "export":
            manifest = load_json(directory / "manifest.json")
            if manifest["source"] != plan["source"] or manifest["maskOneMeans"] != "no_point_coverage" or result["validationCsv"] != str(directory / "validation.csv"):
                raise ValueError("invalid export manifest")
            shapes = npz_shapes(directory / "sample/spatialtracker2.npz")
            frames = result["numFrames"]
            if shapes.get("cam_c2w") != (frames, 4, 4) or shapes.get("intrinsic") != (3, 3):
                raise ValueError("invalid camera tracks")
            for key in manifest["entityMapping"]:
                if shapes.get("camera_3d_pred_%s_sampled" % key) != (frames, manifest["options"]["pointsPerObject"], 3):
                    raise ValueError("invalid object tracks")
            with zipfile.ZipFile(directory / "conditions.zip") as archive:
                if not {name for name in OUTPUTS["export"] if name.startswith("sample/")} <= set(archive.namelist()):
                    raise ValueError("incomplete conditions archive")
    except (KeyError, ValueError, TypeError, OSError, struct.error, zipfile.BadZipFile) as error:
        raise Problem("工作流产物结构校验失败：" + str(error)[:200], "outputs_invalid")


def npz_shapes(path):
    """Read only bounded NPY headers, without loading point clouds on the API node."""
    result = {}
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) > 100:
            raise ValueError("too many NPZ arrays")
        for member in archive.infolist():
            if not re.fullmatch(r"[A-Za-z0-9_]+\.npy", member.filename) or member.filename[:-4] in result:
                raise ValueError("invalid NPZ array name")
            with archive.open(member) as stream:
                version = np.lib.format.read_magic(stream)
                if version != (1, 0):
                    raise ValueError("unsupported NPY version")
                shape, fortran, dtype = np.lib.format.read_array_header_1_0(stream)
                if dtype.hasobject or fortran or len(shape) > 4 or any(n < 0 or n > 16000000 for n in shape):
                    raise ValueError("invalid NPZ dtype or shape")
                if stream.tell() + math.prod(shape)*dtype.itemsize != member.file_size:
                    raise ValueError("NPZ size differs from header")
                result[member.filename[:-4]] = shape
    return result


def validate_export_project(project, options, asset):
    from backend.workers.geometry import finite_array, legacy_intrinsic, pose_matrix, sample_pose
    try:
        if (options["numFrames"]-1)/options["fps"] > project["duration"]+1e-6:
            raise ValueError("输出帧时间超过项目时长")
        calibration = project["calibration"]
        legacy_intrinsic(calibration["intrinsic"])
        if calibration["imageWidth"] != asset["width"] or calibration["imageHeight"] != asset["height"]:
            raise ValueError("标定尺寸与首帧不同")
        if np.any(np.abs(finite_array(calibration["distortion"]["coefficients"], (5,))) > 1e-10):
            raise ValueError("非零畸变尚需显式矫正适配")

        def trajectory(value, clip, initial):
            if not isinstance(value, dict) or not isinstance(clip, dict):
                raise ValueError("轨迹及时间片段必须同时存在")
            if clip["start"] < 0 or clip["start"]+clip["duration"] > project["duration"]+1e-6:
                raise ValueError("时间片段超出项目范围")
            # Validates timestamps, duration and every quaternion, not just endpoints.
            for sample in value["samples"]:
                pose_matrix(sample)
            first = pose_matrix(sample_pose(value, clip, 0))
            if not np.allclose(first, initial, atol=1e-4):
                raise ValueError("轨迹首帧必须与重建初始位姿对齐")

        if project["camera"] is not None or project["cameraClip"] is not None:
            trajectory(project["camera"], project["cameraClip"], np.eye(4))
        ids = set()
        for item in project["objects"]:
            if item["id"] in ids:
                raise ValueError("物体 ID 重复")
            ids.add(item["id"])
            initial = pose_matrix(item["initialPose"])
            if item["motion"] == "trajectory":
                trajectory(item["trajectory"], item["clip"], initial)
            elif item["motion"] != "static" or item["trajectory"] is not None or item["clip"] is not None:
                raise ValueError("物体运动尚未分配或静止物体仍绑定轨迹")
    except (KeyError, ValueError, TypeError, IndexError) as error:
        raise Problem("条件导出参数无效：" + str(error)[:200], "export_invalid")
