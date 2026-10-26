# lm-gateway HTTP API

> 契约依据：[DESIGN.md](DESIGN.md) §4（资源 schema）、§5（开关语义）、§6（HTTP API）、§7（调度）。
> 端口与可复制示例见 [PORTS.md](PORTS.md)。
> 本文件按**当前 src/ 实现**写成，示例字段可直接照抄。

最后更新：2026-10-26

---

## 1. 概述

| 项 | 值 |
|---|---|
| Base URL | `http://127.0.0.1:8790` |
| 监听 | `127.0.0.1:8790`（仅本机，无鉴权） |
| 数据格式 | JSON（请求与响应，响应为 2 空格缩进） |
| 字符集 | UTF-8 |
| WebUI | 同端口，浏览器直接打开 `http://127.0.0.1:8790/` |

网关统一管理四类资源，调用方不直连后端端口：

| 资源 id | 名称 | 后端 / 端口 | 显存（实测峰值） | 优先级 | 默认保持 |
|---|---|---|---|---|---|
| `tts` | 语音 · GPT-SoVITS | gsv / 9880 | 5000 MiB | 10 | 300 s |
| `memory` | 记忆检索 · Qwen3-Embedding-0.6B | embed / 9820 | 1200 MiB | 20 | 120 s |
| `breeze` | 语音 · Breeze TTS 2 | comfy / 8188 | 6400 MiB | 30 | 180 s |
| `image` | 生图 · Qwen-Image 2.1 | comfy / 8188 | 6800 MiB | 40 | 180 s |

`priority` 数字越小越优先；`keepAliveSec` 为 `0` 表示用完立即停、`-1` 表示常驻。
`image` 与 `breeze` 共用 8188 且互斥（同一个 `exclusiveGroup: "comfy"`），
区别在启动参数：生图必须开 DynamicVRAM，Breeze 必须关。

---

## 2. 通用约定

### 2.1 请求头

```
Content-Type: application/json; charset=utf-8
```

### 2.2 中文 body 必须按 UTF-8 字节发送 ⚠️

本机是 PowerShell 5.1：**把中文字符串直接当 body 传会按 ANSI 编码发出**，服务端拿到乱码，
内容正确性与向量质量都会静默崩坏。务必先编码成字节，或把 body 写进 UTF-8 无 BOM 文件后
用 `curl.exe --data-binary @file`。完整写法见 [PORTS.md](PORTS.md) §2.1 与 §2.2。

同一个根因还有一个坑：**用 `curl.exe` 内联 JSON 时，PS 5.1 会把 body 里的双引号吃掉**
（实测 `'{"enabled":false}'` 发出去变成 `{enabled:false}`，curl 退出码仍是 0），含空格的 body
还会被直接拆断。因此本文的命令行示例一律走"UTF-8 字节"或"文件 + `--data-binary`"，不内联 JSON。

### 2.3 错误响应

统一形状：`{ "ok": false, "error": "<人类可读描述>", "reason": "<机器可判定代码>", ... }`。

| 状态码 | 场景 | 响应要点 |
|---|---|---|
| `409` | 开关关闭：该项 `enabled=false`，或总控 `master.enabled=false` | `reason` 为 `"resource"` 或 `"master"`；带 `resource` 字段；**不启动任何进程** |
| `503` | 显存不够，且可让位的资源腾不出空间 | `reason: "no-room"`，带 `needMiB` / `haveMiB` |
| `500` | 其它一切：body 不是合法 JSON、缺必填字段、未知资源 id、未知工作流、后端启动失败、ComfyUI 报错、超时 | 只有 `error` |
| `404` | 路径没有对应路由 | 带 `available`（可用路由列表） |
| `405` | 控制类端点用了非 POST 方法 | `error: "use POST for control actions"` |

示例：

```json
{ "ok": false, "error": "resource \"image\" is switched off", "reason": "resource", "resource": "image" }
```

```json
{ "ok": false, "error": "not enough VRAM for \"image\": needs 6800 MiB, 1200 MiB usable", "reason": "no-room", "resource": "image", "needMiB": 6800, "haveMiB": 1200 }
```

> 判断"是不是被开关拒绝"请认 `409` + `reason`，不要靠匹配 `error` 文案。

---

## 3. 状态与控制

### 3.1 `GET /api/status`

