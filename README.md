# SenseNova 本地多账号网关

> 让所有 AI 工具统一走这一个本地网关，多个日日新（SenseNova）账号**默认粘性使用**（一个账号用到底），只在遇到 **429 / 超时 / 5xx 时才立即切换下一个账号**，必要时回退到下一个模型。OpenAI & Anthropic 兼容，**零依赖**（Node ≥ 20）。

---

## 一、它做了什么

1. **本地反向代理**：把 `http://127.0.0.1:8080/v1/*` 代理到 `https://token.sensenova.cn/v1/*`，完全兼容 OpenAI / Anthropic SDK。
2. **多账号挂载**：在 `config.json` 里登记任意多个日日新账号（API Key + 它能调的模型列表），网关聚合 `/v1/models`。
3. **粘性使用（默认）**：默认一直用同一个账号，**不轮询**，把账号额度用到极致。
4. **限流 / 超时立即切**：账号返回 `429` / 超时 / `5xx` → **立刻**换下一个账号，并把该账号置入冷却（默认 30s 内不再选）。
5. **可选轮询模式**：把 `rotation` 改成 `"every_request"` 后每次请求都换号，把请求压力均摊到 N 个账号上。
5. **模型回退链**：当首选模型的所有账号都挂了（限流/超时耗尽），按 `model_fallback` 配置自动**切换到下一个模型**。
6. **流式透传**：SSE 流式响应原样转发，下游用 `stream:true` 完全 OK。
7. **可观测**：实时 `GET /admin/status` 看每个账号的请求数、429 数、冷却剩余时间、轮询游标。

---

## 二、目录

```
api-gateway/
├── server.js            # 网关主体（零依赖）
├── ui.html              # WebUI 管理页（零依赖单文件）
├── package.json
├── start.sh             # 启动脚本
├── config.example.json  # 配置模板（提交到 git）
├── config.json          # 你的实际配置（含真实 key，已加入 .gitignore）
├── .gitignore
├── test/                # 本地 mock + 测试配置
└── README.md
```

---

## 二·五、WebUI 管理页

启动后浏览器打开 `http://127.0.0.1:8088/`（或 `/admin/ui`）即可：

| 标签页 | 功能 |
|---|---|
| **概览** | 平台/账号/模型/请求数/429 数统计卡片，每账号的运行状态表（429、超时、冷却剩余、最近错误），模型池与游标 |
| **账号** | 增删改账号：名称、平台下拉、api_key、模型列表（一行一个） |
| **平台** | 增删改 provider：名称、base_url |
| **规则** | rotation、failover_on、cooldown、超时、max_attempts、local_api_key、model_fallback、model_alias |
| **测试** | 选模型 + 提示词，一键发请求，看 HTTP 状态/耗时/命中的 provider+account/返回内容 |
| **日志** | 最近 200 条路由记录（模型、命中 provider/account、状态、耗时、尝试次数、结果），可自动刷新 |

改完点右上角"**保存配置**" → `POST /admin/config` 原子写盘 + 热加载，**不用重启**。

> 旧配置（顶层 `upstream`、无 `providers`）打开 WebUI 会自动迁移成 `providers: [{name:'default',...}]`，保存后即完成升级。

**新增管理端点：**
- `GET /admin/config` — 返回原始 config.json（原样，含注释顺序）
- `POST /admin/config` — 校验 → 原子写盘 → 热加载，返回 `{ok, providers, accounts, models}`
- `GET /admin/requests` — 最近 200 条路由日志（内存环形缓冲，重启清空）

**模型别名 model_alias**：`{"gpt-4": "qwen-plus"}`，客户端请求 `gpt-4` 时网关路由到 `qwen-plus`（请求体里的 model 也会被改写成真实模型）。别名也会出现在 `/v1/models`（`owned_by: gateway-alias`）。

---

## 三、快速开始

### 1. 准备 Node ≥ 20
```bash
node -v    # 应 >= v20
```

