#!/usr/bin/env python3
"""Demo 本地服务：解决 file:// 下 fetch hud_state.json 被 CORS 拦的问题。

路由：
  /                       -> Demo/index.html
  /state/<相对路径>.json   -> HUD-字段验证工具包/<相对路径>（如 out/hud_state.json、
                              _runs/<run>/last_state.json，只放行 .json/.txt）
  /icons/<path>           -> HUD-字段验证工具包/icons/<path>（byid/*.png 等）
  /overlay                -> index.html 的 ?overlay=1 快捷入口（OBS 浏览器源用）
  /<其它>                 -> Demo/<其它>

只读。桥在另一进程写 out/hud_state.json。
缓存策略：/state/ 永远 no-store（500 ms 原子替换）；/icons/ 长缓存 immutable
（图标内容不变，避免 <img> 重建后再走网络）；其余静态文件 no-cache 每次回源
校验（改完 js/css 刷新页面即生效）。
用法：python serve.py [port]     默认 8770
"""
import http.server
import os
import socketserver
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = HERE

# 自动适配：优先发布布局 (release 同级)，次选标准仓库布局 (assets/release)，最后回退旧开发路径
RELEASE_DIR = os.path.normpath(os.path.join(HERE, '..'))
REPO_ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))

if os.path.isdir(os.path.join(RELEASE_DIR, 'icons')):
    TOOLKIT = RELEASE_DIR
elif os.path.isdir(os.path.join(REPO_ROOT, 'release', 'icons')):
    TOOLKIT = os.path.join(REPO_ROOT, 'release')
elif os.path.isdir(os.path.join(REPO_ROOT, 'assets', 'icons')):
    TOOLKIT = os.path.join(REPO_ROOT, 'assets')
else:
    TOOLKIT = os.path.normpath(os.path.join(
        HERE, '..', '..', 'SpectatorResearch', 'notes', 'reports', 'HUD-字段验证工具包'))
STATE_FILE = os.path.join(TOOLKIT, 'out', 'hud_state.json')
ICON_DIR = os.path.join(TOOLKIT, 'icons')
# ?probe=1 的布局探针落这里
PROBE_LOG = os.path.join(DEMO, '_probe.log')
PROBE_ERR = os.path.join(DEMO, '_probe_error.log')

TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.pcx': 'application/octet-stream',
}


class Handler(http.server.BaseHTTPRequestHandler):
    server_version = 'MODemo/1.0'

    def log_message(self, fmt, *args):
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype, extra=None,
              cache='no-store, no-cache, must-revalidate'):
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', cache)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _file(self, path, ctype=None,
              cache='no-cache, must-revalidate'):
        if not os.path.isfile(path):
            self._send(404, ('not found: %s' % path).encode(), 'text/plain; charset=utf-8')
            return
        with open(path, 'rb') as f:
            body = f.read()
        ext = os.path.splitext(path)[1].lower()
        self._send(200, body, ctype or TYPES.get(ext, 'application/octet-stream'), cache=cache)

    def do_POST(self):
        """页面把 ?probe=1 的布局探针 POST 回来，落到 probe.log，供无头浏览器核验。"""
        path = urllib.parse.urlsplit(self.path).path
        if path not in ('/probe', '/probe-error'):
            return self._send(404, b'no', 'text/plain')

        n = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(n) if n else b''
        log = PROBE_LOG if path == '/probe' else PROBE_ERR
        with open(log, 'ab') as f:
            f.write(body + b'\n')
        self._send(204, b'', 'text/plain')

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        raw = urllib.parse.urlsplit(self.path).path
        path = urllib.parse.unquote(raw)

        if path in ('/', '/index.html'):
            return self._file(os.path.join(DEMO, 'index.html'))

        # OBS 浏览器源快捷入口：直接进覆盖层 + 真实数据。
        # 保留调用方自带的参数（如 &probe=1、&url=...），只补上默认值。
        if path in ('/overlay', '/overlay/'):
            q = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
            q.setdefault('overlay', ['1'])
            q.setdefault('source', ['live'])
            q.setdefault('url', ['/state/out/hud_state.json'])
            loc = '/?' + urllib.parse.urlencode([(k, v[0]) for k, v in q.items()])
            self.send_response(302)
            self.send_header('Location', loc)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return

        if path.startswith('/state/'):
            rel = path[len('/state/'):]
            target = os.path.normpath(os.path.join(TOOLKIT, rel))
            if not target.startswith(TOOLKIT + os.sep):
                return self._send(403, b'forbidden', 'text/plain')
            if os.path.splitext(target)[1].lower() not in ('.json', '.txt'):
                return self._send(403, b'only .json/.txt', 'text/plain')
            # 状态文件每 500 ms 原子替换，必须永远回源
            return self._file(target, cache='no-store, no-cache, must-revalidate')

        if path.startswith('/icons/'):
            rel = path[len('/icons/'):]
            target = os.path.normpath(os.path.join(ICON_DIR, rel))
            if not target.startswith(ICON_DIR + os.sep):
                return self._send(403, b'forbidden', 'text/plain')
            # 图标内容不可变（重建即换目录），长缓存避免 <img> 重建后再走网络
            return self._file(target, cache='public, max-age=86400, immutable')

        rel = path.lstrip('/')
        target = os.path.normpath(os.path.join(DEMO, rel))
        if not target.startswith(DEMO + os.sep):
            return self._send(403, b'forbidden', 'text/plain')
        return self._file(target)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)

    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(('127.0.0.1', port), Handler) as httpd:
        print('Demo      http://127.0.0.1:%d/' % port)
        print('state     %s' % STATE_FILE)
        print('icons     %s' % ICON_DIR)
        print('Ctrl+C 退出')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nbye')


if __name__ == '__main__':
    main()
