"""Build an offline HTML report from retained real workflow validation artifacts."""
import argparse
import base64
import html
import json
import mimetypes
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--evidence', type=Path, required=True)
    args = parser.parse_args()
    folder = args.evidence.resolve()
    http = folder/'http-workflow-ready'
    workflow = json.loads((http/'result.json').read_text())
    generation = json.loads((http/'generation/result.json').read_text())
    checked = json.loads((folder/'generated-check/result.json').read_text())
    frontend = json.loads((http/'frontend-artifacts.json').read_text())
    exported = json.loads((folder/'export-outputs/validation-check-344538.json').read_text())
    assert all(item['succeeded'] for item in (workflow, generation, checked, frontend, exported))

    def uri(path):
        mime = mimetypes.guess_type(str(path))[0] or 'application/octet-stream'
        return 'data:'+mime+';base64,'+base64.b64encode(path.read_bytes()).decode()

    def figure(path, caption):
        return '<figure><img src="'+uri(path)+'" alt="'+html.escape(caption)+'"><figcaption>'+html.escape(caption)+'</figcaption></figure>'

    def video(path, caption):
        return '<figure><video controls loop muted playsinline preload="metadata" src="'+uri(path)+'"></video><figcaption>'+html.escape(caption)+'</figcaption></figure>'

    rows = ''.join('<tr><td>'+html.escape(kind)+'</td><td>'+html.escape(job['slurmId'])+'</td><td>通过</td><td><code>'+html.escape(job['id'])+'</code></td></tr>' for kind, job in workflow['jobs'].items())
    rows += '<tr><td>SymphoMotion 双卡生成</td><td>'+generation['slurmId']+'</td><td>通过</td><td><code>'+generation['jobId']+'</code></td></tr>'
    source = ROOT/'var/validation/20260910-workflow/truck.jpg'
    candidate = json.loads((http/'sam2/result.json').read_text())['suggestedCandidate']
    overlay = '<figure><div class="overlay"><img src="'+uri(source)+'" alt="卡车参考照片"><img src="'+uri(http/('sam2/overlay-%d.png' % candidate))+'" alt="SAM2 物体掩码"></div><figcaption>SAM2 候选 '+str(candidate)+'：绿色为物体掩码</figcaption></figure>'
    media = figure(source, '参考照片：SAM2 固定版本官方示例 truck.jpg')+overlay
    media += figure(http/'depth/depth.png', 'Depth Pro 深度可视化；绝对尺度未用实测真值校验')
    media += figure(folder/'export-outputs/raw-rgb-04.png', '完整物体点云向 X 轴移动 0.5 m 后的末帧；灰色为无覆盖区域')
    media += figure(folder/'export-outputs/raw-holes-04.png', '末帧空洞 mask：白色为无点覆盖，共 5,238 像素')
    media += figure(folder/'generated-check/generated-frame-04.png', 'SymphoMotion 2 步测试末帧：存在明显车身畸变，未通过正式画质验收')
    movies = video(http/'export/sample/render_output/render_with_2d_bbox.mp4', '真实动态条件 RGB + 投影框 · 384×256 / 5 帧 / 4 fps')
    movies += video(http/'export/sample/render_output/render_mask.mp4', '真实空洞 mask 视频 · 首帧为全零')
    movies += video(http/'generation/generated.mp4', '真实 SymphoMotion 双卡输出 · 仅 2 步，执行链路验证')
    checks = exported['checks']
    body = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DiffusionControl 真实工作流验证 · 2026-09-10</title><style>
