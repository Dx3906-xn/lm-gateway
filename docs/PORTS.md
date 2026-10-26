# lm-gateway 端口表与调用速查

> 对外**只认 8790**。8188 / 9880 / 9820 是网关代管的后端端口，调用方不要直连。
> 契约依据：[DESIGN.md](DESIGN.md) §3（端口）、§6（API）；字段与响应以
> [API.md](API.md)（按当前实现写成）为准。
> 本机环境：Windows + PowerShell 5.1。

最后更新：2026-10-26

---

## 1. 端口总览

| 端口 | 服务 | 归属 | 可否使用 |
|---|---|---|---|
| **8790** | **网关 HTTP（API + WebUI）** | 本网关 | ✅ **唯一对外入口** |
| 8188 | ComfyUI（生图 Qwen-Image 2.1 / 语音 Breeze TTS 2） | 网关代管 | ⛔ 内部，已被占用 |
| 9880 | GPT-SoVITS（语音合成） | 网关代管 | ⛔ 内部，已被占用 |
| 9820 | embed-server（记忆检索） | 网关代管 | ⛔ 内部，已被占用 |
| 1234 | LM Studio | 其他程序 | ⛔ 已占用，不得使用 |
| 3001 | QQ | 其他程序 | ⛔ 已占用，不得使用 |
| 3080 | DSH GUI | 本机工具 | ⛔ 已占用，不得使用 |
| 3081 | DSH node | 本机工具 | ⛔ 已占用，不得使用 |

**已占用、不得分配给他人的端口**：
`1234`、`3001`、`3080`、`3081`、`8188`、`9820`、`9880`

后端端口由网关按需拉起 / 停止，调用方只跟 8790 打交道。

---

## 2. 调用约定

- Base URL：`http://127.0.0.1:8790`
- 请求与响应都是 JSON；请求头建议写全：
  `Content-Type: application/json; charset=utf-8`
- WebUI 与 API 同端口：浏览器打开 `http://127.0.0.1:8790/` 即是控制台页面。
- 没有鉴权（只监听 `127.0.0.1`，不对外网暴露）。

### 2.1 中文 body 必须按 UTF-8 字节发送 ⚠️

本机是 PowerShell 5.1。**直接传字符串 body 时，中文会按系统 ANSI 编码发出去**，
服务端收到的 JSON 结构完好、HTTP 200，但文字已经是乱码——不报错，只有结果不对。

两种安全写法，任选其一（下面每一段都实测过：body 到服务端是逐字节正确的 UTF-8）。

**A. PowerShell 原生（推荐，中文直接内联）**

```powershell
$body  = '{"prompt":"生成一张漫画风格的慵懒少女"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri http://127.0.0.1:8790/api/image -Method POST `
  -Body $bytes -ContentType 'application/json; charset=utf-8'
