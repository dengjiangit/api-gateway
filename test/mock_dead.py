# 上游 mock：GET /v1/models 与 POST /v1/chat/completions 都返回 500，模拟死亡账号（探活应标 dead）
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9094

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body_out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body_out)))
        self.end_headers()
        self.wfile.write(body_out)

    def do_GET(self):
        print(f"[mock-dead GET] {self.path} 500", file=sys.stderr, flush=True)
        self._send(500, {"error": {"message": "service unavailable"}})

    def do_POST(self):
        print(f"[mock-dead POST] {self.path} 500", file=sys.stderr, flush=True)
        self._send(500, {"error": {"message": "service unavailable"}})

    def log_message(self, *a, **k): pass

HTTPServer(('127.0.0.1', PORT), H).serve_forever()
