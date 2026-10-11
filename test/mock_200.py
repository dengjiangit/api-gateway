# 上游 mock：始终返回 200，模拟可用账号，用来验证粘性 / 切换
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
        print(f"[mock-ok] 200  model={model}  auth={auth[:14]}...", file=sys.stderr, flush=True)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        body_out = json.dumps({
            "id": "mock-1", "object": "chat.completion", "created": 0, "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        }).encode()
        self.send_header('Content-Length', str(len(body_out)))
        self.end_headers()
        self.wfile.write(body_out)
    def log_message(self, *a, **k): pass

HTTPServer(('127.0.0.1', 9091), H).serve_forever()