```

> A 方案可以直接粘贴进**交互式** PS 会话运行。若要存成 `.ps1` 文件再执行，必须保存为
> **UTF-8 带 BOM**——PS 5.1 会按 ANSI 解析无 BOM 的 UTF-8 脚本，里面的中文字面量会直接报解析错误。

**B. curl.exe + 文件（body 先按 UTF-8 无 BOM 落盘，再 `--data-binary`）**

```powershell
$json = '{"prompt":"生成一张漫画风格的慵懒少女"}'
[System.IO.File]::WriteAllText("$env:TEMP\img.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8790/api/image `
  -H "Content-Type: application/json; charset=utf-8" `
  --data-binary "@$env:TEMP\img.json"
```

### 2.2 本机 curl / PowerShell 的四个坑（均在本机实测）

1. **`curl` 不是 curl。** PowerShell 5.1 里 `curl` 是 `Invoke-WebRequest` 的**别名**，
   不认 `-X` / `--data-binary`。本文档一律写 **`curl.exe`**（`C:\WINDOWS\system32\curl.exe`，8.19.0）。

2. **内联 JSON 的双引号会被 PS 5.1 吃掉。** 实测：把 body 写成 `'{"enabled":false}'` 内联给
   `curl.exe`，服务端收到的是 `{enabled:false}`——引号丢失，curl 退出码还是 0，只有服务端解析失败。
   - 命令行里**没有空格**的短 body：把 `"` 写成 `\"` 即可，`'{\"enabled\":false}'` 实测完好。
   - body 里**含空格**（例如带空格的英文 prompt）：PS 会把参数在第一个空格处拆断，
     实测只发出 `{"prompt":"a` 并让 curl 报 `(3) URL malformed`。**这种情况必须走文件或 A 方案。**

3. **中文字面量交给 `curl.exe` 会按 ANSI 编码发出**，服务端拿到乱码。中文一律走 §2.1 的
   A 方案（`UTF8.GetBytes`）或 B 方案（文件 + `--data-binary`）。

4. **不要用管道把中文喂给 `curl.exe`**：PS 5.1 的 `$OutputEncoding` 默认是 ASCII，同样损坏。

> 一句话规则：**curl 的 POST body 只要含空格或中文，就写成文件再用 `--data-binary "@文件"`**；
> 只有无空格的短 ASCII body 才用 `\"` 转义内联。下面 §4 的示例都按这条规则写。

---

## 3. 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/status` | 全部资源状态 + 显存 + 总控状态 + 队列 |
| `POST` | `/api/master` | 总控开关 `{enabled}` |
| `POST` | `/api/resources/:id` | 改开关 / 保持时长（也可改 `vramMiB` / `priority` / `label`） |
| `POST` | `/api/resources/:id/start` | 手动拉起（仍受开关与总控约束） |
| `POST` | `/api/resources/:id/stop` | 手动停止 |
| `GET` | `/api/config` | 当前完整配置 |
| `GET` | `/api/gpu` | 实时显存 |
| `GET` | `/api/logs` | 最近日志 |
| `POST` | `/api/image` | 生图 |
| `POST` | `/api/speak` | 语音合成 |
| `POST` | `/api/search` | 记忆检索 |
| `GET` | `/api/workflows` | 列出可用工作流 |
| `POST` | `/api/workflows/reload` | 重载工作流目录 |

资源 id：`image`、`breeze`、`tts`、`memory`。
请求/响应字段、状态码的完整说明见 [API.md](API.md)。

---

## 4. 逐接口 curl 示例

GET 直接发；POST 的 body 按 §2.2 的规则处理。

### 4.1 查状态

```powershell
curl.exe -s http://127.0.0.1:8790/api/status
```

### 4.2 查显存 / 配置 / 日志

```powershell
curl.exe -s http://127.0.0.1:8790/api/gpu
curl.exe -s http://127.0.0.1:8790/api/config
curl.exe -s http://127.0.0.1:8790/api/logs
```

### 4.3 总控开关

body 无空格，用 `\"` 转义双引号内联即可：

```powershell
curl.exe -s -X POST http://127.0.0.1:8790/api/master -H "Content-Type: application/json" --data-binary '{\"enabled\":false}'
```

### 4.4 改某项的开关 / 保持时长

```powershell
curl.exe -s -X POST http://127.0.0.1:8790/api/resources/image -H "Content-Type: application/json" --data-binary '{\"enabled\":true,\"keepAliveSec\":300}'
```

### 4.5 手动拉起 / 停止

无 body：

```powershell
curl.exe -s -X POST http://127.0.0.1:8790/api/resources/image/start
curl.exe -s -X POST http://127.0.0.1:8790/api/resources/image/stop
```

### 4.6 工作流列表与重载

```powershell
curl.exe -s http://127.0.0.1:8790/api/workflows
curl.exe -s -X POST http://127.0.0.1:8790/api/workflows/reload
```

### 4.7 生图（body 里有空格，必须落盘）

```powershell
$json = '{"prompt":"a lazy girl in manga style","override":{"5":{"seed":12345}}}'
[System.IO.File]::WriteAllText("$env:TEMP\lm-image-ascii.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8790/api/image -H "Content-Type: application/json" --data-binary "@$env:TEMP\lm-image-ascii.json"
```

### 4.8 语音 / 检索

body 都含中文或空格，见 §5.2、§5.3 的完整示例。

---

## 5. 三个完整示例（可直接复制运行）

### 5.1 生图 · Qwen-Image 2.1

中文 prompt 直接可用——Qwen-Image 2.1 的文本编码器是 Qwen3-VL-8B，原生读中文。
首次调用会拉起 ComfyUI（冷启动 40–70 秒），实测出图约 **137 秒/张**、显存峰值约 **6800 MiB**。

**A 方案（PowerShell 原生，推荐）**

```powershell
$body = @{
  prompt     = '生成一张漫画风格的慵懒少女'
  resource   = 'image'                                    # 可选，默认 image
  workflow   = 'qwen21-image.json'                        # 可选，默认取资源配置
  override   = @{ '5' = @{ seed = 12345; steps = 25 } }   # 可选，按节点 id 覆盖
  timeoutSec = 900
} | ConvertTo-Json -Depth 6 -Compress

$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)      # 中文必须走字节
Invoke-RestMethod -Uri http://127.0.0.1:8790/api/image -Method POST `
  -Body $bytes -ContentType 'application/json; charset=utf-8'
```

**B 方案（curl.exe + 文件）**

```powershell
$json = '{"prompt":"生成一张漫画风格的慵懒少女","timeoutSec":900}'
[System.IO.File]::WriteAllText("$env:TEMP\lm-image.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8790/api/image `
  -H "Content-Type: application/json; charset=utf-8" `
  --data-binary "@$env:TEMP\lm-image.json"
```

返回形如：

```json
{
  "ok": true,
  "workflow": "qwen21-image.json",
  "promptId": "d1f0c2a4-...",
  "images": [ "qwen21_00001_.png" ],
  "elapsedSec": 137.5
}
```

产物在 ComfyUI 的输出目录（本机 `E:\B\output\`）。

> **换成 Anima Turbo**：`resource` 仍传 `image`，把 `workflow` 换成 `anima-image.json`
> （显存约 **4000 MiB**、耗时 **15–28 秒/张**）。但注意两点：
> 1. 顶层 `prompt` 对 Anima **不生效**——`inject.prompt` 指向节点 `"4"` 的 `prompt` 字段，
>    而 Anima 的文本字段叫 `text`。要用 `override` 显式写：
>    `override: { "4": { "text": "英文 tag 提示词" }, "5": { "text": "负向 tag" } }`
> 2. Anima 的文本编码器（`qwen_3_06b_base`）**没有中文字表**，中文提示词必须先翻成英文 tag，
>    否则出图内容会跑偏（实测：一个"漫画风慵懒少女"的请求变成了比基尼写真 + 日语气泡）。

### 5.2 语音 · GPT-SoVITS（或 Breeze TTS 2）

`/api/speak` 默认走 `tts`（GPT-SoVITS）。它**必须**给参考音频：服务端每次调用都从它克隆，
所以 `refAudioPath` 没有默认值，缺了直接报错。参考音频要 3–10 秒的干净人声。

```powershell
$json = '{"text":"老大 我今天不想动","refAudioPath":"E:\\B\\voices\\ref-1.wav","promptText":"我之前听泰国歌曲好倒掉然后跟人家接","prefix":"speech"}'
[System.IO.File]::WriteAllText("$env:TEMP\lm-speak.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8790/api/speak `
  -H "Content-Type: application/json; charset=utf-8" `
  --data-binary "@$env:TEMP\lm-speak.json"
```

返回音频路径（网关已经落盘，不需要你自己收流）：

```json
{
  "ok": true,
  "backend": "gsv",
  "file": "E:\\B\\lm-gateway\\output\\audio\\speech-1761500000000.wav",
  "bytes": 123456,
  "elapsedSec": 8.3
}
```

PowerShell 原生等价写法：

```powershell
$body  = '{"text":"老大 我今天不想动","refAudioPath":"E:\\B\\voices\\ref-1.wav","promptText":"我之前听泰国歌曲好倒掉然后跟人家接"}'
$bytes = [System.Text.Encoding]::UTF8.GetBytes($body)
Invoke-RestMethod -Uri http://127.0.0.1:8790/api/speak -Method POST `
  -Body $bytes -ContentType 'application/json; charset=utf-8'
```

> `mode` 对 GPT-SoVITS 无效（会被忽略）。正确说法：音色由 `refAudioPath` + `promptText` 决定。

换成 Breeze TTS 2 时字段完全不同，且必须带 `mode`：

```powershell
$json = '{"resource":"breeze","text":"老大 我今天不想动","mode":"design","instruction":"慵懒温柔的女声，语速偏慢"}'
[System.IO.File]::WriteAllText("$env:TEMP\lm-breeze.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8790/api/speak -H "Content-Type: application/json; charset=utf-8" --data-binary "@$env:TEMP\lm-breeze.json"
```

`mode` 取 `design`（要 `instruction`）/ `clone`（要 `reference` + `referenceText`）/
`direction`（要 `reference` + `referenceText` + `instruction`）。
Breeze 与生图共用 8188 且互斥，请求会排队等显存。

### 5.3 记忆检索 · Qwen3-Embedding-0.6B

检索有两种模式：只要向量（`texts`），或给候选排序（`query` + `candidates`）。
注意 **`query` 单独给是不合法的**，会报 `search requires "candidates" when "query" is given`。

```powershell
$json = '{"query":"上次说的模型","candidates":["她说今天不想动","我们聊过 Qwen-Image 2.1","明天的天气"],"topK":2}'
[System.IO.File]::WriteAllText("$env:TEMP\lm-search.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8790/api/search `
  -H "Content-Type: application/json; charset=utf-8" `
  --data-binary "@$env:TEMP\lm-search.json"
```

返回按相似度降序：

```json
{
  "ok": true,
  "ranked": [
    { "index": 1, "score": 0.71, "text": "我们聊过 Qwen-Image 2.1" },
    { "index": 0, "score": 0.55, "text": "她说今天不想动" }
  ],
  "elapsedSec": 0.5
}
```

只要向量时：

```powershell
$json = '{"texts":["上次说的模型","她说今天不想动"]}'
[System.IO.File]::WriteAllText("$env:TEMP\lm-embed.json", $json, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST http://127.0.0.1:8790/api/search -H "Content-Type: application/json; charset=utf-8" --data-binary "@$env:TEMP\lm-embed.json"
```

> `query` / `texts` 是中文时必须走字节：embed-server 的向量质量对输入文本编码很敏感，
> 乱码不会报错，但向量全是垃圾。

---

## 6. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `409` + `reason: "resource"` / `"master"` | 该项 `enabled=false`，或总控关了。**不会拉起任何进程**。 |
| `503` + `reason: "no-room"` | 显存不够，且可让位的资源都让过了。看响应里的 `needMiB` / `haveMiB`。 |
| 请求长时间不返回 | 冷启动：ComfyUI 40–70 秒、GPT-SoVITS 约 70 秒；生图本身约 137 秒。用 `timeoutSec` 放宽。 |
| 生图慢到几分钟 | ComfyUI 没开 DynamicVRAM。生图要**开**（137s vs 638s），Breeze 要**关**。两者共用 8188，互斥。 |
| ComfyUI 进程崩溃 | 不要用 `cuda_graphs` 模式，一律 `eager`（Breeze 的 `decode_mode` 已固定为 `eager`）。 |
| 显存不够 | 可用显存约 6900 MiB；`6800 + 1200 > 6900`，任意两个大模型不能共存，网关会让位。 |
| `/api/speak` 报 `requires "refAudioPath"` | GPT-SoVITS 每次调用都从参考音频克隆，必须给 `refAudioPath`（3–10 秒 wav）。 |
| `/api/search` 报 `requires "candidates"` | `query` 模式必须同时给 `candidates`；只想算向量就传 `texts`。 |
| 生图用了 Anima 但提示词没生效 | `inject.prompt` 是按 Qwen 配的（字段 `prompt`），Anima 的字段叫 `text`，要用 `override`。 |
| 中文结果乱码 | body 没按 UTF-8 字节发。见 §2.1。 |
| 服务端看到 `{enabled:false}`（引号没了） | 内联 JSON 的双引号被 PS 5.1 吃掉。见 §2.2 坑 2。 |
| `curl` 报 `-X` 无法识别 | 用了别名 `curl` 而不是 `curl.exe`。见 §2.2 坑 1。 |
| `.ps1` 报语法错、中文乱 | 脚本存成了无 BOM 的 UTF-8，PS 5.1 按 ANSI 解析。见 §2.1。 |

**就绪判定的语义**（排查"为什么还没起来"时有用）：网关认为"有 HTTP 响应就算就绪"，
**不要求 200**——GPT-SoVITS 的 `/tts` 不带参数会返回错误状态码，但那证明进程已经活了。
反过来，停止要等到该 URL **不再应答**才算完成。

后端细节：ComfyUI 端口 8188，提交用 `POST /prompt`、等结果用 `GET /history/{prompt_id}`，
就绪探测 `GET /system_stats`；embed-server 有 `/health`、`/embed`、`/similarity`、`/shutdown`。
这些都由网关内部处理，**对外不要直连**。