### 2. 在日日新控制台建多个账号的 API Key
到 https://platform.sensenova.cn/console/keys 给**每个账号**各创建一个 Key（`sk-` 开头）。  
把要调用的模型在每个账号的"已开通模型"里都勾上（不同账号开通的模型可以重叠，也可以互补——这样网关上挂的模型就是它们的并集）。

### 3. 改 `config.json`
把 `accounts[*].api_key` 里的 `sk-REPLACE_WITH_KEY_1/2/3` 换成真实 key。  
`accounts[*].models` 改成该 key 实际能调用的模型 ID（建议跟控制台里勾选的一致）。

### 4. 启动
```bash
./start.sh
# 或
npm start
```
看到：
```
[2026-... ] SenseNova 本地网关已启动  http://127.0.0.1:8080
  accounts (3): acc-1, acc-2, acc-3
  models mounted (4): deepseek-v4-flash, glm-5.2, sensenova-6.8-flash-lite, sensenova-u1.5-lite
  rotation=on_failure  failover_on=[rate_limit,timeout,server_error]  cooldown_ms=30000  timeout_ms=120000
  客户端配置:  base_url = http://127.0.0.1:8080/v1   api_key = 任意值（本地开放）
```

### 5. 客户端指向网关（任选一个）
所有支持 OpenAI 协议的工具都能用：

| 工具 | 怎么配 |
|---|---|
| **OpenAI Python/Node SDK** | `OpenAI(base_url="http://127.0.0.1:8080/v1", api_key="anything")` |
| **Claude Code** | `ANTHROPIC_BASE_URL=http://127.0.0.1:8080  ANTHROPIC_AUTH_TOKEN=anything` |
| **Cursor / Cline / Continue** | Provider 选 OpenAI Compatible，URL 填 `http://127.0.0.1:8080/v1` |
| **curl** | `curl http://127.0.0.1:8080/v1/chat/completions -H 'Authorization: Bearer anything' -H 'Content-Type: application/json' -d '{"model":"sensenova-6.8-flash-lite","messages":[{"role":"user","content":"hi"}]}'` |

模型名直接用上游的：`sensenova-6.8-flash-lite` / `deepseek-v4-flash` / `glm-5.2` / `sensenova-u1.5-lite` 等。

### 6. 看运行情况
- `GET http://127.0.0.1:8080/health` — 健康
- `GET http://127.0.0.1:8080/admin/status` — 每个账号的请求/429/超时/冷却/轮询游标
- `POST http://127.0.0.1:8080/admin/reload` — 改了 `config.json` 后热加载（不用重启）

---

## 四、调用规则（核心）

```
请求进入
  │
  ▼
取请求里的 model
  │
  ▼
[选账号] 从 model 池里挑一个可用账号（未冷却、未 dead）
  │   on_failure（默认）= 按 priority 升序、weight 降序 选最优，粘住直到它挂
  │   every_request      = 按 weight 加权随机，每次换号均摊压力
  ▼
调上游 ──成功──► 直接把响应（含流式）回写给客户端
  │
  └── 429  ─► 账号进冷却（默认 30s），立即换下一个账号
  └── 超时  ─► 账号进冷却，立即换下一个账号
  └── 5xx   ─► 账号进冷却，立即换下一个账号
  └── 400/401/403/404 ─► 不切，原样回写（这是你/模型名/参数的问题，切了也没用）
  │
  ▼
当前 model 池所有账号都失败？
  │
  ├── 否  ─► 已经成功返回了
  │
  └── 是  ─► 走 model_fallback 配置的下一个 model，从它的池里再轮询 + 故障切换
            │
            └── 所有回退 model 的所有账号也失败 ─► 返回 502 + 明确错误
```

