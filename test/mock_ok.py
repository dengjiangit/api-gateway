# 上游 mock：GET /v1/models 与 POST /v1/chat/completions 都返回 200，模拟健康账号
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9091

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body_out = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body_out)))
        self.end_headers()
        self.wfile.write(body_out)

    def do_GET(self):
        print(f"[mock-ok GET] {self.path} 200", file=sys.stderr, flush=True)
        self._send(200, {"object": "list", "data": [{"id": "chat-model", "object": "model"}]})

    def do_POST(self):
        n = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(n) if n else b''
        try:
            model = json.loads(body).get('model', '?')
        except Exception:
            model = '?'
        print(f"[mock-ok POST] {self.path} model={model} 200", file=sys.stderr, flush=True)
        self._send(200, {
            "id": "mock-1", "object": "chat.completion", "created": 0, "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        })

    def log_message(self, *a, **k): pass

HTTPServer(('127.0.0.1', PORT), H).serve_forever()
