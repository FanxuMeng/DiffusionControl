import os
from pathlib import Path

from .common import Problem, load_json, within, regular_path

PROJECT_ROOT = Path(__file__).resolve().parents[2]


class Settings:
    def __init__(self, raw, project_root=PROJECT_ROOT):
        self.root = Path(project_root).resolve()
        self.state = within(self.root / raw.get("stateRoot", "var"), [self.root])
        self.projects = regular_path(self.root / raw.get("projectsRoot", "projects"), self.root)
        self.listen_host = raw.get("listenHost", "127.0.0.1")
        self.port = raw.get("port", 8000)
        self.allowed_hosts = set(raw.get("allowedHosts", ["localhost", "127.0.0.1"]))
        if self.listen_host not in ("127.0.0.1", "0.0.0.0") or type(self.port) is not int or not 1024 <= self.port <= 65535:
            raise ValueError("Invalid listenHost or port")
        if not self.allowed_hosts or any(not isinstance(host, str) or not host or any(c in host for c in "/*:@?# ") for host in self.allowed_hosts):
            raise ValueError("allowedHosts must contain explicit hostnames or IPv4 addresses")
        self.read_roots = [Path(p).resolve() for p in raw.get("allowedReadRoots", [str(self.root)])]
        self.read_roots.append(self.root)
        self.environments = {k: Path(v) for k, v in raw.get("environments", {}).items()}
        self.slurm = raw["slurm"]
        self.poll_seconds = max(5, float(raw.get("pollSeconds", 15)))
        self.command_timeout = max(1, min(30, float(raw.get("commandTimeoutSeconds", 10))))
        self.models = {}
        self.workflow = raw.get("workflow", {})
        for entry in raw.get("models", []):
            profile_path = within(self.root / entry["profile"], [self.root])
            profile = load_json(profile_path)
            key = (profile["id"], profile["version"])
            if key in self.models:
                raise ValueError("Duplicate registered model")
            model = dict(entry, profile=profile)
            model["workdir"] = within(entry["workdir"], self.read_roots)
            if entry["adapter"] not in ("symphomotion", "generic"):
                raise ValueError("Unsupported adapter")
            if not any(p["key"] == "output_dir" and p["type"] == "path" for p in profile["parameters"]):
                raise ValueError("Registered model must expose an output_dir path parameter")
            self.models[key] = model

    @classmethod
    def load(cls):
        path = os.environ.get("DIFFUSIONCONTROL_CONFIG", "backend/config.local.json")
        path = within(PROJECT_ROOT / path, [PROJECT_ROOT])
        if not path.exists() and "DIFFUSIONCONTROL_CONFIG" not in os.environ:
            path = PROJECT_ROOT / "backend/config.example.json"
        return cls(load_json(path))

    def model(self, raw, enabled=True):
        try:
            model = self.models.get((raw.get("profileId"), raw.get("profileVersion")))
        except TypeError:
            model = None
        if not model:
            raise Problem("服务器未注册此模型版本", "model_not_registered")
        if enabled and not model.get("enabled", False):
            raise Problem(model.get("disabledReason", "模型尚未启用"), "model_not_ready")
        return model

    def capabilities(self):
        profiles, unavailable = [], []
        for model in self.models.values():
            profile = model["profile"]
            item = {"id": profile["id"], "version": profile["version"],
                    "environmentNames": [name for name in model.get("environmentNames", []) if name in self.environments]}
            if model.get("enabled") and model["workdir"].is_dir():
                profiles.append(item)
            else:
                unavailable.append(dict(item, reason=model.get("disabledReason", "模型目录不可用"),
                                        inputDefaults=model.get("inputDefaults", {})))
        scheduler = all(Path(self.slurm[name]).is_file() and os.access(self.slurm[name], os.X_OK)
                        for name in ("sbatch", "squeue", "sacct", "scancel"))
        return {"apiVersion": 2, "profiles": profiles if scheduler else [],
                "executionModes": ["slurm_sbatch_v1"] if scheduler else [],
                "unavailableProfiles": unavailable, "schedulerCommandsAvailable": scheduler}
