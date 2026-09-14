"""Reference-scene rendering and projected motion boxes, Slurm worker only."""
import csv
import json
import zipfile

import imageio.v2 as imageio
import numpy as np
from PIL import Image, ImageDraw

from .geometry import (finite_array, legacy_intrinsic, pose_matrix, resize_intrinsic,
                       sample_pose, transform_object)


def render_points(xyz, rgb, intrinsic, c2w, height, width, radius, layers):
    import torch
    from pytorch3d.renderer import AlphaCompositor, PerspectiveCameras, PointsRasterizer, PointsRasterizationSettings
    from pytorch3d.structures import Pointclouds

    if len(xyz) <= 8:
        return np.zeros((height, width, 3), np.float32), np.ones((height, width), bool)
    camera_to_world = torch.as_tensor(c2w, device="cuda", dtype=torch.float32)[None].clone()
    # Same OpenCV -> PyTorch3D conversion as SymphoMotion pointcloud.py.
    camera_to_world[:, :, :2] *= -1
    world_to_camera = torch.linalg.inv(camera_to_world)
    k = torch.as_tensor(intrinsic, device="cuda", dtype=torch.float32)
    camera = PerspectiveCameras(focal_length=k.diag()[:2][None], principal_point=k[:2, 2][None],
                                R=camera_to_world[:, :3, :3], T=world_to_camera[:, :3, 3],
                                in_ndc=False, image_size=[(height, width)], device="cuda")
    cloud = Pointclouds(points=[torch.as_tensor(xyz, device="cuda", dtype=torch.float32)],
                        features=[torch.as_tensor(rgb/255.0, device="cuda", dtype=torch.float32)])
    raster = PointsRasterizer(cameras=camera, raster_settings=PointsRasterizationSettings(
        image_size=(height, width), radius=radius, points_per_pixel=layers))
    with torch.inference_mode():
        fragments = raster(cloud)
        weights = 1-fragments.dists.permute(0, 3, 1, 2)/(radius*radius)
        image = AlphaCompositor(background_color=[.5, .5, .5])(
            fragments.idx.long().permute(0, 3, 1, 2), weights, cloud.features_packed().T)
        holes = fragments.zbuf[0, :, :, 0] == -1
    return image[0].permute(1, 2, 0).cpu().numpy(), holes.cpu().numpy()


def projected_box(points_camera, intrinsic, width, height):
    visible = np.asarray(points_camera)[np.asarray(points_camera)[:, 2] > 1e-5]
    if not len(visible):
        return None
    pixels = visible @ intrinsic.T
    pixels = pixels[:, :2]/pixels[:, 2:3] - .5
    lo, hi = pixels.min(axis=0), pixels.max(axis=0)
    if hi[0] < 0 or hi[1] < 0 or lo[0] >= width or lo[1] >= height:
        return None
    return [int(max(0, np.floor(lo[0]))), int(max(0, np.floor(lo[1]))),
            int(min(width-1, np.ceil(hi[0]))), int(min(height-1, np.ceil(hi[1])))]


