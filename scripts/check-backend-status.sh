#!/bin/bash
# 判断 DiffusionControl 后端服务运行状态。
# 依据：var/backend.pid 记录的 PID 是否存活，以及 /api/health 是否返回 200。
# 退出码：0 = 运行中；1 = 未运行；2 = 用法错误。
set -uo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

ROOT="$(pwd)"
PIDFILE="$ROOT/var/backend.pid"
PYTHON=/home/225015066/miniconda3/bin/python

# 监听地址与端口：优先 config.local.json，回退 config.example.json。
CONFIG="$ROOT/backend/config.local.json"
[ -f "$CONFIG" ] || CONFIG="$ROOT/backend/config.example.json"

read -r HOST PORT < <("$PYTHON" - "$CONFIG" <<'PY'
import json, sys
cfg = json.load(open(sys.argv[1]))
print(cfg.get("listenHost", "127.0.0.1"), cfg.get("port", 8000))
PY
)
# 0.0.0.0 无法直连，健康检查统一走回环。
CHECK_HOST="$HOST"
[ "$CHECK_HOST" = "0.0.0.0" ] && CHECK_HOST="127.0.0.1"
URL="http://$CHECK_HOST:$PORT/api/health"

# 1) PID 文件与进程存活。
PID=""
PID_ALIVE=0
if [ -s "$PIDFILE" ]; then
    PID="$(tr -d '[:space:]' < "$PIDFILE")"
    if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
        PID_ALIVE=1
    fi
fi

# 2) HTTP 健康检查。
HTTP_CODE="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$URL" 2>/dev/null)"
HTTP_BODY="$(curl -s --max-time 3 "$URL" 2>/dev/null)"

RUNNING=0
[ "$HTTP_CODE" = "200" ] && RUNNING=1

# 输出结果。
if [ "$RUNNING" -eq 1 ]; then
    STATUS="运行中 (RUNNING)"
    CODE=0
else
    STATUS="未运行 (NOT RUNNING)"
    CODE=1
fi

case "$HTTP_CODE" in
    200) HTTP_DESC="200 OK" ;;
    ''|000) HTTP_DESC="无法连接/无响应" ;;
    *) HTTP_DESC="$HTTP_CODE" ;;
esac

echo "后端服务状态: $STATUS"
echo "  监听地址:     $HOST:$PORT"
echo "  健康检查:     $URL"
echo "  HTTP 状态码:  $HTTP_DESC"
echo "  PID 文件:     $PIDFILE"
if [ -n "$PID" ]; then
    echo "  记录 PID:     $PID"
    if [ "$PID_ALIVE" -eq 1 ]; then
        echo "  进程存活:     是"
        if [ -r "/proc/$PID/cmdline" ]; then
            echo "  进程命令行:   $(tr '\0' ' ' < "/proc/$PID/cmdline")"
        fi
    else
        echo "  进程存活:     否（PID 文件残留，进程已退出）"
    fi
else
    echo "  记录 PID:     （无）"
fi
if [ "$RUNNING" -eq 1 ]; then
    echo "  健康响应:     $HTTP_BODY"
fi

exit "$CODE"
