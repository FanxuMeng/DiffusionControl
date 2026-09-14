#!/usr/bin/env python3
"""Download official checkpoints only to the user-approved PretrainedModels root.

Never overwrites an existing checkpoint. Writes into a private partial file and
publishes a completed download atomically. No model loading or environment changes.
"""
import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
from pathlib import Path

MODEL_ROOT = Path("/home/225015066/PretrainedModels")
SOURCES = {
    "depthpro": [("DepthPro/depth_pro.pt", "https://ml-site.cdn-apple.com/models/depth-pro/depth_pro.pt")],
    "sam2": [("SAM2/sam2.1_hiera_large.pt", "https://dl.fbaipublicfiles.com/segment_anything_2/092824/sam2.1_hiera_large.pt")],
    "symphomotion": [("Symphomotion/pretrained_checkpoints/camera_control/controlnet.pth", "https://huggingface.co/fateforward/Symphomotion/resolve/main/pretrained_checkpoints/camera_control/controlnet.pth"),
                    ("Symphomotion/pretrained_checkpoints/object_control/object_injector.pth", "https://huggingface.co/fateforward/Symphomotion/resolve/main/pretrained_checkpoints/object_control/object_injector.pth")],
}


def download(relative, url):
    path = MODEL_ROOT / relative
    if path.is_symlink():
        raise RuntimeError("Refusing a checkpoint symlink: " + str(path))
    if path.exists():
        if not path.is_file() or path.stat().st_size < 4096:
            raise RuntimeError("Existing path is not a plausible checkpoint; inspect it manually: " + str(path))
        print("Preserving existing checkpoint: " + str(path), flush=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".partial", dir=path.parent)
    hasher, count = hashlib.sha256(), 0
    try:
        with os.fdopen(fd, "wb") as stream, urllib.request.urlopen(url, timeout=90) as response:
            expected = int(response.headers.get("Content-Length", "0"))
            while True:
                chunk = response.read(8*1024*1024)
                if not chunk:
                    break
                stream.write(chunk)
                hasher.update(chunk)
                count += len(chunk)
                if count % (256*1024*1024) == 0:
                    print("%s: %.2f GiB" % (relative, count/1024**3), flush=True)
            stream.flush()
            os.fsync(stream.fileno())
        if count < 4096 or (expected and count != expected):
            raise RuntimeError("Incomplete checkpoint download")
        os.link(temporary, path)  # Fails instead of overwriting a concurrently created file.
        path.with_name(path.name + ".download.json").write_text(json.dumps({"source": url, "bytes": count,
                                                                          "downloadSha256": hasher.hexdigest()}, indent=2))
        print("Downloaded %s (%d bytes, sha256 %s)" % (path, count, hasher.hexdigest()), flush=True)
    finally:
        Path(temporary).unlink(missing_ok=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--models", nargs="+", choices=sorted(SOURCES), default=sorted(SOURCES))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    for name in args.models:
        for relative, url in SOURCES[name]:
            if args.dry_run:
                print(str(MODEL_ROOT/relative) + " <- " + url)
            else:
                download(relative, url)