全部资源状态 + 显存 + 总控 + 队列。WebUI 每 2 秒轮询它。`resources` 按 `priority` 升序排列。

```json
{
  "master": true,
  "gateway": { "port": 8790, "uptimeSec": 42 },
  "gpu": {
    "totalMiB": 8188, "usedMiB": 1300, "freeMiB": 6888, "ok": true,
    "headroomMiB": 300, "usableMiB": 6588
  },
  "resources": [
    {
      "id": "tts",
      "label": "语音 · GPT-SoVITS",
      "enabled": true,
      "running": false,
      "state": "idle",
      "port": 9880,
      "backend": "gsv",
      "exclusiveGroup": "gsv",
      "vramMiB": 5000,
      "priority": 10,
      "keepAliveSec": 300,
      "keepAliveRemainingSec": null,
      "startedByUs": false,
      "startedAt": null,
      "lastUsedAt": null,
      "lastError": null,
      "yielded": false,
      "inflight": 0
    }
  ],
  "queue": [ { "id": "q-1", "resource": "tts", "priority": 10, "waitingMs": 1200 } ]
}
```

- `state`：`idle` | `starting` | `ready` | `busy` | `stopping` | `disabled`
  （`enabled=false` 时恒为 `disabled`）。
- `running`：`starting` / `ready` / `busy` 三者之一即为 true。
- `keepAliveRemainingSec`：保持窗口剩余秒数；没有定时器时为 `null`。
- `yielded`：为腾显存被网关停掉过，**不会自动重启**，下次请求才拉起。
- `inflight`：正在执行的请求数。
- `groupActive` / `blockedByGroup`：同一 `exclusiveGroup` 里当前由谁在服务。
  两者都为 `null` 时表示端口活着但**不是网关起的**，因此无法判断加载的是哪套配置
  （`image` 与 `breeze` 共用 8188 但启动参数相反）。
- `encodeVersion` / `info`：**仅 `backend=embed` 且该资源在运行时出现**。`info` 是
  `/health` 的原始返回，`info.encodeVersion` 同时提升为顶层 `encodeVersion`。
  调用方的向量缓存**应当以它为键**：没有这个字段时只能用一个常量，于是换掉 embedding
  模型之后仍会用旧模型算出的向量回答，而且不会报任何错。
- `gpu.ok=false` 时三个数字为 0 并带 `error`（`nvidia-smi` 不可用），此时网关按配置里的
  `vramMiB` 估算准入，而不是拒绝工作。
- `usableMiB = freeMiB − headroomMiB`（下限 0）。

### 3.2 `POST /api/master`

```json
{ "enabled": false }
```

关闭时：所有资源一律拒绝拉起，并**立即停止全部**已运行资源。

```json
{ "ok": true, "master": false, "stopped": ["image", "tts"], "failed": [] }
```

`enabled` 不是布尔值时报 500。

### 3.3 `POST /api/resources/:id`

改独立开关、保持时长（也可改 `vramMiB` / `priority` / `label`），立即持久化到
`config/resources.json`。

```json
{ "enabled": true, "keepAliveSec": 300 }
```

```json
{ "ok": true, "resource": { "id": "image", "enabled": true, "keepAliveSec": 300, "...": "..." }, "stopped": null }
```

- `enabled` 由 `true` → `false`：**立即停止**该资源进程，并取消其 keepAlive 定时器；
  响应里的 `stopped` 是停止结果（未停止时为 `null`）。
- `enabled` 由 `false` → `true`：允许后续调用拉起，但**不**主动拉起（按需）。
- `keepAliveSec`：`0` = 用完立即停，`-1` = 常驻，`>0` = 保持秒数；不是 `>= -1` 的整数时报 500。

### 3.4 `POST /api/resources/:id/start`

手动拉起。仍受该项 `enabled` 与总控约束——被开关挡住时**不抛状态码**，而是返回
`ok:false` 与原因：

```json
{ "ok": false, "error": "resource \"image\" is switched off", "resource": { "id": "image", "state": "disabled", "...": "..." } }
```

### 3.5 `POST /api/resources/:id/stop`

手动停止，确认端口不再应答后才返回（释放显存）。

### 3.6 `GET /api/config`

返回当前 `config/resources.json` 的完整内容（含启动/停止命令，未脱敏——只在
`127.0.0.1` 上提供）。

