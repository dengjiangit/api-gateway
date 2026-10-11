#!/usr/bin/env bash
# 启动本地多账号网关（默认 = 自动重启：端口被占时先 kill 旧网关再启动）
# 用法:  ./start.sh [额外参数透传给 server.js，如 --config=xxx]
#        START_NO_KILL=1 ./start.sh  → 端口被占时不杀旧进程，仅提示后退出
set -e
cd "$(dirname "$0")"

if [ ! -f config.json ]; then
  echo "[!] 未找到 config.json，正在从 config.example.json 复制..."
  cp config.example.json config.json
  echo "    请先编辑 config.json，把 accounts[].api_key 换成真实 key"
fi

# 从 config.json 读出监听地址
HOST=$(node -e "try{const c=require('./config.json');console.log(c.host||'127.0.0.1')}catch(e){console.log('127.0.0.1')}" 2>/dev/null)
PORT=$(node -e "try{const c=require('./config.json');console.log(c.port||'8080')}catch(e){console.log('8080')}" 2>/dev/null)

port_free() {
  node -e "
const net=require('net');
const s=net.createServer();
s.once('error',e=>{ process.exit(e.code==='EADDRINUSE'?1:2); });
s.once('listening',()=>{ s.close(); process.exit(0); });
s.listen($PORT,'$HOST');
" 2>/dev/null
}

if port_free; then
  echo "[*] 端口 $HOST:$PORT 空闲，直接启动网关（Ctrl+C 停止）"
else
  if [ "${START_NO_KILL:-0}" = "1" ]; then
    echo "[!] 端口 $HOST:$PORT 已被占用（网关可能已在运行），因 START_NO_KILL=1 不自动重启，退出。"
    echo "    curl -s http://$HOST:$PORT/health"
    exit 0
  fi
  echo "[*] 端口 $HOST:$PORT 已被占用 —— 自动重启：先 kill 旧网关进程"
  pkill -f 'node server.js' 2>/dev/null || true
  ok=0
  for i in $(seq 1 15); do
    if port_free; then ok=1; break; fi
    sleep 0.4
  done
  if [ "$ok" != "1" ]; then
    echo "[!] kill 后端口 $HOST:$PORT 仍被占用（可能被非网关进程占用）。"
    echo "    查看占用者: lsof -nP -iTCP:$PORT -sTCP:LISTEN"
    exit 1
  fi
  echo "[*] 旧进程已清理，端口释放，启动新网关（Ctrl+C 停止）"
fi

exec node server.js "$@"
