import argparse
import logging
import os


def main():
    parser = argparse.ArgumentParser(description="DiffusionControl login-node API")
    parser.add_argument("--host", choices=["127.0.0.1", "0.0.0.0"])
    parser.add_argument("--port", type=int)
    args = parser.parse_args()
    if args.port is not None and not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO)
    from .http import create_app
    from .config import Settings
    import uvicorn
    settings = Settings.load()
    app = create_app(settings)
    host, port = args.host or settings.listen_host, args.port or settings.port
    print("监听 %s:%d；浏览器使用节点地址或集群提供的入口访问 /login。" % (host, port))
    print("访问令牌保存在项目 var/access-token，未打印到日志。")
    uvicorn.run(app, host=host, port=port, workers=1, proxy_headers=False, access_log=False)


if __name__ == "__main__":
    main()
