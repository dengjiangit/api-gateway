#!/usr/bin/env python3
# mock B：模拟"modelscope"平台的 200 响应（端口 9092）
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

class H(BaseHTTPRequestHandler):
    def do_POST(self):
        n = int(self.headers.get('content-length', '0'))
        body = self.rfile.read(n) if n else b''
        try:
            j = json.loads(body); model = j.get('model', '?')
        except Exception:
            model = '?'
        print(f"[mock-MS] 200  model={model}  path={self.path}", file=sys.stderr, flush=True)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        out = json.dumps({
            "id": "mock-ms", "object": "chat.completion", "created": 0, "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "ok-from-modelscope"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}
        }).encode()
        self.send_header('Content-Length', str(len(out))); self.end_headers()
        self.wfile.write(out)
    def log_message(self, *a, **k): pass

HTTPServer(('127.0.0.1', 9092), H).serve_forever()