**关键点：**
- **切换是全自动的**：触发 429/超时/5xx 后网关**自动**切到下一个账号（可跨平台），无需任何手动干预。
- **默认行为是粘性 + 排名**：`on_failure` 模式下按 `priority`（小=优先）选最优账号并粘住，挂了自动降级到下一个 priority；同 priority 时按 `weight`（大=优先）。
- **想按比例分流**：改 `rotation: "every_request"`，按 `weight` 加权随机分布（如 3:1 ≈ 75%/25%）。
- **冷却**避免对一个刚 429 的账号立刻又打过去。
- **模型回退**处理"所有账号都限流"的极端情况——比如 `deepseek-v4-flash` 全挂，自动降级到 `sensenova-6.8-flash-lite`。

---

## 五、配置项详解（`config.json`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `port` | `8080` | 网关监听端口 |
| `host` | `127.0.0.1` | 默认只绑本地，安全；想给局域网用改成 `0.0.0.0` |
| `providers[]` | — | 多平台列表，每项 `{name, base_url, models}`；旧配置若有顶层 `upstream` 则自动建一个名为 `default` 的 provider（向后兼容） |
| `providers[].models` | `[]` | **平台级模型列表**：元素是 `"模型ID"` 或 `{name, priority, weight}`；该平台下的账号不写 models 时自动继承这里。模型级 priority/weight 在选号时**覆盖账号默认值**（同一模型挂多平台时用它控制先走哪个平台 / 按比例分流） |
| `default_model` | `""` | 客户端请求的模型不存在（或缺 model 字段）时自动路由到该模型，而不是返回 400 |
| `rotation` | `on_failure` | `on_failure` 默认粘性（一个账号用到它 429/超时/5xx 才切）；`every_request` 每次请求换号 |
| `failover_on` | `["rate_limit","timeout","server_error"]` | 哪些情况触发立即切换。`429`=限流，`timeout`=超时，`server_error`=5xx |
| `cooldown_ms` | `30000` | 失败账号冷却时长（期间不再选它，除非池子全冷） |
| `request_timeout_ms` | `120000` | 单次上游请求超时（流式也按这个） |
| `max_attempts` | `10` | 单次请求最多尝试几次（账号×回退 model 的笛卡尔积上限） |
| `model_fallback` | `{}` | 模型回退链，跨平台生效：`{"deepseek-v4-flash": ["Qwen/Qwen3-32B-Chat"]}` 即首选 SNS 的 deepseek 全挂时降级到 ModelScope 的 Qwen |
| `persist_stats` | `false` | 开关：启用后每 15s 把统计（请求数/429/超时/日志）落盘到 `config.json.stats.json`，**重启不丢计数**；关闭则纯内存，重启清零 |
| `health_check` | `false` | 开关：后台定时探测各账号存活。`false` 关闭；或 `{enabled:true, interval_ms:60000, path:"/v1/models", timeout_ms:10000}`。探测失败（网络/超时/非 2xx）的账号标 `dead` 并**自动跳过不再选中**，下次探测成功恢复 |
| `request_log_file` | `""` | 请求日志落盘：留空关闭；填文件名（如 `requests.log`）则每条路由结果以 JSONL 追加写入（相对 config 目录解析），含 client_model/provider/account/status/latency/attempts/outcome |
| `local_api_key` | `""` | 留空则本地开放（客户端 api_key 写啥都行）。想锁住就填一个值，客户端必须带 `Authorization: Bearer <这个值>` |
| `accounts[].name` | — | 账号名，只用于日志/状态展示 |
| `accounts[].provider` | `default` | 该账号归属的 provider 名；不写则用 `default`（旧配置兼容） |
| `accounts[].api_key` | — | 该 provider 控制台生成的 key |
| `accounts[].models` | — | 该 key 能调用的模型 ID 列表；**可省略**（省略时继承所属平台 `providers[].models`，平台下模型一致时写一次即可） |
| `accounts[].priority` | `100` | **排名**（数字越小越优先）。`on_failure` 粘性模式下：优先用 priority 最小的可用账号，它挂了才自动降级到下一个 priority |
| `accounts[].weight` | `1` | **权重**（数字越大分到越多流量）。`every_request` 模式下按 weight 加权随机分布，如 3:1 ≈ 75%/25% |

---

