"""API v2 command validation, matching the frontend's single-command grammar."""
import json
import math
import re
from datetime import datetime

from .common import Problem, canonical, identifier, safe_text


def tokenize(command):
    safe_text(command, "command", 1048576)
    tokens, token, quote, started, index = [], "", None, False, 0
    while index < len(command):
        char = command[index]
        index += 1
        if quote == "'":
            if char == "'":
                quote = None
            else:
                token += char
            continue
        if char == "\\":
            if index == len(command):
                raise Problem("命令末尾转义不完整")
            nxt = command[index]
            index += 1
            if nxt == "\n":
                continue
            if nxt == "\r" and command[index:index + 1] == "\n":
                index += 1
                continue
            if quote == '"' and nxt not in '$`"\\':
                token += "\\"
            token += nxt
            started = True
            continue
        if quote == '"':
            if char == '"':
                quote = None
            elif char in '$`':
                raise Problem("命令不支持变量或命令替换")
            else:
                token += char
            continue
        if char in "'\"":
            quote, started = char, True
        elif char in "\r\n":
            raise Problem("只允许单条命令")
        elif char.isspace():
            if started:
                tokens.append(token)
            token, started = "", False
        elif char in "|&;<>()$`#*?[]{}~":
            raise Problem("不支持未引用的 shell 操作或展开")
        else:
            token += char
            started = True
    if quote:
        raise Problem("命令引号未闭合")
    if started:
        tokens.append(token)
    if len(tokens) > 4096:
        raise Problem("命令参数过多")
    return tokens


def typed_value(parameter, raw):
    key, kind = parameter["key"], parameter["type"]
    if parameter.get("required") and not raw.strip():
        raise Problem("必需参数不能为空", field=key)
    if raw == "" and not parameter.get("required") and kind not in ("string", "path"):
        if parameter["defaultValue"] != "":
            raise Problem("参数不能为空", field=key)
        return None
    if kind in ("string", "path"):
        return raw
    if kind == "boolean":
        if raw not in ("true", "false"):
            raise Problem("布尔值无效", field=key)
        return raw == "true"
    if kind == "enum":
        if raw not in parameter["choices"]:
            raise Problem("枚举值无效", field=key)
        return raw
    if kind == "list":
        value = json.loads(raw)
        count = parameter["nargs"]
        if (not isinstance(value, list) or len(value) > 1000
                or any(not isinstance(v, str) or "\0" in v for v in value)
                or (count == "+" and not value) or (count != "+" and len(value) != count)):
            raise Problem("列表参数无效", field=key)
        return value
    pattern = r"[+-]?\d+" if kind == "integer" else r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?"
    if not re.fullmatch(pattern, raw.strip()):
        raise Problem("数值格式无效", field=key)
    value = int(raw) if kind == "integer" else float(raw)
    if (not math.isfinite(value) or (kind == "integer" and abs(value) > 9007199254740991)
            or value < parameter.get("min", -math.inf) or value > parameter.get("max", math.inf)):
        raise Problem("数值超出范围", field=key)
    return value


def parse_parameters(profile, argv):
    prefix = profile["commandPrefix"]
    if argv[:len(prefix)] != prefix:
        raise Problem("推理入口与注册模型不一致", field="argv")
    flags, seen = {}, set()
    raw = {p["key"]: p["defaultValue"] for p in profile["parameters"]}
    for p in profile["parameters"]:
        flags[p["flag"]] = (p, True)
        if p.get("falseFlag"):
            flags[p["falseFlag"]] = (p, False)
    index = len(prefix)
    while index < len(argv):
        flag, equal, inline = argv[index].partition("=")
        index += 1
        if flag not in flags:
            raise Problem("未知参数：" + flag, field="argv")
        p, truth = flags[flag]
        key = p["key"]
        if key in seen:
            raise Problem("参数重复：" + key, field=key)
        seen.add(key)
        if p["type"] == "boolean":
            if equal:
                raise Problem("布尔开关不能携带值", field=key)
            raw[key] = "true" if truth else "false"
            continue
        parts = [inline] if equal else []
        count = p.get("nargs", 1) if p["type"] == "list" else 1
        while index < len(argv) and (count == "+" or len(parts) < count):
            if re.match(r"^--?[A-Za-z_]|^--$", argv[index]):
                break
            parts.append(argv[index])
            index += 1
        if not parts or (count != "+" and len(parts) != count):
            raise Problem("参数缺少值", field=key)
        raw[key] = json.dumps(parts) if p["type"] == "list" else parts[0]
    result = {}
    for p in profile["parameters"]:
        if p.get("required") and p["key"] not in seen:
            raise Problem("必需参数必须显式提供", field=p["key"])
        value = typed_value(p, raw[p["key"]])
        if value is not None:
            result[p["key"]] = value
    return result


