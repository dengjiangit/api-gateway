# 上游 mock：始终返回 429，模拟日日新限流
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(n) if n else b''
        try:
            j = json.loads(body)
            model = j.get('model', '?')
        except Exception:
            model = '?'
        auth = self.headers.get('authorization', '')
        # 记录到 stderr 方便观察"哪个 key 被打"
        print(f"[mock] 401-equivalent decision:  ->  429  model={model}  auth={auth[:14]}...", file=sys.stderr, flush=True)
        self.send_response(429)
        self.send_header('Content-Type', 'application/json')
        body_out = json.dumps({"error": {"type": "quota_exceeded_error", "code": "429", "message": "mock 限流"}}).encode()
        self.send_header('Content-Length', str(len(body_out)))
        self.end_headers()
        self.wfile.write(body_out)
    def log_message(self, *a, **k): pass

HTTPServer(('127.0.0.1', 9090), H).serve_forever()