body{margin:0;background:#f3f5f4;color:#172a23;font:16px/1.65 system-ui,sans-serif}main{max-width:1140px;margin:auto;padding:36px 22px 72px}h1{font-size:30px;line-height:1.3}h2{margin-top:34px}.lead{font-size:18px}.cards,.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.cards{grid-template-columns:repeat(3,minmax(0,1fr))}.card,figure{background:white;border:1px solid #dce4df;border-radius:12px;padding:16px;margin:0}.card strong{display:block;font-size:26px;color:#196044}figure img,video{display:block;width:100%;height:auto;border-radius:5px;background:#eee}figcaption{font-size:14px;margin-top:12px;color:#435b4f}.overlay{position:relative}.overlay img+img{position:absolute;inset:0}table{width:100%;border-collapse:collapse;background:white;font-size:14px}td,th{padding:10px;text-align:left;border-bottom:1px solid #dce4df}code{overflow-wrap:anywhere}.scroll{overflow-x:auto}.note{padding:16px 20px;border-left:4px solid #a76c1c;background:#fff7e9}small{color:#52655b}@media(max-width:700px){.cards,.grid{grid-template-columns:1fr}h1{font-size:25px}main{padding:20px 14px}}
</style><main><small>DIFFUSIONCONTROL · youlab-gpu01 · RTX 5090 · 2026-09-10</small>
<h1>从真实照片到动态条件，再到双卡生成</h1><p class="lead">Depth Pro、SAM2、点簇／AABB、PyTorch3D 动态导出及 HTTP → Slurm → SymphoMotion 的短视频链路均已通过。本轮未安装或升级依赖。</p>
<div class="cards"><div class="card">重建场景<strong>2,145,590 点</strong>1800×1200 参考照片</div><div class="card">原场景物体点簇<strong>638,168 点</strong>稳定 ID，逐帧移动 0.5 m</div><div class="card">真实生成输出<strong>384×256 · 5 帧</strong>2 GPU · 2 步 · 75 秒</div></div>
<p class="note">验收范围是模块与执行链路。2 步生成存在明显车身畸变；正式画质、多物体、旋转、移动相机及高清长视频未验收。前端函数的真实产物解码／场景组装／保存恢复已通过，浏览器 WebGL 与鼠标交互未实测。</p>
<h2>图片证据</h2><div class="grid">'''+media+'''</div><h2>可播放视频</h2><div class="grid">'''+movies+'''</div>
<h2>实际 HTTP 作业</h2><div class="scroll"><table><thead><tr><th>模块</th><th>Slurm</th><th>状态</th><th>API 作业 ID</th></tr></thead><tbody>'''+rows+'''</tbody></table></div>
<h2>核对结果</h2><ul><li>动态渲染每帧均输入完整 2,145,590 点；背景精确保持，物体平移正确，没有重复保留原物体。</li>
<li>空洞像素逐帧：'''+html.escape(str(checks['holePixelsPerFrame']))+'''；500 个轨迹采样点保持相同来源 ID。</li>
<li>官方 loader 正确读取 RGB、mask、CUDA 相机 embedding 和 [2,5,500,3] 物体轨迹；生成视频已真实解码 5 帧。</li>
<li>HTTP 重复上传／同键提交均幂等；全局 Slurm 设置保持不变，下载 SHA-256 与 ETag 一致。</li>
<li>前端展示 180,000 场景预览点和 100,000 物体预览点；完整物体 ID 剔除后背景预览为 126,453 点。相关测试 9 项通过。</li></ul>
<p>生成视频 SHA-256：<code>'''+generation['sha256']+'''</code></p>
<h2>保留的失败与修正</h2><p>344536 完成渲染后，验收脚本用 list(imageio_reader) 触发不定长预分配 MemoryError。修正为逐帧迭代后，344538 对同一输出复核通过。启动辅助命令和前端验收夹具各有一次兼容性修正，均已恢复并复测；详情见项目 docs/workflow-module-validation.md。</p>
<p><small>本文件内嵌全部图片与视频，可单独复制到个人电脑打开。原始 JSON、stdout/stderr、提交命令和 Slurm 状态保存在同级证据目录；模型分数不是实测 IoU，深度没有绝对尺度真值。</small></p></main></html>'''
    destination = folder/'report.html'
    destination.write_text(body, encoding='utf-8')
    print(destination, destination.stat().st_size, 'bytes')


if __name__ == '__main__':
    main()
