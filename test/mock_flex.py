# 参数化上游 mock：python3 mock_flex.py <port> <200|429>
# 200 -> 返回真实 chat completion；429 -> 返回限流错误
import json, sys
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 9091
MODE = sys.argv[2] if len(sys.argv) > 2 else '200'

class H(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # 供探活用
        self._send(200, {"object": "list", "data": [{"id": "mock", "object": "model"}]})

    def do_POST(self):
        n = int(self.headers.get('content-length', '0'))
        self.rfile.read(n) if n else None
        if MODE == '429':
            self._send(429, {"error": {"type": "quota_exceeded_error", "code": "429", "message": "mock 限流"}})
        else:
            self._send(200, {
                "id": "chatcmpl-mock", "object": "chat.completion", "created": 1,
                "model": "mock", "choices": [{"index": 0, "message": {"role": "assistant", "content": f"OK from mock:{PORT}"}, "finish_reason": "stop"}],
            })

    def log_message(self, *a, **k): pass

print(f"mock_flex listening 127.0.0.1:{PORT} mode={MODE}", file=sys.stderr, flush=True)
HTTPServer(('127.0.0.1', PORT), H).serve_forever()
