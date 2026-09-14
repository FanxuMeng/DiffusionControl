import hashlib
import json
import os
import re
import tempfile
from datetime import datetime, timezone
from pathlib import Path


class Problem(Exception):
    def __init__(self, message, code="invalid_request", status=422, field=None):
        super().__init__(message)
        self.message, self.code, self.status, self.field = message, code, status, field


def now():
    return datetime.now(timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def safe_text(value, field, maximum=65536, empty=False):
    if (not isinstance(value, str) or len(value) > maximum
            or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", value)
            or (not empty and not value.strip())):
        raise Problem("字段格式无效：" + field, field=field)
    return value


def identifier(value, field):
    safe_text(value, field, 200)
    if "\r" in value or "\n" in value:
        raise Problem("ID 不允许换行", field=field)
    return value


def within(path, roots):
    resolved = Path(path).resolve()
    if not any(resolved == root or root in resolved.parents for root in roots):
        raise Problem("路径超出已配置的允许目录", "path_outside_roots")
    return resolved


def regular_path(path, root):
    """Reject unresolved symlinks as well as paths outside the managed root."""
    path, root = Path(path), Path(root)
    try:
        relative = path.relative_to(root)
    except ValueError:
        raise Problem("资产路径不在允许目录内")
    for component in [path] + list(path.parents)[:len(relative.parts)]:
        if component.is_symlink():
            raise Problem("资产不允许符号链接", "asset_invalid", 409)
    return within(path, [root.resolve()])


def atomic_write(path, content):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=".write-", dir=str(path.parent))
    try:
        binary = isinstance(content, bytes)
        with os.fdopen(fd, "wb" if binary else "w", **({} if binary else {"encoding": "utf-8"})) as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, str(path))
        directory = os.open(str(path.parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)