def export_task(spec, output):
    import torch
    if not torch.cuda.is_available():
        raise RuntimeError("Condition export requires a GPU allocation and CUDA PyTorch3D")
    from pytorch3d import _C  # Fail before producing partial videos if the extension is absent.
    if not hasattr(_C, "rasterize_points"):
        raise RuntimeError("PyTorch3D point rasterization extension is unavailable")
    options, project = spec["options"], spec["project"]
    nframes, fps = options["numFrames"], options["fps"]
    width, height = options["width"], options["height"]
    with np.load(spec["scenePath"], allow_pickle=False) as data:
        scene = dict(data)
    intrinsic_front = resize_intrinsic(scene["intrinsic"], scene["image_size"], (height, width))
    # A recorded fixed camera may use another focal length, but the first frame
    # must match the source reference. Validate this before creating conditions.
    calibration = project["calibration"]
    reference = finite_array(scene["intrinsic"], (3, 3))
    recorded = finite_array(calibration["intrinsic"], (3, 3))
    if not np.allclose(reference, recorded, rtol=1e-5, atol=1e-4):
        raise ValueError("Recorded camera K differs from reconstructed reference K")
    if [calibration["imageHeight"], calibration["imageWidth"]] != scene["image_size"].tolist():
        raise ValueError("Recorded camera resolution differs from the reconstruction")
    if any(abs(x) > 1e-10 for x in calibration["distortion"]["coefficients"]):
        raise ValueError("Nonzero distortion needs an explicit rectification adapter")
    intrinsic = legacy_intrinsic(intrinsic_front)
    camera = project.get("camera")
    camera_clip = project.get("cameraClip")
    if bool(camera) != bool(camera_clip):
        raise ValueError("Camera trajectory and clip must be provided together")
    poses = [sample_pose(camera, camera_clip, frame/fps) if camera else
             {"position": [0, 0, 0], "quaternion": [0, 0, 0, 1]} for frame in range(nframes)]
    c2ws = np.stack([pose_matrix(pose) for pose in poses])
    if not np.allclose(c2ws[0], scene["reference_c2w"], atol=1e-4):
        raise ValueError("The first camera pose must match the reference camera")
    if (nframes-1)/fps > project["duration"]+1e-6:
        raise ValueError("Output frame times exceed the project duration")
    objects, occupied = [], np.empty(0, dtype=np.uint32)
    rng = np.random.default_rng(options["seed"])
    for descriptor in spec["objects"]:
        item = descriptor["object"]
        with np.load(descriptor["path"], allow_pickle=False) as data:
            cloud = dict(data)
        if np.intersect1d(occupied, cloud["point_ids"]).size:
            raise ValueError("Object point sets overlap")
        occupied = np.concatenate((occupied, cloud["point_ids"]))
        if not np.allclose(cloud["center"], item["initialPose"]["position"], atol=1e-5):
            raise ValueError("Object initial position differs from its fitted center")
        if item["motion"] not in ("static", "trajectory") or (item["motion"] == "trajectory" and not item.get("trajectory")):
            raise ValueError("Assign every object's motion before export")
        selected = rng.choice(len(cloud["xyz"]), options["pointsPerObject"], replace=len(cloud["xyz"]) < options["pointsPerObject"])
        objects.append((item, cloud, selected))
    sample = output / "sample"
    videos = sample / "render_output"
    videos.mkdir(parents=True, exist_ok=True)
    first = Image.open(spec["referencePath"]).convert("RGB").resize((width, height), Image.Resampling.LANCZOS)
    first.save(sample / "first_image.png")
    tracks = {str(index): [] for index in range(len(objects))}
    box_frames = []
    writer_options = {"fps": fps, "codec": "libx264", "quality": 9, "macro_block_size": 1,
                      "pixelformat": "yuv420p", "ffmpeg_log_level": "error"}
    with imageio.get_writer(str(videos / "render_with_2d_bbox.mp4"), **writer_options) as rgb_writer, \
            imageio.get_writer(str(videos / "render_mask.mp4"), **writer_options) as mask_writer:
        for frame, c2w in enumerate(c2ws):
            boxes = []
            w2c = np.linalg.inv(c2w)
            for index, (item, cloud, selected) in enumerate(objects):
                pose = sample_pose(item["trajectory"], item["clip"], frame/fps) if item["motion"] == "trajectory" else item["initialPose"]
                moved = transform_object(cloud["xyz"], item["initialPose"], pose)
                camera_points = moved @ w2c[:3, :3].T + w2c[:3, 3]
                tracks[str(index)].append(camera_points[selected])
                boxes.append(projected_box(camera_points, intrinsic, width, height))
            # Moved points drive only the box/OMM. Geometry stays at its reference
            # locations, including the object's original points (paper §3.3).
            rendered, holes = render_points(scene["xyz"], scene["rgb"], intrinsic, c2w,
                                             height, width, options["radius"], options["pointsPerPixel"])
            rgb = Image.fromarray(np.clip(rendered*255, 0, 255).astype(np.uint8))
            draw = ImageDraw.Draw(rgb)
            for box in boxes:
                if box is not None:
                    draw.rectangle(box, outline=(255, 0, 0), width=2)
            if frame == 0:
                rgb, holes = first, np.zeros((height, width), dtype=bool)
            rgb_writer.append_data(np.asarray(rgb))
            mask_writer.append_data(np.repeat((holes.astype(np.uint8)*255)[..., None], 3, axis=2))
            box_frames.append(boxes)
            print("export frame %d/%d" % (frame+1, nframes), flush=True)
    arrays = {"cam_c2w": c2ws.astype(np.float32), "intrinsic": intrinsic.astype(np.float32)}
    mapping = {}
    for index, (item, cloud, selected) in enumerate(objects):
        key = str(index)
        mapping[key] = item["id"]
        arrays["camera_3d_pred_%s_sampled" % key] = np.asarray(tracks[key], dtype=np.float32)
        arrays["source_point_ids_%s" % key] = cloud["point_ids"][selected]
    np.savez_compressed(sample / "spatialtracker2.npz", **arrays)
    (sample / "full_prompt.json").write_text(json.dumps({"full_prompt": project["prompt"]}, ensure_ascii=False))
    prompts = {str(index): item["prompt"] for index, (item, _, _) in enumerate(objects)}
    (sample / "prompt-didi.json").write_text(json.dumps({"objects": prompts, "object_number": len(objects),
                                                       "scene_description": project["prompt"]}, ensure_ascii=False))
    with (output / "validation.csv").open("w", newline="") as stream:
        writer = csv.writer(stream)
        writer.writerow(["path"])
        writer.writerow([str(sample)])
    manifest = {"version": 1, "renderVersion": 2, "strategy": "reference_scene_with_projected_boxes_v2", "source": spec["source"],
                "controls": project.get("controls", {"object": bool(objects), "camera": bool(camera)}),
                "options": options, "entityMapping": mapping, "boxes": box_frames,
                "intrinsic": intrinsic.tolist(), "frontendIntrinsic": intrinsic_front.tolist(),
                "pixelCenters": "half_integer", "objectCoordinates": "per_frame_opencv_camera",
                "maskOneMeans": "no_point_coverage", "firstFrameMask": 0,
                "referenceCameraAligned": True, "modelQualityValidation": "pending_real_inference"}
    (output / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, allow_nan=False))
    with zipfile.ZipFile(output / "conditions.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(sample.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(output))
        archive.write(output / "manifest.json", "manifest.json")
        # Downloaded packages use a portable relative CSV; deployed CSV is absolute.
        archive.writestr("validation.csv", "path\nsample\n")
    return {"validationCsv": str(output / "validation.csv"), "numFrames": nframes, "fps": fps,
            "width": width, "height": height, "maxArea": width*height, "numEntities": len(objects),
            "strategy": manifest["strategy"], "renderStrategy": manifest["strategy"], "qualityValidation": "pending_real_inference"}