### 3.7 `GET /api/gpu`

实时显存（跳过 700 ms 缓存）：

```json
{ "totalMiB": 8188, "usedMiB": 1300, "freeMiB": 6888, "ok": true }
```

注意这里**没有** `usableMiB` / `headroomMiB`——那两个字段只在 `/api/status` 的 `gpu` 里。

### 3.8 `GET /api/logs`

最近的网关日志：

```json
{ "entries": [ { "level": "info", "at": 1761500000000, "message": "loaded 2 workflow(s)" } ] }
```

---

## 4. 业务接口

### 4.1 `POST /api/image` 生图

```json
{
  "prompt": "生成一张漫画风格的慵懒少女",
  "workflow": "qwen21-image.json",
  "resource": "image",
  "override": { "5": { "seed": 123 } },
  "timeoutSec": 900
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | | 正向提示词，注入到**资源配置 `inject.prompt` 指定的节点字段**（`image` → 节点 `"4"` 的 `prompt`） |
| `workflow` | | 工作流文件名，默认取资源配置（`image` → `qwen21-image.json`） |
| `resource` | | 资源 id，默认 `image`；该资源必须 `backend: "comfy"` 且有默认 `workflow` |
| `override` | | 按**节点 id** 覆盖工作流 `inputs` 字段，见 §6.3 |
| `timeoutSec` | | 等待出图的上限，默认 900 |

成功返回：

```json
{
  "ok": true,
  "workflow": "qwen21-image.json",
  "promptId": "d1f0c2a4-...",
  "images": [ "qwen21_00001_.png" ],
  "elapsedSec": 137.5
}
```

产物落在 ComfyUI 的输出目录（本机为 `E:\B\output\`）。实测：Qwen-Image 2.1 约
**137 秒/张**、显存峰值约 **6800 MiB**（ComfyUI 需开 DynamicVRAM；关掉会退化到 638 秒）。
Anima Turbo 约 **15–28 秒/张**、显存约 **4000 MiB**。

> **换成 Anima 时注意**：`inject.prompt` 是按 Qwen-Image 配的（节点 `"4"` 的 `prompt` 字段），
> 而 Anima 的文本字段叫 `text`（正向节点 `"4"`、负向节点 `"5"`）。所以
> `{"workflow":"anima-image.json","prompt":"..."}` 里的 prompt 会写进一个 Anima 不认识的字段，
> **不生效也不报错**，出图用的还是工作流文件里的默认 tag。走 Anima 请显式用 override：

```json
{
  "workflow": "anima-image.json",
  "override": {
    "4": { "text": "masterpiece, best quality, 1girl, solo, lazy, sleepy, cozy room, manga style" },
    "5": { "text": "worst quality, low quality, blurry, watermark, text, photo, realistic" }
  }
}
```

> 另外 Anima 的文本编码器 `qwen_3_06b_base` **没有 CJK 词表**，中文只能以 UTF-8 字节碎片进入编码器，
> 出图内容会跑偏（实测把一个"漫画风慵懒少女"的请求变成了比基尼写真 + 日语气泡）。
> 走 Anima 请给英文 tag；中文提示词请用 Qwen-Image 2.1。

### 4.2 `POST /api/speak` 语音合成

`resource` 默认 `tts`（GPT-SoVITS）。两条后端路径的字段完全不同。

**A. `resource: "tts"`（GPT-SoVITS，默认）**

```json
{
  "text": "老大 我今天不想动",
  "refAudioPath": "E:\\B\\voices\\ref-1.wav",
  "promptText": "我之前听泰国歌曲好倒掉然后跟人家接",
  "textLang": "zh",
  "prefix": "speech",
  "timeoutSec": 300
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `text` | ✅ | 要合成的文本 |
| `refAudioPath` | ✅ | 参考音频（3–10 秒 wav）。GPT-SoVITS 每次调用都从它克隆，**没有默认值**，缺了直接报 500 |
| `promptText` | | 参考音频的**原文**；不给也能跑，但克隆相似度会明显下降 |
| `textLang` / `promptLang` | | 默认 `zh` |
| `textSplitMethod` | | 默认 `cut5` |
| `speedFactor` | | 默认 `1.0` |
| `repetitionPenalty` | | 默认 `1.35` |
| `mediaType` | | 默认 `wav` |
| `prefix` | | 输出文件名前缀，默认 `speech` |
| `timeoutSec` | | 默认 300；首次调用要加载模型，很慢 |

返回（音频已落盘，给你的是路径）：

```json
{
  "ok": true,
  "backend": "gsv",
  "file": "E:\\B\\lm-gateway\\output\\audio\\speech-1761500000000.wav",
  "bytes": 123456,
  "elapsedSec": 8.3
}
```

> `mode` 字段对 GPT-SoVITS **无效**（会被忽略）——它的"模式"是 `refAudioPath` + `promptText` 决定的。
> 字段名同时接受 camelCase 与 snake_case（`ref_audio_path`、`prompt_text`、`text_lang` …）。

**B. `resource: "breeze"`（Breeze TTS 2，跑在 ComfyUI 上）**

```json
{ "resource": "breeze", "text": "老大 我今天不想动", "mode": "design", "instruction": "慵懒温柔的女声，语速偏慢" }
```

| `mode` | 额外必填 | 含义 |
|---|---|---|
| `design` | `instruction` | 用一段文字描述造出音色，不需要录音 |
| `clone` | `reference`（ComfyUI input 目录里的文件名）+ `referenceText`（该音频的原文） | 克隆参考音频 |
| `direction` | 同 `clone`，另加 `instruction` | 带语气/情绪指令的克隆 |

可选：`model`、`seed`、`temperature`、`topK`、`topP`、`repetitionPenalty`、`cfgScale`、`prefix`、
`format`；`mode` 非法或缺必填项都会报 500。返回：

```json
{
  "ok": true,
  "backend": "comfy",
  "mode": "design",
  "promptId": "3a91...",
  "audio": [ "breeze-design_00001_.flac" ],
  "elapsedSec": 46.2
}
```

> Breeze 与生图共用 8188 且互斥，`instruction` 描述就是音色本身，会直接影响结果。

### 4.3 `POST /api/search` 记忆检索

两种模式，二选一。

**A. 只要向量（embed）**

```json
{ "texts": ["上次说的模型", "她说今天不想动"] }
```

```json
{ "ok": true, "vectors": [[0.013, -0.24, "..."]], "dim": 1024, "elapsedSec": 0.4 }
```

**B. 排序（给定候选，按相似度从高到低）**

```json
{ "query": "上次说的模型", "candidates": ["她说今天不想动", "我们聊过 Qwen-Image 2.1", "明天的天气"], "topK": 2 }
```

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

- `query` 模式**必须同时给 `candidates`**，否则报 500：
  `search requires "candidates" when "query" is given`。
- `topK` 默认返回全部候选；`index` 是候选在请求数组里的下标。
- 只给 `texts` 或只给 `query`+`candidates`，别的组合一律 500。
- 后端是 1024 维的 Qwen3-Embedding-0.6B；`query` / `texts` 是中文时必须按 §2.2 发字节，
  否则不报错但向量全是垃圾。

---

## 5. 工作流管理

### 5.1 `GET /api/workflows`

```json
{ "workflows": [ "anima-image.json", "qwen21-image.json" ] }
```

### 5.2 `POST /api/workflows/reload`

重载工作流目录，返回新的列表。新增工作流的流程：把 ComfyUI API 格式 json 放进
`config/workflows/`，然后调一次 reload，**不需要改代码、不需要重启网关**。

### 5.3 工作流文件格式

ComfyUI **API 格式**：顶层键是字符串形式的节点 id，每个节点含 `class_type` 与 `inputs`；
`inputs` 中对其他节点的引用写成 `["节点id", 输出序号]`。

```json
{
  "1": { "class_type": "UNETLoader", "inputs": { "unet_name": "xxx.safetensors", "weight_dtype": "default" } },
  "5": { "class_type": "KSampler",  "inputs": { "model": ["1", 0], "seed": 0, "steps": 25 } }
}
```

网关提交给 ComfyUI 的方式：`POST http://127.0.0.1:8188/prompt`，body 为
`{"prompt": <graph>, "client_id": "lm-gateway"}`；随后每秒轮询
`GET http://127.0.0.1:8188/history/{prompt_id}`，从 `outputs[*].images[*].filename` /
`outputs[*].audio[*]` 取产物。若 `/prompt` 拒绝该图，网关会把 ComfyUI 的
`error` / `node_errors` 原文带进错误的 `message`。

---

## 6. 工作流详情

两个工作流都是从本机**已实测出图**的文件转换而来，节点字段与
`E:\B\scripts\models.py` 的 `qwen21_graph()` / `anima_graph()` 逐项核对一致——没有新增或猜测节点。

### 6.1 `qwen21-image.json`（Qwen-Image 2.1）

来源：`E:\Comfy-Desktop\qwen21-api.json`。

| 节点 id | class_type | 关键 inputs | 用途 |
|---|---|---|---|
| `1` | UNETLoader | `unet_name=qwen_image_2.1_int8_convrot.safetensors`, `weight_dtype=default` | 底模（官方 int8；GGUF 版在本机加载失败） |
| `2` | CLIPLoader | `clip_name=qwen3vl_8b_w4a8.safetensors`, `type=qwen_image` | 文本编码器 Qwen3-VL-8B（读中文） |
| `3` | VAELoader | `vae_name=qwen_image_2.1_vae_bf16.safetensors` | VAE |
| `4` | TextEncodeQwenImage21 | `prompt`, `negative_prompt`, `resolution=1024` | **提示词注入点**（`inject.prompt` 指向这里）；同时输出 positive / negative / latent 三路 |
| `5` | KSampler | `seed=0`, `steps=25`, `cfg=1.0`, `euler`, `simple`, `denoise=1.0` | **seed / 参数注入点** |
| `6` | VAEDecode | | 解码 |
| `7` | SaveImage | `filename_prefix=qwen21` | 输出文件名前缀 |

要点：

- 节点 `4` 的三个输出直接接进 KSampler：`positive=["4",0]`、`negative=["4",1]`、`latent_image=["4",2]`。
  latent 由该节点按 `resolution` 生成（Qwen-Image 2.1 的 64 通道 latent），不经过 `EmptyLatentImage`。
- `resolution` 是**单个正方形边长**（1024），不是宽高对；需要别的尺寸时 override 该字段。
- `cfg` 官方路径保持 `1.0`（官方模板说明：负向提示词在这条路径上不生效，只有给了 negative 才上调）。
- 尺寸最好取 32 的倍数；模型原生支持到 2048×2048。

### 6.2 `anima-image.json`（Anima Turbo v1.1）

来源：`E:\B\workflows\anima-api.json`。

| 节点 id | class_type | 关键 inputs | 用途 |
|---|---|---|---|
| `1` | UNETLoader | `unet_name=anima-turbo-v1.1.safetensors` | 底模 |
| `2` | CLIPLoader | `clip_name=qwen_3_06b_base.safetensors`, `type=stable_diffusion` | 文本编码器（**无中文字表**） |
| `3` | VAELoader | `vae_name=qwen_image_vae.safetensors` | VAE |
| `4` | CLIPTextEncode | `text=<正向 tag 串>` | **正向提示词字段** |
| `5` | CLIPTextEncode | `text=<负向 tag 串>` | **负向提示词字段** |
| `6` | EmptySD3LatentImage | `width=832`, `height=1216`, `batch_size=1` | 尺寸（宽高对） |
| `7` | KSampler | `seed=0`, `steps=12`, `cfg=2.5`, `euler`, `simple` | **seed / 参数注入点** |
| `8` | VAEDecode | | 解码 |
| `9` | SaveImage | `filename_prefix=dafiyu` | 输出文件名前缀（沿用原工作流，可用 override 改） |

### 6.3 `inject` 与 `override`：提示词到底写进哪里

**`inject`（配置侧）**——`config/resources.json` 里每个 comfy 生图资源必须声明
prompt 的落点，因为网关无法猜任意图里哪个节点是文本输入：

```json
"inject": { "prompt": { "node": "4", "field": "prompt" } }
```

调用 `/api/image` 时，网关把请求里的 `prompt` 写成 `graph["4"].inputs["prompt"]`。
没声明 `inject.prompt` 的资源收到 `prompt` 会直接报 500，而不是猜一个节点。

**`override`（调用侧）**——按节点 id 覆盖 `inputs` 字段，浅合并：

```json
{ "override": { "5": { "seed": 12345, "steps": 30 } } }
```

**合并顺序**：先注入 `prompt`，再合并 `override`；同一节点上两者会合并（不会互相顶掉），
`override` 优先。两个机制写的是同一份 `inputs`，所以"注入了 prompt 同时又要改该节点的另一个字段"
是安全的。`override` 指向不存在的节点 id 会报 500，不会静默忽略。

各工作流的可注入位置一览：

| 工作流 | `prompt` / 正向 | 负向 | seed / 采样参数 | 尺寸 |
|---|---|---|---|---|
| `qwen21-image.json` | `{"4":{"prompt":"..."}}` | `{"4":{"negative_prompt":"..."}}` | `{"5":{"seed":N,"steps":N,"cfg":X}}` | `{"4":{"resolution":1024}}` |
| `anima-image.json` | `{"4":{"text":"..."}}` | `{"5":{"text":"..."}}` | `{"7":{"seed":N,"steps":N,"cfg":X}}` | `{"6":{"width":832,"height":1216}}` |

> 第一列在 qwen21 上与 `inject.prompt` 完全一致（同一节点、同一字段）；
> 在 anima 上**不一致**（`prompt` 字段名 vs `text` 字段名），所以走 Anima 必须用 override，见 §4.1。

---

## 7. 开关与调度语义

### 7.1 开关（DESIGN §5）

| 动作 | 行为 |
|---|---|
| `enabled=false` 时收到调用 | **拒绝**，`409`，**不启动任何进程** |
| `enabled` 由 `true` → `false` | **立即停止**该资源进程；取消其 keepAlive 定时器 |
| `enabled=true` | 允许后续调用拉起；**不**主动拉起（按需） |
| `master.enabled=false` | 所有资源一律拒绝拉起；**立即停止全部**已运行资源 |
| 总控关闭时手动"拉起" | 拒绝并提示总控已关 |
| 资源正在被调用时切到关闭 | 等当前请求完成或超时后停止（不超过 30 秒） |

### 7.2 调度

- **串行化**：所有涉及进程生命周期的操作排在一条串行链上，同一时刻只有一个资源在启动，
  避免并发拉起互相打架。
- **优先级**：`tts(10) > memory(20) > breeze(30) > image(40)`，队列按此排序。
- **让位**：显存不足时，只停 `priority` **数字更大**（即更低优先级）且当前没有在飞请求的资源；
  被停的资源标记 `yielded`，不会自动重启。都停完了还不够 → `503 no-room`。
- **互斥组**：同 `exclusiveGroup` 的资源启动前先停组内其他成员。
- **keepAlive**：请求完成后按 `keepAliveSec` 设定时器；期间再来请求则取消并重设。
  `keepAliveSec` 每次从配置现读，WebUI 改完立即对下一次释放生效。

### 7.3 就绪判定 ⚠️

`ready.url` 的判定标准是**"TCP 连上并且收到一个 HTTP 响应"，不要求 200**。

原因：GPT-SoVITS 的 `/tts` 不带参数会返回错误状态码，但进程确实是活的；
若把非 200 当作"还没起来"，这个服务每次启动都会白白耗完 `timeoutSec`。
所以 4xx / 5xx 也算就绪。

停服务时反过来判定：轮询到该 URL **不再应答**才算停干净（默认最多等 30 秒），
因为"发出停止命令"不等于显存已经还回来。

---

## 8. 调用方注意事项

1. **只连 8790**。8188 / 9880 / 9820 是网关内部端口，直连会绕过显存账本，把两个大模型撞在一起
   （可用显存约 6900 MiB，`6800 + 1200 > 6900`，任意两个大模型不能共存）。
2. **中文 body 走 UTF-8 字节**，见 §2.2。
3. **冷启动要留时间**：ComfyUI 40–70 秒、GPT-SoVITS 约 70 秒；生图本身约 137 秒。
4. **生图的等待可以接受，对话的等待不可以**：优先级顺序如上；抢占（生图给语音让位）
   属于第二阶段能力，当前实现先允许排队等待。
5. **用完会自己停**：默认 keepAlive 到点释放显存；需延长就改 `keepAliveSec`（`-1` 为常驻）。
6. **不确定的错误先看 `reason`**：`resource` / `master` = 开关拒绝（409），`no-room` = 显存不足（503），
   其余都是 500，`error` 里带原始原因（包括 ComfyUI 的节点级报错）。