def validate_request(raw, key, profile):
    fields = {"apiVersion", "requestId", "createdAt", "projectId", "projectName", "projectProfileId",
              "profileId", "profileVersion", "parameters", "argv", "command", "execution"}
    if not isinstance(raw, dict) or set(raw) != fields or type(raw["apiVersion"]) is not int or raw["apiVersion"] != 2:
        raise Problem("只接受完整 API v2 请求")
    for field in ("requestId", "projectId", "projectProfileId", "profileId"):
        identifier(raw[field], field)
    safe_text(raw["projectName"], "projectName", 4096)
    if raw["requestId"] != key:
        raise Problem("Idempotency-Key 必须与 requestId 一致", "idempotency_key_mismatch", 400)
    if (raw["profileId"] != profile["id"] or type(raw["profileVersion"]) is not int
            or raw["profileVersion"] != profile["version"]):
        raise Problem("模型版本不匹配")
    try:
        created = datetime.fromisoformat(safe_text(raw["createdAt"], "createdAt", 64).replace("Z", "+00:00"))
        if created.tzinfo is None:
            raise ValueError()
    except ValueError:
        raise Problem("createdAt 需要带时区的 ISO 时间", field="createdAt")
    argv = raw["argv"]
    if not isinstance(argv, list) or not 1 <= len(argv) <= 4096:
        raise Problem("argv 无效")
    for token in argv:
        safe_text(token, "argv", 65536, empty=True)
    if tokenize(raw["command"]) != argv:
        raise Problem("command 与 argv 不一致")
    parsed = parse_parameters(profile, argv)
    # Compare JSON types as well: bool must not compare equal to numeric 0/1.
    parameters = raw["parameters"]
    if not isinstance(parameters, dict) or set(parameters) != set(parsed):
        raise Problem("parameters 与命令不一致")
    for name, value in parsed.items():
        actual = parameters[name]
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            equal = type(actual) in (int, float) and math.isfinite(actual) and actual == value
        else:
            equal = type(actual) is type(value) and actual == value
        if not equal:
            raise Problem("parameters 与命令不一致", field=name)
    execution = raw["execution"]
    if (not isinstance(execution, dict) or set(execution) != {"kind", "version", "envName", "scriptName", "scriptContent", "argv", "command"}
            or execution["kind"] != "slurm_sbatch" or type(execution["version"]) is not int or execution["version"] != 1):
        raise Problem("Slurm execution 无效")
    for field, maximum in (("envName", 128), ("scriptName", 255)):
        value = execution[field]
        if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,%d}" % (maximum - 1), value):
            raise Problem("Slurm 名称无效", field="execution." + field)
    script = safe_text(execution["scriptContent"], "execution.scriptContent", 262144)
    if len(script.encode("utf-8")) > 262144 or "\r" in script:
        raise Problem("脚本须为 LF 换行且不超过 256 KiB")
    if not re.fullmatch(r"#![ \t]*(?:/(?:[A-Za-z0-9._-]+/)*bash(?:[ \t]+-[A-Za-z]+)?|/usr/bin/env[ \t]+bash|/usr/bin/env[ \t]+-S[ \t]+bash(?:[ \t]+-[A-Za-z]+)?)[ \t]*", script.split("\n", 1)[0]):
        raise Problem("脚本需要 Bash shebang")
    expected = ["sbatch", execution["scriptName"], "ENVNAME=" + execution["envName"]] + argv
    if execution["argv"] != expected or tokenize(execution["command"]) != expected:
        raise Problem("Slurm 包装与模型 argv 不一致")
    return raw
