#!/bin/bash
# 关闭与后端端口相关的端口转发。
#
# 为什么 shutdown-backend.sh 单独一步做不到：
#   VS Code Remote-SSH 的端口转发由“本地 VS Code 客户端”持有。客户端向远程
#   服务器请求建立一条到 localhost:<port> 的隧道，远程服务器只负责维持，并在
#   后端退出后不断重试。证据见远程日志
#   ~/.vscode-server/data/logs/<ts>/remoteagent.log 中的
#   "Failed to connect tunnel to localhost:8000"。
#   因此杀掉监听该端口的 Python 进程不会移除这条转发。
#
#   本脚本把“关闭端口转发”拆成两类分别处理：
#     1) 服务端中继进程（ssh -L/-R/-D、autossh、plink、socat）——直接终止；
#     2) VS Code 隧道——服务端无法终止，只检测并打印客户端操作步骤。
#
# 用法：
#   scripts/close-port-forward.sh [--check] [端口]
#     --check  只检测，不终止任何进程
#     端口     默认读取 backend/config.local.json（回退 config.example.json）中的 port
#
# 退出码：0 = 服务端已无转发（或已成功清理）；1 = 清理失败；2 = 用法错误。
set -uo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

ROOT="$(pwd)"
PYTHON=/home/225015066/miniconda3/bin/python

CHECK_ONLY=0
PORT=""
for arg in "$@"; do
    case "$arg" in
        --check|-c)
            CHECK_ONLY=1
            ;;
        ''|*[!0-9]*)
            echo "用法: $0 [--check] [端口]" >&2
            exit 2
            ;;
        *)
            PORT="$arg"
            ;;
    esac
done

if [ -n "$PORT" ] && { [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; }; then
    echo "用法: $0 [--check] [端口]（端口范围 1-65535）" >&2
    exit 2
fi

# 端口：命令行优先，其次后端配置，最后回退 8000。
if [ -z "$PORT" ]; then
    CONFIG="$ROOT/backend/config.local.json"
    [ -f "$CONFIG" ] || CONFIG="$ROOT/backend/config.example.json"
    PORT="$("$PYTHON" - "$CONFIG" <<'PY'
import json, sys
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        print(int(json.load(fh).get("port", 8000)))
except Exception:
    print(8000)
PY
)"
fi

echo "端口转发清理：目标端口 $PORT"
if [ "$CHECK_ONLY" -eq 1 ]; then
    echo "  模式：只检测（--check），不会终止任何进程"
fi

# ---- 1) 服务端中继进程 -------------------------------------------------
# 只匹配“转发形态”的命令行，避免误伤同名的普通 ssh/socat 会话。
# 判定条件：可执行文件为 ssh/autossh/plink/socat，端口作为独立数字出现，
# 且命令行带 -L/-R/-D（ssh 系）或 TCP-LISTEN/127.0.0.1 目标（socat）。
find_relay_pids() {
    local port="$1" pid cmd prog base
    ps -u "$(id -u)" -o pid= 2>/dev/null | while read -r pid; do
        [ -n "$pid" ] || continue
        [ -r "/proc/$pid/cmdline" ] || continue
        cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
        [ -n "$cmd" ] || continue
        prog="${cmd%% *}"
        base="${prog##*/}"
        case "$base" in
            ssh|autossh|plink|socat) ;;
            *) continue ;;
        esac
        [[ "$cmd" =~ (^|[^0-9])"$port"([^0-9]|$) ]] || continue
        case "$base" in
            ssh|autossh|plink)
                [[ "$cmd" =~ (^|[[:space:]])(-L|-R|-D) ]] || continue
                ;;
            socat)
                [[ "$cmd" == *"TCP-LISTEN:$port"* || "$cmd" == *"127.0.0.1:$port"* || "$cmd" == *"localhost:$port"* ]] || continue
                ;;
        esac
        echo "$pid"
    done
}

RELAY_PIDS=()
while IFS= read -r _pid; do
    [ -n "$_pid" ] && RELAY_PIDS+=("$_pid")
done < <(find_relay_pids "$PORT")

KILL_FAILED=0
if [ "${#RELAY_PIDS[@]}" -eq 0 ]; then
    echo "  服务端中继进程：未发现（ssh -L/-R/-D、autossh、plink、socat）"
else
    for pid in "${RELAY_PIDS[@]}"; do
        cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
        if [ "$CHECK_ONLY" -eq 1 ]; then
            echo "  服务端中继进程：$pid  $cmd"
        else
            echo "  终止服务端中继进程 $pid：$cmd"
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    if [ "$CHECK_ONLY" -eq 0 ]; then
        sleep 1
        for pid in "${RELAY_PIDS[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                kill -KILL "$pid" 2>/dev/null || true
            fi
        done
        sleep 1
        for pid in "${RELAY_PIDS[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                echo "  终止失败：$pid 仍在运行，请手动检查" >&2
                KILL_FAILED=1
            fi
        done
        if [ "$KILL_FAILED" -eq 0 ]; then
            echo "  服务端中继进程：已全部终止"
        fi
    fi
fi

# ---- 2) VS Code 隧道（只能提示，服务端无法关闭）------------------------
VSCODE_TUNNEL=0

# 2a) 后端已停止时，隧道表现为日志中的失败重试记录。
VLOG="$(ls -t "$HOME"/.vscode-server/data/logs/*/remoteagent.log 2>/dev/null | head -1)"
if [ -n "${VLOG:-}" ] && grep -qE "tunnel to localhost:$PORT([^0-9]|$)" "$VLOG" 2>/dev/null; then
    VSCODE_TUNNEL=1
fi

# 2b) 后端仍在运行时隧道是连通的，表现为 node 进程连到 127.0.0.1:<port>。
if [ "$VSCODE_TUNNEL" -eq 0 ] \
    && ss -tnp 2>/dev/null | grep -E "127\.0\.0\.1:$PORT([^0-9]|$)" | grep -q "node"; then
    VSCODE_TUNNEL=1
fi

if [ "$VSCODE_TUNNEL" -eq 1 ]; then
    cat <<EOF

  警告：检测到 VS Code 端口转发隧道（localhost:$PORT）
        该转发由本地 VS Code 客户端持有，服务端脚本无法终止。
        请在客户端关闭：命令面板 -> "Ports: Focus on Ports View"
        -> 右键端口 $PORT -> "停止转发端口 / Stop Forwarding Port"。
        若不想让它反复出现：在 Remote/工作区设置中关闭
        "Remote: Auto Forward Ports"（remote.autoForwardPorts），
        并取消 "Remote: Restore Forwarded Ports"（remote.restoreForwardedPorts）。
EOF
else
    echo "  VS Code 隧道：未检测到（若本地 VS Code 仍显示该端口，请在 Ports 面板手动移除）"
fi

if [ "$KILL_FAILED" -ne 0 ]; then
    exit 1
fi
exit 0
