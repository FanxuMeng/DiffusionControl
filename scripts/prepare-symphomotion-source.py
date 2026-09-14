#!/usr/bin/env python3
"""Copy pinned inference source into this project, excluding datasets/weights."""
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path("/home/225015066/dev-projects/SymphoMotion")
REVISION = "bf9af6666c0f8cbb594e64f165be79b44c962763"


def main():
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=SOURCE, text=True).strip()
    if revision != REVISION:
        raise RuntimeError("Upstream revision differs from the registered profile; review before copying")
    modified = subprocess.check_output(["git", "diff", "HEAD", "--name-only"], cwd=SOURCE, text=True).strip()
    if modified:
        raise RuntimeError("Upstream has modified tracked files; refusing an ambiguous copy")
    destination = ROOT / "third_party/SymphoMotion"
    if destination.exists():
        raise RuntimeError("Destination already exists; preserve and inspect it instead of overwriting")
    files = subprocess.check_output(["git", "ls-files", "-z"], cwd=SOURCE).decode().split("\0")
    selected = [name for name in files if name and not name.startswith(("assets/", "img/", "pretrained_", ".git"))
                and (Path(name).suffix in (".py", ".json", ".yaml", ".yml", ".txt", ".md", ".sh") or Path(name).name.startswith("LICENSE"))]
    for name in selected:
        source = SOURCE/name
        if source.is_symlink() or not source.is_file():
            raise RuntimeError("Unexpected source entry: " + name)
        target = destination/name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target)
    (destination/"source-revision.json").write_text(json.dumps({"revision": revision, "source": str(SOURCE), "files": selected}, indent=2))
    print("Prepared %d inference source files at %s" % (len(selected), destination))


if __name__ == "__main__":
    main()
