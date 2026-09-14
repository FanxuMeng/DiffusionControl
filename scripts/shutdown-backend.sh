#!/bin/bash
# 优雅关闭 DiffusionControl 后端服务，并同时清理端口转发。
# 读取 var/backend.pid，向该进程发送 SIGTERM 触发 uvicorn 优雅关闭
# （lifespan 会先停止 Slurm 协调线程、关闭 SQLite），等待其退出；
# 超时未退出则发送 SIGKILL 强制终止。退出后清理 PID 文件，
# 再调用 scripts/close-port-forward.sh 处理端口转发。
#
# 注意：VS Code Remote-SSH 的端口转发由本地客户端持有，服务端无法终止，
#       脚本会检测并打印客户端关闭步骤，详见 scripts/close-port-forward.sh。
set -uo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

ROOT="$(pwd)"
PIDFILE="$ROOT/var/backend.pid"
FORWARD_SCRIPT="$ROOT/scripts/close-port-forward.sh"

# 可选参数：等待优雅退出的秒数，默认 15。
TIMEOUT=15
if [ $# -gt 0 ]; then
    if [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]; then
        TIMEOUT="$1"
    else
        echo "用法: $0 [超时秒数（正整数，默认 15）]" >&2
        exit 2
    fi
fi

# 关闭后端之后再清理端口转发；脚本缺失时不阻断关闭流程。
cleanup_port_forward() {
    echo
    if [ -x "$FORWARD_SCRIPT" ]; then
        "$FORWARD_SCRIPT" || true
    else
        echo "提示：未找到 $FORWARD_SCRIPT，跳过端口转发清理。"
        echo "      若 VS Code 的端口转发仍然开启，请在 Ports 面板中手动停止转发。"
    fi
}

if [ ! -s "$PIDFILE" ]; then
    echo "后端未运行：找不到 PID 文件 $PIDFILE"
    cleanup_port_forward
    exit 0
fi

PID="$(tr -d '[:space:]' < "$PIDFILE")"
if [[ ! "$PID" =~ ^[0-9]+$ ]]; then
    echo "PID 文件内容无效：$PID" >&2
    exit 1
fi

if ! kill -0 "$PID" 2>/dev/null; then
    echo "后端进程 $PID 已退出（PID 文件残留），清理后退出"
    rm -f "$PIDFILE"
    cleanup_port_forward
    exit 0
fi

# 安全校验：确认该进程确是本后端，避免 PID 被污染后误杀其他进程。
CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null)"
if [[ "$CMDLINE" != *"backend.diffusioncontrol"* ]]; then
    echo "拒绝关闭：PID $PID 的进程并非 DiffusionControl 后端（$CMDLINE）" >&2
    exit 1
fi

echo "正在关闭后端 (PID $PID) ..."
kill -TERM "$PID" 2>/dev/null || true

# 等待优雅退出。
for _ in $(seq 1 "$TIMEOUT"); do
    if ! kill -0 "$PID" 2>/dev/null; then
        rm -f "$PIDFILE"
        echo "后端已优雅关闭"
        cleanup_port_forward
        exit 0
    fi
    sleep 1
done

# 超时：强制终止。
echo "优雅关闭超时（${TIMEOUT}s），发送 SIGKILL ..."
kill -KILL "$PID" 2>/dev/null || true
sleep 1
if kill -0 "$PID" 2>/dev/null; then
    echo "强制终止失败，请手动检查进程 $PID" >&2
    exit 1
fi
rm -f "$PIDFILE"
echo "后端已强制关闭"
cleanup_port_forward
exit 0