## 六、多平台 + 多账号怎么挂上

### 思路
网关按 `model 名字` 聚合账号池，**不分平台**——同一个模型名（比如 `Qwen/Qwen3-32B-Chat`）在你 ModelScope 两个账号里都登记的话，请求这个模型时就会在这两个账号之间粘性/轮询；不同平台的同名/异名模型各自独立，按需配置 `model_fallback` 跨平台降级。

### 步骤
1. 在每个平台的控制台建账号、拿 key：
   - 日日新：https://platform.sensenova.cn/console/keys
   - 魔搭 ModelScope：https://modelscope.cn/my/access/token（需绑定阿里云 + 实名，每天约 2000 次免费 API-Inference 调用）
   - 阿里百炼 DashScope：https://dashscope.console.aliyun.com/apiKey
   - DeepSeek：https://platform.deepseek.com/api_keys
   - 月之暗面 Moonshot：https://platform.moonshot.cn/console/api-keys
   - 硅基流动 SiliconFlow：https://cloud.siliconflow.cn/account/ak
2. `providers[]` 填你要用的平台（`base_url` 见 `config.example.json`）。
3. `accounts[]` 每个账号填 `name` / `provider` / `api_key` / `models`，`models` 写该 key 在该平台控制台已勾选开通的模型 ID（模型 ID 字符串以平台约定的为准——魔搭是 `组织/模型名` 形式如 `Qwen/Qwen3-32B-Chat`，百炼是 `qwen-plus` 这种）。

### ⚠️ 改平台名字（provider）要注意
在 WebUI「平台」页**直接改 name 输入框**即可——代码会自动把引用该旧名的账号的 `provider` 字段一并改成新名，然后保存。  
**不要**只改 provider 的 name 而不动账号：那样账号会引用一个不存在的 provider，保存时服务器会拒绝（`引用了未定义的 provider "..."`）。配置文件同理：改 `providers[].name` 时必须同步改所有 `accounts[].provider`。

### 额度叠加举例
- ModelScope 3 个账号 × 每天 2000 次 ≈ 6000 次/天
- 日日新 3 个账号（按官方每 5h 1500 次折算 24h ≈ 7200/账号）× 3 ≈ 21600 次/天
- DashScope / DeepSeek / SiliconFlow 各自按账号叠加

模型名相同则轮询切号，模型名不同则在 `/v1/models` 各自独立列出，按需 `model_fallback` 跨平台降级。

---

## 七、常见问题

**Q: 怎么确认真的在切换？**  
启动后观察终端日志，每次请求会打印 `attempt #N model=... account=...` 以及结果（`-> 429 ... SWITCH` / `-> 200 OK`）。同时响应头里有个 `x-gateway-account: acc-2` 告诉你这次是哪个账号回的。

**Q: 怎么给不同的工具指定不同模型？**  
在工具里把 `model` 字段设成想要的 ID 即可，网关按 model 选对应的账号池。

**Q: 日日新每天/每 5h 限流怎么办？**  
加更多账号到 `config.json` 即可，额度按账号数线性叠加。再加 `model_fallback` 兜底（首选模型被全限流时降级）。

**Q: 改了 config.json 要重启吗？**  
不用。`POST /admin/reload` 即可热加载，账号池和游标会重新构建并自动裁剪。

**Q: 想锁住网关不让别人用？**  
设 `local_api_key: "你自己定一个token"`，客户端必须 `Authorization: Bearer 你自己定的token`。

**Q: Claude Code / Anthropic 客户端怎么用？**  
文档说 Anthropic 兼容端点 URL 填 `https://token.sensenova.cn`（**不要带 /v1**），SDK 自动拼 `/v1/messages`。  
所以本网关的对外地址也按同样规则：把 `ANTHROPIC_BASE_URL` 设为 `http://127.0.0.1:8080`（不要带 /v1），`ANTHROPIC_AUTH_TOKEN` 任意（或你设的 local_api_key），它会请求 `POST /v1/messages`，网关照常代理。
