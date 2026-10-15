// 内容审核场景 mock：验证网关对上游 400 data_inspection_failed 的处理
// 用法: node mock_moderation.js <port> <blocked|ok>
const http = require('http');
const port = Number(process.argv[2]);
const mode = process.argv[3] || 'ok';

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    if (mode === 'blocked') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        code: 'data_inspection_failed',
        message: '<400> InternalError.Algo.DataInspectionFailed: Input text data may contain inappropriate content.',
        param: null,
        type: 'data_inspection_failed',
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock-ok', object: 'chat.completion', model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'mock-ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 2 },
      }));
    }
  });
}).listen(port, '127.0.0.1', () => console.log(`[mock] ${mode} listening on 127.0.0.1:${port}`));
