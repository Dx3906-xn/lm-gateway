# lm-gateway 设计契约

> 实现与评审的共同依据。接口、端口、字段名、开关语义的改动先改这里，再改代码。
> 本文档已按实测与实现校正过一轮（见文末「修订记录」）。

最后更新：2026-10-26

---

## 1. 目标与范围

把本机所有 GPU 模型服务收进一个网关，由它统一管理生命周期、显存与对外接口。

**在范围内**

- 独立 WebUI：总控开关、每项服务独立开关、拉起/停止按钮、保持时间可调
- 开关语义：关闭时**拒绝拉起**；切到关闭时**立即停止**
- 按需调用，用完自动释放；保持时长可调
- 配置外置，模型可更换、可新增
- 明确对外端口，便于调用
- ComfyUI 以 API 方式提交工作流

**不在范围内**

- 视频模型（暂缓；`video` 资源位已在 schema 预留）
- 改造 `dsh-canvas` 插件（本网关独立）

---

## 2. 目录结构

```
E:\B\lm-gateway\
├── package.json
├── README.md
├── config\
│   ├── resources.json           ← 模型/服务定义（更换扩展改这里）
│   └── workflows\               ← ComfyUI API 格式工作流
├── src\
│   ├── main.js                  ← 进程入口（信号处理；退出时释放显存）
│   ├── server.js                ← HTTP 服务 + 路由表
│   ├── cli.js                   ← status / smoke（验收自测）
│   ├── show-status.js           ← 紧凑状态输出（开发用）
│   ├── measure-image.js         ← 端到端生图 + 显存采样
│   ├── test-injection.js        ← 注入点测试（纯逻辑）
│   ├── test-start.js            ← 启动路径测试（真实冷启动）
│   ├── config.js                ← 配置加载/校验/原子保存
│   ├── registry.js              ← 运行时状态（与配置分离）
│   ├── scheduler.js             ← 显存账本 + 队列 + 互斥 + keepAlive
│   ├── lifecycle.js             ← 启停 + 就绪等待 + 端口释放确认
│   ├── gpu.js                   ← nvidia-smi 读取
│   ├── log.js
│   └── backends\
│       ├── comfy.js             ← 提交工作流 / 等结果 / 注入点解析
│       ├── breeze.js            ← 按模式生成 Breeze 图
│       ├── gsv.js               ← GPT-SoVITS /tts
│       └── embed.js             ← embed-server
├── output\
│   ├── audio\                   ← 语音产物
│   └── logs\                    ← 网关日志、命令输出
├── webui\
│   ├── index.html
│   ├── app.js
│   └── style.css
└── docs\
    ├── PORTS.md                 ← 端口表（对外调用必读）
    ├── API.md                   ← 接口文档
    └── DESIGN.md                ← 本文件
```

---

## 3. 端口分配

**外部只需要一个端口：8790。** 后端模型端口由网关**动态分配**，不写死在配置或脚本里。

| 用途 | 端口 | 说明 |
|---|---|---|
| **网关 HTTP（API + WebUI + 代理）** | **8790** | **唯一对外入口** |
| ComfyUI（image / anima / breeze 同组共用） | 网关分配 | 默认从 `backendPortBase`(8188) 起扫，被占则顺延 |
| GPT-SoVITS（tts） | 网关分配 | 单独一组 |
| embed-server（memory） | 网关分配 | 单独一组 |

**已占用、不得使用**（网关自动避开）：1234 LM Studio、3001 QQ、3080/3081 DSH、8790 自身。

### 分配规则（`src/ports.js`）

```
1. 配置里 port: 0              → 网关挑选
2. 同一 exclusiveGroup 的成员   → 强制共用一个端口
3. 不同组                      → 各自动找空闲端口（base 起，最多扫 portScanSpan 个）
4. 已分配的资源在进程内保持不变  → 重启服务不会换端口
```

**为什么同组必须共用一个端口**：`image`/`anima`/`breeze` 是同一个 ComfyUI 进程的三套配置。
给它们各分一个端口会让"任一时刻只有一个在跑"失效——三个不同端口看起来就是三个独立服务。
共用端口是它们关系的**事实**，不是优化。

**端口怎么进服务**：启动命令里用 `{port}` 占位，lifecycle 在 spawn 前替换。

```jsonc
// 脚本型（接受端口参数）
"start": { "script": "start_comfy.ps1", "args": ["-Port", "{port}", "-ReserveVram", "0"] }

// 环境变量型（embed-server 读 EMBED_PORT）
"start": { "cmd": "E:\\B\\venv\\Scripts\\python.exe", "args": ["..."],
           "env": { "EMBED_PORT": "{port}" }, "detached": true }
```

就绪探测用 `ready.path` 而不是完整 URL——主机固定本机，端口要运行时才知道：

```jsonc
"ready": { "path": "/system_stats", "timeoutSec": 180 }
```

### 只有 8790 需要暴露

```
网关自身接口      http://127.0.0.1:8790/api/...
ComfyUI 形状接口  http://127.0.0.1:8790/prompt、/history、/object_info …
WebUI             http://127.0.0.1:8790/
后端原生接口      http://127.0.0.1:8790/backends/<id>/<path>（逃生用）
```

---

## 4. 资源定义 schema

`config/resources.json`。新增模型 = 往 `resources` 加一项，无需改代码。

```jsonc
{
  "gateway": { "port": 8790, "host": "127.0.0.1" },
  "master": { "enabled": true },
  "gpu": { "totalMiB": 8188, "headroomMiB": 128 },
  "resources": {
    "image": {
      "label": "生图 · Qwen-Image 2.1",
      "enabled": true,
      "exclusiveGroup": "comfy",
      "port": 8188,
      "backend": "comfy",
      "vramMiB": 5500,
      "priority": 40,
      "keepAliveSec": 180,
      "start": { "script": "start_comfy.ps1", "args": ["-ReserveVram", "0"] },
      "stop":  { "script": "stop_services.ps1", "args": ["-Service", "comfy"] },
      "ready": { "url": "http://127.0.0.1:8188/system_stats", "timeoutSec": 180 },
      "workflow": "qwen21-image.json",
      "outputDir": "E:\\B\\output",
      "inject": { "prompt": { "node": "4", "field": "prompt" } }
    },
    "anima": {
      "label": "生图 · Anima Turbo",
      "enabled": true,
      "exclusiveGroup": "comfy",
      "port": 8188,
      "backend": "comfy",
      "vramMiB": 4000,
      "priority": 45,
      "keepAliveSec": 180,
      "start": { "script": "start_comfy.ps1", "args": ["-ReserveVram", "0"] },
      "stop":  { "script": "stop_services.ps1", "args": ["-Service", "comfy"] },
      "ready": { "url": "http://127.0.0.1:8188/system_stats", "timeoutSec": 180 },
      "workflow": "anima-image.json",
      "outputDir": "E:\\B\\output",
      "inject": { "prompt": { "node": "4", "field": "text" } }
    },
    "breeze": {
      "label": "语音 · Breeze TTS 2",
      "enabled": true,
      "exclusiveGroup": "comfy",
      "port": 8188,
      "backend": "comfy",
      "vramMiB": 5400,
      "priority": 30,
      "keepAliveSec": 180,
      "start": { "script": "start_comfy.ps1", "args": ["-DisableDynamicVram"] },
      "stop":  { "script": "stop_services.ps1", "args": ["-Service", "comfy"] },
      "ready": { "url": "http://127.0.0.1:8188/system_stats", "timeoutSec": 180 }
    },
    "tts": {
      "label": "语音 · GPT-SoVITS",
      "enabled": true,
      "exclusiveGroup": "gsv",
      "port": 9880,
      "backend": "gsv",
      "vramMiB": 5000,
      "priority": 10,
      "keepAliveSec": 300,
      "start": { "script": "start_gsv.ps1", "args": [] },
      "stop":  { "script": "stop_services.ps1", "args": ["-Service", "tts"] },
      "ready": { "url": "http://127.0.0.1:9880/tts", "timeoutSec": 180, "method": "HEAD" }
    },
    "memory": {
      "label": "记忆检索 · Qwen3-Embedding-0.6B",
      "enabled": true,
      "exclusiveGroup": "embed",
      "port": 9820,
      "backend": "embed",
      "vramMiB": 1200,
      "priority": 20,
      "keepAliveSec": 120,
      "start": { "cmd": "E:\\B\\venv\\Scripts\\python.exe", "args": ["E:\\B\\embed-server\\serve.py"], "detached": true },
      "stop":  { "url": "http://127.0.0.1:9820/shutdown", "waitSec": 30 },
      "ready": { "url": "http://127.0.0.1:9820/health", "timeoutSec": 60 }
    }
    // 未来 video 资源照此格式追加
  }
}
```

### 字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `enabled` | ✅ | 独立开关。`false` 时**拒绝拉起** |
| `exclusiveGroup` | ✅ | 同组互斥。共享端口的资源必须在同一组 |
| `port` | ✅ | 服务端口 |
| `backend` | ✅ | `comfy` / `gsv` / `embed`，决定路由用哪个后端实现 |
| `vramMiB` | ✅ | **实测增量**，供账本判断（见下方实测表） |
| `priority` | ✅ | 数字越小越优先；被抢占时大数字先让位 |
| `keepAliveSec` | ✅ | `>0` 保持秒数；`0` 用完立刻停；`-1` 常驻 |
| `start` | ✅ | `script`+`args`（走 PowerShell）或 `cmd`+`args`（直接执行）。**`detached: true` 用于本身就是服务的常驻进程**（见 §11） |
| `stop` | ✅ | 同上，或 `url`（POST 优雅关闭）。`waitSec` 是等待端口释放的上限（默认 30） |
| `ready` | ✅ | 轮询直到就绪；`method` 默认 GET。**判定是"有 HTTP 响应"，不是"200"** |
| `workflow` | comfy 生图 | 默认工作流文件名 |
| `inject` | comfy 生图必填 | 默认注入点：`{"prompt": {"node": "4", "field": "prompt"}}` |
| `injectByWorkflow` | 可选 | 按工作流覆盖注入点，**同一资源跑多个工作流时必查**（见下）。现在 anima 已拆为独立资源，一般用 `inject` 就够 |
| `outputDir` | 可选 | 产物落盘目录。给 `comfy` 后端填 ComfyUI 的 output 目录（`E:\B\output`），用于把裸文件名拼成绝对路径 |

> **什么时候该拆成独立资源**：如果用户会分别启停/观察它，就必须独立。
> Anima 原先只是 `image` 的一个 `workflow`，于是它在 WebUI 里没有自己的卡片、开关和拉起按钮
> —— 用户报「anima 未见控制按钮」就是这个原因。判断标准不是"是不是同一个后端进程"，而是
> **"用户会不会想单独控制它"**。共用后端端口由 `exclusiveGroup` 表达，不构成合并资源的理由。

### `inject` / `injectByWorkflow`：为什么必须显式声明

网关无法猜测任意图里哪个节点是文本输入，而且**猜错是静默的**：ComfyUI 会忽略未知
`inputs`，于是运行成功、出图却完全没用到 prompt。

这不是假设——构建期真实撞到过：**Qwen-Image 的字段叫 `prompt`，Anima 的叫 `text`**。
同一个 `image` 资源切到 Anima 工作流时，注入会失效且不报错。

因此：

- 解析顺序：`injectByWorkflow[工作流名][键]` ?? `inject[键]`
- **注入字段不存在于目标节点时直接报错**（不是警告），错误信息列出该节点实际有哪些字段
- 调用方自己的 `override` 保持宽松（允许新增字段），但节点 id 不存在同样报错

### 实测显存（增量，不是文件大小）

| 模型 | 实测峰值（含桌面） | 桌面基线 | **增量** |
|---|---|---|---|
| Qwen-Image 2.1 int8 | 7177 MiB | 2021 MiB | **5156 MiB** |
| Breeze TTS 2 int8-hybrid | 6398 MiB | ~1150 MiB | **~5250 MiB** |
| Anima Turbo v1.1（估） | ~5000 MiB | ~1000 MiB | ~4000 MiB |
| GPT-SoVITS v2ProPlus | 3060 MiB | ~0 | ~3000 MiB |
| embed-server | ~1200 MiB | — | ~1200 MiB |

配置取 `5500` / `5400` / `4000`：略高于实测增量，既能在真正紧张时拒绝，又不会因为几 MiB
的浮动误拒（实测过 `6500` 配 `headroom 300` 时差 8 MiB 就拒绝的窘境）。
Anima 那个 `4000` 是估值不是实测——它和 `image` 同组互斥，任一时刻只有一个在跑，
所以这个数字实际上不参与准入判断（组内互斥先于显存账本生效）。

### 显存账本规则

```
可用 = nvidia-smi 的 free − headroomMiB
```

注意 `nvidia-smi` 的 `used + free ≠ total`（驱动有预留），**`free` 才是可分配量**。

启动 `R` 前：若 `可用 < R.vramMiB` → 按 `priority` **从大到小**停掉其他**已启用**资源，
直到腾出足够空间。被停的资源标记 `yielded`，不再自动重启。

**资源已就绪时不再检查显存**——它已经加载了，重复检查只会误拒。

---

## 5. 开关语义

| 动作 | 行为 |
|---|---|
| `enabled = false`，收到调用 | **拒绝**，`409` + `reason: "resource"`，**不启动任何进程** |
| `master.enabled = false`，收到调用 | **拒绝**，`409` + `reason: "master"` |
| `enabled` 由 `true` → `false` | **立即停止**该服务；取消其 keepAlive 定时器 |
| `enabled = true` | 允许后续调用拉起；**不**主动拉起 |
| `master.enabled = false` | 全部拒绝拉起；**立即停止全部**（返回 `stopped` / `failed`） |
| 总控关闭时手动"拉起" | 拒绝，返回 `{ok:false, error:"master switch is off"}` |
| 资源关闭时手动"拉起" | 拒绝，返回 `{ok:false, error:'resource "x" is switched off'}` |
| 有请求在飞时切到关闭 | 立即停（面板操作视为强制）；调度器内部的让位会给在飞请求留 500ms |

**注意 `reason` 取值是 `master` / `resource`**，不是早期草案里的 `disabled`。

---

## 6. HTTP API

Base：`http://127.0.0.1:8790`

### 6.0 ComfyUI 形状的接口（**对外主接口**）

调用方按 **ComfyUI 的协议**用，不知道下面是哪个模型、哪个端口。模型由网关从图里的节点类
**推断**，需要时自动拉起。实现见 `src/comfyapi.js`。

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | **`/prompt`** | 提交 API 格式图，立刻返回 `{prompt_id, number, node_errors}`；后台执行 |
| `GET` | **`/history/<prompt_id>`** | 轮询结果，ComfyUI 形状的 `outputs` |
| `GET` | **`/history`** | 全部执行记录 |
| `GET` | **`/queue`** | `{queue_running, queue_pending}` |
| `POST` | **`/interrupt`** | 取消排队中的工作（已在采样的图需走后端 `/interrupt`） |
| `GET` | **`/object_info`** | 可通过本网关提交的节点类（**只列配置工作流实际用的**，不冒充全量） |
| `GET` | **`/object_info/<class>`** | 单个节点类 |
| `GET` | **`/models`** | 可用资源 + 网关分配到的端口（调试用，非 ComfyUI 标准） |

**模型是怎么选出来的**：按节点类匹配。图里出现的每个 `class_type` 都必须存在于某资源的
工作流中（或其在 `classes` 里声明的类），否则直接 400 拒绝——**在模型加载之前**，而不是
让它加载 6 GB 之后再报"未知节点"。

```jsonc
// 提交一张自己写的图（节点 id 与仓库里的工作流不同也没关系）
POST /prompt
{ "prompt": { "1": {"class_type":"UNETLoader", ...}, ... } }
→ { "prompt_id": "a389bdaa-...", "number": 1, "node_errors": {} }

// 轮询
GET /history/a389bdaa-...
→ { "a389bdaa-...": { "status": {...}, "outputs": { "anima": { "images": [...] } },
                      "resource": "anima", "artifacts": [...] } }
```

**补全缺失的保存节点**：调用方给的图如果自带 `Save*` 节点，原样提交；如果没有（多数客户端
只写"有意义的节点"），网关从该资源工作流里取出它的保存节点接上，这样输出才找得到。

**计时字段**（`/history` 里每一条都带）：

| 字段 | 含义 |
|---|---|
| `elapsedSec` | **调用方实际等待的总时长**，从 `/prompt` 被受理算起，含冷启动与让位腾显存 |
| `generateSec` | ComfyUI 真正执行的时间 |
| `loadSec` | 差值 = 排队 + 模型加载 + 启动服务 |
| `startedAt` / `completedAt` | ISO 时间戳，客户端可自行算端到端 |

三者关系恒为 `generateSec + loadSec ≈ elapsedSec`（测试里断言了这条）。

**边界为什么这么划**：`elapsedSec` 从**受理**开始，不是从 ComfyUI 开始执行。第一版把
计时起点放在 `runWorkflow` 内部，结果客户端实测 20.6 秒、网关报 7.2 秒——少的 13 秒正是
冷启动，而那恰恰是这些字段存在的意义。冷启动示例：

```
elapsedSec 20.5 s   generateSec 7.1 s   loadSec 13.4 s   (客户端实测 20.6 s)
```

而 `generateSec` 的起点也不是提交时刻：ComfyUI 的 history `status` 里**没有**开始时间戳，
只有 `status_str` / `completed` / `messages`。所以间隔靠**轮询 `/queue`、记录它不再排队的那一刻**
来界定；取不到时退回"整个等待都算生成"，宁可粗略也不编造。

**`classes` 字段**：为代码生成图的资源声明自己能跑的节点类。Breeze 的图是
`backends/breeze.js` 每次请求现拼的，没有 JSON 可introspect，所以配置里显式列出——
否则网关会以为没有任何模型能跑 Breeze 图。

### 状态与控制

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | **`/health`** | **探活，不碰后端**。返回 `{ok, master, uptimeSec, resources{id:{enabled,state,serveable}}}`。`serveable` = 总控开且该资源 enabled，调用它不会被 409 拒绝。**注意 `state:"idle"` 是正常状态**——本网关不常驻任何模型 |
| `GET` | `/api/heartbeat` | 当前进程存活状态（`pid/at/activity/lastError/uptimeSec`） |
| `POST` | `/api/shutdown` | 优雅停止：先停全部子服务再退出。`scripts/stop-gateway.ps1` 用它 |
| **任意** | **`/backends/<id>/<path>?<query>`** | **反向代理到该资源的后端端口**，见 §6.2。这是「只暴露 8790」的关键 |
| `GET` | `/api/status` | 全部资源 + 显存 + 总控 + 队列 + 互斥组归属 |
| `GET` | `/api/gpu` | 实时显存（无 `usableMiB`/`headroomMiB`，那两项在 status 里） |
| `GET` | `/api/config` | 当前完整配置 |
| `GET` | `/api/logs` | 最近 200 条日志 |
| `GET` | `/api/workflows` | 已加载工作流列表 |
| `POST` | `/api/workflows/reload` | 重载工作流目录 |
| `POST` | `/api/master` | `{enabled: bool}` 总控 |
| `POST` | `/api/resources/:id` | `{enabled?, keepAliveSec?, vramMiB?, priority?, label?}` |
| `POST` | `/api/resources/:id/start` | 手动拉起 |
| `POST` | `/api/resources/:id/stop` | 手动停止 |

### `GET /api/status` 响应

```jsonc
{
  "master": true,                                  // 布尔，不是对象
  "gateway": { "port": 8790, "uptimeSec": 1234 },
  "gpu": {
    "totalMiB": 8188, "usedMiB": 1353, "freeMiB": 6604,
    "ok": true,                                    // false 时三个数字全 0，UI 应显示"读取失败"
    "headroomMiB": 128,
    "usableMiB": 6476
  },
  "resources": [                                   // 按 priority 升序
    {
      "id": "image",
      "label": "生图 · Qwen-Image 2.1",
      "enabled": true,
      "running": false,
      "state": "idle",           // disabled|idle|starting|ready|busy|stopping
      "port": 8188,
      "backend": "comfy",
      "exclusiveGroup": "comfy",
      "groupActive": null,       // 该组当前在服务的资源 id；null = 端口活着但不是网关起的
      "blockedByGroup": null,    // 同组被别的资源占用时，这里是占用者 id
      "vramMiB": 5500,
      "priority": 40,
      "keepAliveSec": 180,
      "keepAliveRemainingSec": null,
      "startedByUs": false,
      "startedAt": null,         // epoch **毫秒**
      "lastUsedAt": null,        // epoch **毫秒**
      "lastError": null,
      "yielded": false,
      "inflight": 0,
      // `running` 是字面意义（端口有应答）；`active` 说明这个资源是否就是占用共用端口的那个。
      // 三个资源共用 8188，`running` 会对三者同时为 true——那是不可能的状态（一个端口一个监听者）。
      // 判断"到底哪个加载着"要用 `active`。
      "active": false,
      // 仅 backend=embed。运行时为当前版本，未运行时为 null。
      "encodeVersion": "2-maskpool",
      // 最近一次观测到的版本，跨 idle 保留（进程内）。**缓存键用这个**。
      "lastKnownEncodeVersion": "2-maskpool",
      // "live" | "remembered" | null
      "encodeVersionSource": "live",
      "info": { "ok": true, "model": "Qwen/Qwen3-Embedding-0.6B", "dim": 1024, "encodeVersion": "2-maskpool" }
    }
  ],
  "groups": { "gsv": "tts" },    // 各互斥组的归属
  "queue": [ { "id": "q-1", "resource": "tts", "priority": 10, "waitingMs": 1200 } ]
}
```

### 业务调用

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/api/image` | 生图 |
| `POST` | `/api/speak` | 语音合成（GPT-SoVITS 或 Breeze） |
| `POST` | `/api/search` | 记忆检索（嵌入或排序） |

### 6.3 能力路由：不指定 resource 时由网关决定

`/api/image`、`/api/speak`、`/api/search` 的 `resource` **全部可选**。省略时网关按
**能力** 挑一个当前可用的，而不是回落到某个写死的 id。

以前 `/api/speak` 是 `body.resource ?? 'tts'`。后果很具体：tts 关闭、breeze 启用时，
不指定 resource 的调用会收到一个关于 **tts** 的 409，而一个能正常说话的引擎就在同一个
端点后面。

**能力不是 backend 名字**。三个资源都是 `backend: 'comfy'`，只有 breeze 能出声：

| 资源 | 能力 | 依据 |
|---|---|---|
| `image` | `image` | comfy + 有 workflow |
| `anima` | `image` | comfy + 有 workflow |
| `breeze` | `speak` | comfy + 节点类含 `BreezeTTS2*`（**无 workflow，不能生图**） |
| `tts` | `speak` | gsv 后端 |
| `memory` | `search` | embed 后端 |

所以按 `backend === 'gsv' || backend === 'comfy'` 过滤是错的——它会把 image、anima 也
当成语音候选，然后在内部失败。判断依据必须是「它的工作流里有没有产出该输出的节点」，
这和 `/prompt` 推断模型用的是同一份证据。

**挑选规则**：

```
1. 显式指定的 resource 一律尊重（调用方知道网关不知道的事）
2. 否则在「有能力」且「enabled」的资源里按 priority 升序取第一个
   （与调度器抢占规则一致，避免网关有两种"最优"）
3. 全都 disabled → 仍返回优先级最高的那个，让 DisabledError 报出它的名字
   （拒绝理由必须真实，不能编一个默认值）
4. 没有任何资源具备该能力 → 400，并列出各资源的能力
```

配置里可以显式声明 `capabilities: ["speak"]` 覆盖推断，用于本文件不认识的 backend。

**响应带 `resource` 字段**，说明实际是谁服务的；`backend` 说明用的哪个引擎——两者
不一定一一对应（资源 id 和引擎不是一回事）。

`GET /api/status` 额外返回：

```jsonc
"routing": {
  "speak":  { "resource": "breeze", "allDisabled": false },
  "image":  { "resource": "image",  "allDisabled": false },
  "search": { "resource": "memory", "allDisabled": false }
}
```

这是**路由决策本身**，不是重新推导一遍，所以调用方看到的就是网关真会做的。

**`POST /api/image`**

```jsonc
{
  "prompt": "生成一张漫画风格的慵懒少女",
  "resource": "image",              // 可选；省略则按能力路由（可能选中 anima）
  "workflow": "qwen21-image-api.json",   // 可选，默认取资源配置
  "override": { "5": { "seed": 123 } },  // 可选，按节点 id 覆盖
  "timeoutSec": 900
}
```

响应：

```jsonc
{
  "ok": true,
  "resource": "image",                        // 实际服务的资源
  "workflow": "qwen21-image-api.json",
  "promptId": "...",                          // 可用于向 ComfyUI 的 /history 核对该图实际内容
  "images": ["qwen21_00001_.png"],            // 裸名，ComfyUI 语义，兼容既有调用方
  "artifacts": [                               // 统一形态：带绝对路径
    { "type": "image", "filename": "qwen21_00001_.png", "path": "E:\\B\\output\\qwen21_00001_.png" }
  ],
  "outputDir": "E:\\B\\output",
  "elapsedSec": 137.5
}
```

**所有产出文件的端点都返回 `artifacts`**（`/api/image`、`/api/speak`），元素形如
`{type, filename, path}`。此前 `/api/image` 只给裸名、`/api/speak` 给绝对路径，
调用方必须先知道自己调的是哪个端点才能打开结果——那个不一致现在没有了。
`images` / `file` 作为兼容字段保留。

### 6.2 `/backends/<id>/…` 反向代理：只暴露 8790

业务端点本来就只谈 8790，但**网关没包装的东西**（ComfyUI 的画布、`object_info`、某个
特定 GGUF）以前仍需直连 8188/9880/9820。一台机器上三个端口、三套生命周期，正是本项目
要消除的耦合。

```
GET  /backends/anima/system_stats
GET  /backends/anima/object_info/KSampler
POST /backends/image/prompt
GET  /backends/tts/docs
```

规则：

| 项 | 行为 |
|---|---|
| 目标 | `http://127.0.0.1:<resource.port>/<path>`，路径与查询串原样透传 |
| 准入 | **必须**经 `scheduler.run`：资源关闭时返回 409、总控关闭时返回 409、显存不足时 503，与业务端点**完全一致** |
| 隐存 | 代理访问会取消待执行的 idle 释放（等于"有人在用它"） |
| 副作用 | 资源没起来会自动拉起（这就是不必知道后端端口的原因） |
| 响应 | 状态码与 `Content-Type` 透传，body 原样流回，**不做任何改写** |
| 未知名 | 返回 404 并列出可用 id |

**代理不是后门**：它不绕过开关、不绕过显存预算、不绕过互斥。测试里有三条断言专门锁这点
（关闭时 409 + `reason:"resource"`、未知资源 404、真实转发 200）。

**为什么不直接放开后端端口给调用方**：那样每个调用方都要自己判"服务起没起、能不能起、
该不该让位"，而这套判断在网关里只有一份。暴露三个端口等于把这份逻辑复制到每个客户端。

**`POST /api/speak`**

`resource` **可选**：省略时按能力路由（见 §6.3），响应里会说明实际用了谁。

两种后端参数要求不同，所以省略 resource 时要注意：**GSV 必须给 `refAudioPath`**（每次从
参考音频克隆，没有默认值）与 `promptText`；**Breeze 必须给 `mode` 及该模式的参数**。
两者的必填项不一样，所以省略 resource 的调用应当传「两种都认」的字段，或者干脆显式指定。

GSV：

```jsonc
{ "text": "老大 我今天不想动",
  "refAudioPath": "E:\\B\\voices\\ref-1.wav",
  "promptText": "我之前听泰国歌曲好倒掉然后跟人家接" }
```
响应：`{ok, resource, backend:"gsv", file, filename, bytes, artifacts, elapsedSec}`

Breeze：

```jsonc
{ "mode": "design",
  "text": "老大 我今天不想动", "instruction": "一位温柔自信的年轻女性…" }
```
`clone` / `direction` 额外需要 `reference`（ComfyUI input 目录里的文件名）与
`referenceText`。响应：`{ok, resource, backend:"comfy", mode, promptId, audio, artifacts, elapsedSec}`

**`POST /api/search`**

两种用法，二选一：

```jsonc
{ "texts": ["文本一", "文本二"] }                         // → {ok, resource, vectors, dim}
{ "query": "查询", "candidates": ["候选1","候选2"], "topK": 5 }  // → {ok, resource, ranked:[{index,score,text}]}
```

### 错误响应

| 状态 | 何时 | 体 |
|---|---|---|
| `409` | 开关关闭 | `{ok:false, error, reason:"master"\|"resource", resource}` |
| `503` | 显存不足 | `{ok:false, error, reason:"no-room", resource, needMiB, haveMiB}` |
| `400` | 参数非法 | `{ok:false, error, reason:"bad-request"}` |
| `404` | 路径不存在 | `{ok:false, error, available:[...]}` |
| `500` | 其他 | `{ok:false, error}` |

**未知资源 id 返回 500**（`scheduler.run` 抛出），不是 404 —— 客户端不应假定 404。
`/prompt` 的"没有模型能跑这张图"是 **400**（调用方的图不对，不是服务故障）。

---

## 7. 调度规则

1. **串行化**：同一时刻只有一个资源在"启动中"，避免并发启动竞争。
2. **优先级**：`tts(10) > memory(20) > breeze(30) > image(40) > anima(45) > video(50)`。
   anima 排最后：它最快（20–45 秒），最不需要优先满足；被它挤掉一张要两分钟的生图不划算。
3. **让位**：显存不足时按 priority 从大到小停，且**不动有在飞请求的资源**。
4. **keepAlive**：请求完成后按 `keepAliveSec` 定定时器；期间再来请求则取消。
   每次读最新配置，所以 WebUI 改完对**下一次释放**立即生效，无需重启。
5. **互斥组**：同组资源启动前先停组内其他成员（端口共享，且启动参数可能互斥）。

---

## 8. WebUI 要求

单页，原生 HTML/CSS/JS，与网关同端口 8790。

1. **总控开关**：一关全关（拒绝 + 停止全部），关闭时禁用拉起按钮并提示
2. **每个资源一张卡片**：名称、端口、显存、优先级、状态、运行时长、keepAlive 倒计时、
   最近使用、`lastError`
3. **独立开关**（切换即生效：关＝立即停）
4. **拉起 / 停止按钮**，按 `running`、`enabled`、`master`、离线、操作中五种条件门控
5. **保持时间输入**（秒，可调；标注 `0`=用完立即停、`-1`=常驻）
6. **显存条**：总量/已用/可用/安全余量；`gpu.ok === false` 时显示"读取失败"而非 0
7. **队列视图**
8. 每 2 秒轮询 `/api/status`；操作后立即刷新
9. fetch 失败显示"网关未启动"横幅并自动重试，**不白屏**
10. **端口必须标注是"后端端口"**：共用时显示 `8188（3 个共用）` 并说明互斥，
    否则三张卡片写同一个数字会被读成配置错误
11. **同一资源的控制要能独立操作**：不同工作流如果用户会分别启停，就必须拆成独立资源，
    否则它只有别人卡片上的一个下拉框

---

## 9. 扩展方式

| 想做什么 | 怎么做 |
|---|---|
| 换模型 | 改 `resources.json` 里该项的 `vramMiB` / `start.args` / `workflow`，重启网关 |
| 加服务 | 在 `resources` 加一项，填 §4 字段。**不改代码** |
| 加工作流 | 放 `config/workflows/`，然后 `POST /api/workflows/reload` |
| 切工作流 | **必须**为该工作流确认 `inject`（字段名可能不同），必要时加 `injectByWorkflow` |
| 加视频 | schema 已预留；先确认可用显存与模型变体 |

---

## 10. 验收标准与实测证据

| # | 标准 | 证据 |
|---|---|---|
| 1 | 关闭开关后调用返回 409 且进程未被拉起 | `smoke` 12/12：409 + `reason` + 端口未开 + 手动拉起被拒 |
| 2 | 运行中切关闭，进程停止、显存释放 | `test-start` 10/10：stop 后端口释放 |
| 3 | 总控关闭后全部拒绝拉起 | `smoke` 步骤 1 |
| 4 | WebUI 改保持时间立即生效 | `smoke` 步骤 4（77 持久化）；`-5` 被 400 拒绝 |
| 5 | `POST /api/image` 真正出图 | **实测 200，142.9s，`qwen21_00001_.png` 1024×1024** |
| 6 | 新增资源只改 json | 配置校验器 `validateConfig` 0 problems |
| 7 | 冷启动能拉起来 | `test-start`：冷启动 **16.6s**，无超时 |
| 8 | 注入点不静默失效 | `test-injection` 15/15：anima 用 `text`、qwen21 用 `prompt`，写错字段被拒 |
| 9 | 常驻服务（memory）能拉起并能停下 | `test-start memory` 10/10：冷启动 **10.9s**（修复前 120s 超时并杀掉健康进程） |
| 10 | 记忆检索端到端可用 | `test-memory` 16/16：`encodeVersion="2-maskpool"`、中文向量可区分、排序正确、stop 释放端口 |
| 11 | 共用端口的资源可独立控制 | `test-resources` 19/19：anima 有独立开关且生效、关闭时 409 |
| 12 | 共用端口不会都报"在运行" | `test-resources`：同组至多一个 `active` |
| 13 | 只暴露 8790 也能访问后端 | `test-resources`：`/backends/anima/system_stats` 200，`object_info` 嵌套路径 200 |
| 14 | 代理不是后门 | `test-resources`：关闭时 409 + `reason:"resource"`、未知资源 404 |
| 15 | 代理算"在用" | `test-resources`：代理访问后 keepAlive 重置为 180s |
| 16 | 端口由网关分配，不写死 | `test-comfyapi`：`/models` 里每个资源都有网关分配的端口；配置 `port: 0` |
| 17 | 同组资源共用一个端口 | 启动日志 `ports allocated: image=8188, anima=8188, breeze=8188` |
| 18 | 对外只有 ComfyUI 形状的接口 | `test-comfyapi` 17/17：全程只访问 8790 的 `/prompt`、`/history`、`/object_info` |
| 19 | 手写图能被自动路由并出图 | `test-comfyapi`：自造节点 id 的图 → `resource=anima`，产出 `dafiyu_00022_.png` |
| 20 | 模型按节点类推断，不会误路由 | `test-comfyapi`：Breeze 图 → `resource=breeze`，不是 image |
| 21 | 跑不了的图在加载前拒绝 | `test-comfyapi`：未知节点 → **400**，不是让模型先加载再报错 |
| 22 | `/history` 的计时字段是真实数字 | `test-comfyapi` 26/26：`elapsedSec=4.1` 非 null；`generateSec + loadSec ≈ elapsedSec`；**且 `elapsedSec` 与客户端实测相差 ≤3 秒** |
| 23 | 冷启动能被计时区分出来 | 实测 `elapsedSec 20.5 / generateSec 7.1 / loadSec 13.4`（客户端实测 20.6） |
| 24 | **生成期间不会被停用** | `test-busy` 9/9：keepAlive 设 10 秒、单图约 45 秒，**过了 keepAlive 仍在跑**，最终 `success` |
| 25 | 忙碌状态可见且会复位 | `test-busy`：生成中 `backendBusy=true`，完成后回到 `false` |
| 26 | 三套工作流的 UI 格式可被 ComfyUI 打开 | `validate_ui_workflow.py` 对三份全部 `ok`（节点、widget 顺序、连线均与活服务 schema 一致） |
| 27 | WebUI 拉起不再误报超时 | 控制请求超时 240 秒（原为 5 秒） |
| 28 | 不指定 resource 时按能力路由 | `test-capability` 23/23：tts 关+breaze 开时 `/api/speak` 不指定 resource → **200 且 `resource=breeze`** |
| 29 | 能力不是 backend 名字 | `test-capability`：三个 comfy 资源里只有 1 个能 speak；breeze 不被当作生图资源 |
| 30 | 显式指定仍被尊重 | `test-capability`：指定 breeze 时 `resource=breeze`，不被路由到 tts |
| 31 | 多个可用时按 priority 选 | `test-capability`：tts 与 breeze 都启用时 → `tts`（10 < 30） |
| 32 | 全部禁用时拒绝理由真实 | `test-capability`：409 且 `resource` 是真实候选（tts），不是编造的默认值 |
| 33 | 能力不符时错误说清楚 | `test-capability`：让 breeze 生图 → `400 resource "breeze" cannot image; it can: speak` |
| 34 | 死掉的进程不会被当成活的 | `test-stale` 22/22：`taskkill /F /T` 杀掉后端后，`state` 变 `idle`、`running=false`、计时器清空 |
| 35 | 死掉后下一个请求自愈 | `test-stale`：杀掉后再调 `/api/speak` → **200**（不是 500），端口重新监听 |
| 36 | idle 计时器自己清理死服务 | `test-stale`：keepAlive 6 秒，杀进程后**不发任何 status 请求**，到期后 `state=idle` |
| 37 | 活着的服务不会被误清理 | `test-stale`：连续 3 次 status 轮询后状态不变；正常启动期间 `starting` 误报数 = 0 |

复跑：

```powershell
node src\cli.js smoke            # 开关语义（约 30s，会真的停一次服务）
node src\test-injection.js       # 注入点（纯逻辑，秒级）
node src\test-start.js image     # 冷启动，长命令型（约 1 分钟）
node src\test-start.js memory    # 冷启动，常驻型（约 30 秒）
node src\test-memory.js          # 记忆检索端到端（约 30 秒）
node src\test-prompt-delivery.js # prompt 真的进了模型（约 1 分钟）
node src\test-resources.js       # 共用端口 / 独立控制 / 代理（约 1 分钟）
node src\test-comfyapi.js        # ComfyUI 形状接口 + 模型推断（约 2 分钟）
node src\test-busy.js            # 生成期间不被停用（约 2 分钟）
node src\test-capability.js      # 能力路由（约 3 分钟，会真的合成一次语音）
node src\test-stale.js           # 进程死亡后的状态自愈（约 2 分钟，会真的杀后端进程）
node src\stress-status.js memory # 并发 status + start 压测（约 30 秒）
node src\test-crash.js           # 并发压力（约 1 分钟）
node src\measure-image.js "提示词"   # 端到端生图 + 显存采样（约 3 分钟）
```

**测试自身也要能被信任**：断言辅助只在 `src/test-util.js` 里实现一份。此前三个测试
各自复制了 `check()`，且都写成声明三参数、调用传四参数，导致字符串落进 `passed` 位、
**每个断言都恒为真**。三份"全过"的结果因此毫无意义。现在没有第二份签名可以漂移。

---

## 11. 已知约束（全部实测）

- **可用显存约 6600–6700 MiB**（8188 总量 − 桌面 1300–2000 − headroom 128）
- **任意两个大模型不能共存**：`5156 + 1200 > 6600`
- **DynamicVRAM 冲突**：生图要**开**（137s vs 638s），Breeze 要**关**（40s vs 250s）
  → 两者共用同一端口，必须互斥且用不同启动参数
- **后端端口是运行时才定的**：日志里 `ports allocated:` 才是本次的真实分配；
  文档里出现的 8188 只是默认起点（`backendPortBase`），不是保证
- **`{port}` 占位只在 `start`/`stop` 生效**：`ready.path` 自动拼端口，不要手写完整 URL
- **`/prompt` 的模型推断靠 `class_type`**：自造节点类的图会被 400 拒绝——这是设计，不是缺陷
- **ComfyUI 的 `/queue` 和 `/history` 看不到"正在执行"**：实测生成期间两者都是空的
  （提示词被取走后就不再出现在 queue 里）。**判断忙闲必须用网关自己的未完成执行记录**，
  不能靠探测后端
- **`/prompt` 的提交是"立即返回"的**：HTTP 请求结束不等于活干完。任何"请求结束就认为空闲"
  的逻辑都会在长图生成中途停掉服务
- **ComfyUI 按图内容缓存**：相同 seed 的重复图约 1 秒返回，队列全程为空。
  测试要变 seed，否则观察不到忙碌窗口
- **`ready` 必须被验证，不能被相信**：后端进程死亡没有任何回调通知。`ensureRunning`
  和 `/api/status` 都会探端口；`starting` **不算**"声称活着"（端口当然还没监听）
- **探测端口时"声称 up"要用 `fresh`**：`isReachable` 有 2.5 秒缓存，缓存会让刚死的
  服务继续显示可达
- **idle 计时器到期时先探端口再判"未知"**：死服务恰好探测失败（=未知），
  而"未知则续命"的分支会让它每 keepAlive 自我续命一次、永远不清理
- **重启脚本必须轮转日志**：曾两次无法诊断崩溃，因为每次启动都覆盖了崩溃现场
- **冷启动**：ComfyUI 约 17–70 秒（视缓存）；GPT-SoVITS 约 70 秒
- **`cuda_graphs` 模式会崩 ComfyUI**，Breeze 一律用 `eager`（代码内固定）
- **启动命令的输出必须写文件不能走管道**：`Start-Process` 的子进程会继承管道，
  Node 等不到 `close`，实测报 120s 超时（而服务其实已就绪）
- **常驻服务必须标 `detached: true`**：`serve.py` 这类命令**本身就是服务**，永不退出。
  按"等命令结束"的语义处理，网关会等满超时再 `kill` 掉一个已经健康运行 117 秒的进程。
  标了 `detached` 后启动即交接，成功与否由 `ready` 决定；另给 700ms 宽限，
  让"路径错/模块缺失"这类立即崩溃仍能被报成启动失败而不是就绪超时
- **探测失败不等于服务不健康**：`/api/status` 的探测会在超时后中断连接，服务端把这
  看成调用方掉线并记一条错误日志。探测结果现有 2.5 秒缓存，且并行执行；
  决策路径（是否要拉起）与就绪轮询都传 `fresh: true` 绕过缓存
- `nvidia-smi` 的 `used + free ≠ total`；**用 `free` 判断可分配量**
- **必须用 `scripts/start-gateway.ps1` 启动，不要用 `Start-Process`**：后者让发起方成为父进程，
  父进程退出时网关被连带回收，表现为「静默退出、stderr 为空」。实测：`Start-Process`
  起的进程下一次调用前即消失，WMI 起的长期存活
- **必须用 `scripts/stop-gateway.ps1` 停止**：Windows 对无窗口进程没有可用 SIGTERM，
  `Stop-Process` 是硬终止，会遗留子服务占着显存
- `stop_services.ps1 -Service` 合法值：`all | comfy | tts`（不含 embed；memory 用 `/shutdown`）
- 同端口的互斥资源**外部启动时无法区分是哪套配置**，`groupActive` 为 `null`
- **测试脚本不要用 `process.exit()`**：Windows 上会在 HTTP 套接字关闭途中触发 libuv
  断言 `!(handle->flags & UV_HANDLE_CLOSING)`，并把退出码改成 1，让通过的测试看起来是失败。
  用 `test-util.js` 的 `exitWith()`

---

## 12. 修订记录

按实现与实测校正的条目（原草案 → 现状）：

| 项 | 原草案 | 校正为 |
|---|---|---|
| 409 `reason` | `"disabled"` | `"master"` / `"resource"` |
| `/api/image` 响应 | `{ok,file,path,elapsedSec}` | `{ok,workflow,promptId,images[],elapsedSec}` |
| `/api/speak` 必填项 | 未说明 | GSV 必须 `refAudioPath`；Breeze 必须 `mode` + 分支参数 |
| `/api/search` 必填项 | `{query,topK}` | `{texts}` 或 `{query,candidates,topK}` |
| 错误响应格式 | 未定义 | §6 错误表 |
| 成功响应体 | 未定义 | §6 各接口已列 |
| `lastUsedAt` 格式 | 未定义 | epoch **毫秒** |
| `master` 类型 | §4 对象 vs §6 布尔 | API 返回**布尔**，配置里是 `{enabled}` |
| 运行时长字段 | §8 要求但 §6 无 | 补 `startedAt`、`yielded`、`inflight` |
| `gpu` 字段 | 无 `ok`/`headroomMiB` | 补齐 |
| 注入点 | 无 | 新增 `inject` / `injectByWorkflow`（防静默失效） |
| 显存数字 | 估算 6800/6400 | 实测增量 5500/5400 |
| `headroomMiB` | 300 | 128 |
| 启动命令输出 | 管道 | 文件（管道会挂住） |
| 源文件组织 | `src/routes/*` | 合并进 `server.js`（路由表很小） |

### 第二轮：来自调用方（记忆检索）的缺陷报告

| 缺陷 | 原因 | 修复 |
|---|---|---|
| **memory 拉起后 120s 超时，健康进程被杀** | `runCommand` 等 `close`，而 `serve.py` 永不退出；超时后 `kill` 掉刚起来的服务 | 新增 `start.detached`；启动即交接，成功由 `ready` 判定，另留 700ms 抓立即崩溃 |
| 健康探测引发服务端 `ConnectionResetError` | `/api/status` 每次轮询对每个资源探测，超时中断连接被服务记为错误 | 探测加 2.5s 缓存并并行；决策路径与就绪轮询用 `fresh: true` |
| `/api/status` 无 `encodeVersion` | 调用方的向量缓存以编码器版本为键，没有它只能用常量，换模型后静默复用旧向量 | status 对运行中的 embed 资源附 `info` 与顶层 `encodeVersion` |
| `/api/search` 无服务端超时 | embed 调用没有 deadline，服务中途死掉则请求既不返回也不失败 | `embed`/`similarity` 加 `AbortController` 超时，默认 120s，可用 `timeoutSec` 覆盖 |
| memory 无 `stop.waitSec` | 只配了 `url`，未声明等待上限 | 配置显式 `waitSec: 30` |
| 测试假通过（三次） | 三个测试各自复制 `check()`，都声明三参数、调用传四参数，字符串落进 `passed` 位 → 断言恒为真 | 抽出唯一一份 `src/test-util.js`；签名不再有第二份可漂移 |
| 测试通过却退出码 1 | `process.exit()` 在套接字关闭途中触发 libuv 断言，断言把退出码改成 1 | 改用 `exitWith()`（设 `exitCode` + 排空事件循环） |

### 第三轮：来自 `dsh-canvas` 插件适配

| 问题 | 实情 | 处置 |
|---|---|---|
| **prompt 对 anima 无效** | **网关侧在第二轮已修**（`injectByWorkflow` 按工作流选字段 + 字段不存在即报错）。**用 ComfyUI 的 `/history` 读回实际提交内容验证过**：marker 落在 `anima-image.json` 的 `4.text`，且未落进任何未读字段 | 插件侧的 `buildOverride()` 仍按需要保留（它还处理分辨率/seed 在不同工作流的字段位置），但**prompt 字段映射已不必再由插件承担** |
| 图片给裸名、语音给绝对路径 | 确实不一致，调用方得先知道调的是哪个端点 | 两者统一返回 `artifacts: [{type, filename, path}]`；原有 `images`/`file` 保留兼容 |
| 没有 `/health` | 合理需求 | 新增 `GET /health`：不碰后端，返回 `serveable`（总控开且该资源 enabled）；**`state:"idle"` 是正常状态**，本网关不常驻任何模型 |
| `/api/status` 无 encoder 版本 | **第二轮已修** | 现返回 `resources[].encodeVersion`（实测 `"2-maskpool"`）与 `info` |

**新增测试**：`src/test-prompt-delivery.js` —— 不只读配置，而是拿 `/api/image` 返回的
`promptId` 去问 ComfyUI「你实际收到了什么」，再断言 marker 落在声明字段上。
配置检查会漏掉这一类问题：注入错字段时图照跑不误、只是内容不对。

### 第四轮：「网关静默退出」的调查结论

**它没有崩溃。它被连坐杀掉了。**

现象：16:15 在 `/api/speak` 期间网关整个消失，日志停在 `tts ready`，**stderr 0 字节**。

推理链：stderr 为 0 且无 `uncaughtException` 记录 → **不是 JS 异常**（该处理器会先写日志）。
剩下的只有"被外部终止"或"原生代码崩溃"。

**实测定位**：用 `Start-Process` 起的进程，在下一次工具调用前就消失了；用
`Win32_Process.Create`（父进程是 `WmiPrvSE`，不隶属任何交互式会话）起的进程长期存活。
网关此前正是从 shell 工具调用里用 `Start-Process` 起的——**工具调用结束时整棵进程树被回收**。
所以"静默退出、没有错误、没有 stderr"完全自洽：从进程内部看不到自己被终止。

**修复**：

| 项 | 做法 |
|---|---|
| 启动方式 | 新增 `scripts/start-gateway.ps1`，用 WMI 让网关挂到服务宿主下，与任何 shell 解耦 |
| 优雅停止 | 新增 `POST /api/shutdown` + `scripts/stop-gateway.ps1`。Windows 对无窗口进程没有可用 SIGTERM，`Stop-Process` 是硬终止，会遗留子服务占着显存（曾见 5817 MiB 无人回收） |
| 死因可查 | `src/heartbeat.js`：每 5 秒写 `output/logs/heartbeat.json`（pid/时间/当前操作）。干净退出会重写为 `cleanExit:true`；否则下次启动打印「上次非正常退出 + 时间 + 最后在做什么」 |
| 单实例 | `output/logs/gateway.pid` 锁。两个网关会争抢同一批子服务，一个的 stop 会杀掉另一个正在生成的模型 |
| 阻塞式关闭 | `server.close()` 加 3 秒上限，长连接不会让停止看起来像挂死 |

**压测结论**（`src/test-crash.js`，6/6）：60 个并发请求、15 个中途断开的请求、
10 Hz 状态轮询期间拉起服务——网关全部存活（uptime 156s）。**在正确的启动方式下无法复现，
进一步佐证"外力终止"而非自身缺陷**。

### 第四轮：`encodeVersion` 的契约陷阱

原实现只在 `ready`/`busy` 时有值。这不是缺陷——服务没跑就没有版本可读——但对调用方是陷阱：
本网关绝大多数时间让资源处于 `idle`，于是 `encodeVersion` 几乎永远读到 `null`，
按它做缓存键会导致**缓存永久失效**（调用方原话：差点这么写）。

改为两个字段，语义分开：

| 字段 | 含义 |
|---|---|
| `encodeVersion` | **当前**运行的版本；服务未运行时为 `null` |
| `lastKnownEncodeVersion` | **最近一次观测到**的版本；跨 idle 保留（进程内） |
| `encodeVersionSource` | `"live"` / `"remembered"` / `null`，说明值从哪来 |
| `lastKnownEncodeVersionAt` | 记忆值的时间戳（仅 `remembered` 时出现） |

**缓存键应用 `lastKnownEncodeVersion`**；需要确认读数新鲜时才看 `encodeVersion`。
记忆只在进程内存里：重启后服务也随之重启，旧版本对新服务不是证据。

### 第四轮：双 python 进程

**不是缺陷**。GPT-SoVITS 的两个进程是父子关系（`venv-tts\Scripts\python.exe` → 
`python312\python.exe`），同一条命令行：venv 的 `python.exe` 只有 255 KB，
是 launcher，负责选解释器再 exec。这是 Windows 上 venv 的正常行为。

### 第五轮：WebUI 的三个问题

| 报告 | 实情 | 处置 |
|---|---|---|
| 语音与生图端口重合 | **不是重合，是共用**。`image`/`anima`/`breeze` 都驱动 ComfyUI 的 8188；一个端口只能有一个监听者，所以它们**必须互斥**。错的是展示：三张卡片都写"8188"，看起来像配错了 | 卡片改为 `8188（3 个共用）`，悬停列出成员并说明"任一时刻只有一个在运行、对外请用 8790" |
| anima 没有控制按钮 | 它只是 `image` 资源的一个 `workflow`，不是独立资源，因此没有自己的卡片 | 拆成独立资源（`vramMiB 4000`、`priority 45`、`inject` 指向 `text`），现在有独立的开关/拉起/停止/保持时间 |
| 占用端口过多，建议整合为一个路由 | 业务端点本来只谈 8790，但**网关没包装的路径**仍需直连后端端口 | 新增 `/backends/<id>/…` 反向代理（§6.2），8790 成为唯一需要的端口 |

#### 附带修掉的一个真实缺陷：同组资源都报 `running`

加了 anima 之后 `test-resources` 立刻抓到：`breeze` 和 `image` 同时报 `running: true`，
**而它们共用一个端口——不可能两个都在跑**。

根因是状态探测按资源做，而"端口有应答"对同组三个资源都成立。修法两层：

1. **探测按组做一次**，不是按资源做三次；组内若无人持有归属，才把端口记到某个资源名下
2. **新增 `active` 字段**：`running` 保持字面意义（端口有应答），`active` 说明**这个资源是否
   就是占用该端口的那个**。判断"到底哪个加载着"必须用 `active`

这不只是显示问题——一个会同时报告三个资源在运行的面板，会让人不相信它的其他任何输出。

### 第六轮：端口动态分配 + ComfyUI 形状的对外接口

**要求**：不写死硬编码；网关智能调配；只有一个端口给外部；模型不设独立端口；
对外统一包装成 ComfyUI 的 API。

| 要求 | 实现 |
|---|---|
| 不写死端口 | 配置里 `port: 0`，`src/ports.js` 在启动前**绑定探测**找空闲端口。脚本用 `{port}` 占位，lifecycle 在 spawn 前替换；embed-server 走 `EMBED_PORT` 环境变量 |
| 智能调配 | 同 `exclusiveGroup` **强制同端口**（它们本来就是一个进程）；不同组各挑空闲端口；已分配的在进程内保持不变，重启服务不换号 |
| 只有一个端口 | 8790。后端端口不出现在任何对外契约里 |
| 统一的 ComfyUI API | `src/comfyapi.js`：`/prompt`、`/history`、`/queue`、`/interrupt`、`/object_info` + `/models` |
| 模型智能选择 | 按**节点类**匹配：图里每个 `class_type` 必须在某资源的工作流（或 `classes` 声明）里存在，否则 **400 在加载前拒绝** |

#### 三个实现时踩到的坑（都由测试抓到）

| 现象 | 原因 | 修法 |
|---|---|---|
| `POST /prompt` 执行报 `ports is not defined` | `scheduler.js` 里改用了 `ports.readyUrl` 但没 import | 补 import。**这个错误只在真实执行 /prompt 时暴露**，单测逻辑不触发 |
| `/models`、`/object_info` 返回 `not found` | 它们是 ComfyUI 的根路径，不在 `/api/` 下，被静态文件分支吃掉 | 显式白名单 `COMFY_PATHS`。不用"不是文件就走路由"，否则拼错路径会变成静态 404，看起来像路由没写 |
| Breeze 图被拒绝 "no configured model can run this" | Breeze 的图是代码现拼的，没有 JSON 可 introspect | 新增 `classes` 字段让这类资源声明自己能跑的节点类 |

#### 模型推断的判定

```js
// 硬过滤：图里每个 class_type 都必须在该资源可用类里
const missing = [...wanted].filter((t) => !available.has(t));
if (missing.length > 0) continue;
// 打分：可用类里"用不上"的越少越贴合
score = -unused;
```

先过滤再打分，因为**跑一张含未知节点的图，代价是先加载 6 GB 模型再报错**。宁可提前 400。

#### 同组必须同端口

`image`/`anima`/`breeze` 是同一个 ComfyUI 进程的三套配置。给它们各分一个端口会让
"任一时刻只有一个在跑"这个保证失效——三个不同端口看起来就是三个独立服务，而它们不是。
所以 `allocatePorts` 先按组分配，组内成员共享同一个号。

### 第八轮：生成到一半模型被停用 / WebUI 拉起报错 / 需要工作流文件

#### ① 生成中途被停（最严重）

**现象**：经 API 调用 Qwen-Image，生成到一半模型被网关停用。

**机制**（读代码即可确认）：ComfyUI 的 `POST /prompt` **立即返回 `prompt_id`，在后台执行**。
所以 `scheduler.run` 的 work 函数在拿到 id 的那一刻就结束了，`inflight` 归零、idle 计时开始，
而 ComfyUI 还没开始采样。Qwen-Image 512px 要 45 秒，冷启动更久——180 秒的 keepAlive 只是
运气好；换更长的图或冷启动，就会在生成中途被停。

**关键难点：ComfyUI 的状态接口看不到正在执行**。实测生成期间：

```
/queue        queue_running=[]  queue_pending=[]        ← 空的
/history      没有未完成条目                              ← 空的
```

提示词只在**排队**时出现在 queue 里，被取走后就开始执行、两个接口都不再有痕迹。
所以「探测 ComfyUI 来判断忙不忙」这条路是错的——我一开始就是这么做的，测试立刻失败。

**正确的信号在网关自己手里**：`comfyapi.submitPrompt` 受理一张图时就把执行记成
`completed: false`，跑完才改 true。**有未完成的执行 = 有活**，这个记录不可能错，
因为它是网关自己收下的。

实现上 `scheduler.hasUnfinishedExecutions()` 读 `globalThis.__lmGatewayExecutions`
（comfyapi 在模块加载时发布，避免循环 import），而 idle 计时器到期时：

| 检查 | 动作 |
|---|---|
| `inflight > 0` | 重新计时，不停 |
| 有未完成执行 | 重新计时，不停 |
| 后端探测返回 `null`（未知） | **重新计时，不停**——未知不等于空闲 |
| 确认空闲 | 停止服务 |

后端探测保留为**次要**信号，覆盖直接经 `/backends/<id>/prompt` 提交、网关没记录的图。

**测试**（`test-busy.js` 9/9）故意把 keepAlive 设成 10 秒而单张图要 45 秒，
无修复必死；关键断言是「过了 keepAlive 仍在跑」。第一版测试用固定 sleep 断言、
还对 `/queue` 断言，**两次都是测试自己的错**，已改成轮询并去掉错误前提。

#### ② WebUI 手动拉起弹窗报错

**根因**：WebUI 的请求超时统一是 **5 秒**，而拉起 qwen-image 需要 30–70 秒。超时后弹
「无法连接网关」，但后端其实正在正常启动——一个吓人的错误弹窗对应一次正常操作。

修法：控制类请求（start/stop/总控关）用 `ACTION_TIMEOUT_MS = 240000`，状态轮询保持 5 秒。

#### ③ 提供三套工作流

`config/workflows/` 现在各有 API 与 UI 两种格式：

| 文件 | 节点 | 模型 |
|---|---|---|
| `qwen21-image-{api,ui}.json` | 7 | Qwen-Image 2.1 |
| `anima-image-{api,ui}.json` | 9 | Anima Turbo v1.1 |
| `breeze-tts-{api,ui}.json` | 6 | Breeze TTS 2 |

生成脚本 `E:\B\scripts\export_all_workflows.py`。**UI 格式供 ComfyUI 拖拽打开**，
API 格式供 `POST /prompt`。两者从同一份定义生成，否则画布上看到的和实际跑的会不一致。

Breeze 是特殊情况：它的图由 `backends/breeze.js` 代码现拼，原本没有 JSON。导出的文件
把 design / clone / direction 三个模式节点都放上，只有 design 接到保存节点——因为画布
不能让两条分支进同一个输入。打开后可自行换。

**校验时抓到的两个校验器缺陷**（`validate_ui_workflow.py`）：

1. 它按**字段名**判断是不是 link（`model`、`audio` 一律当 link），但
   `BreezeTTS2LoadModel.model` 是**下拉框 widget**，而 `KSampler.model` 才是 link。
   判断依据必须是**类型**（link 的首元素是类型名如 `"MODEL"`，widget 是选项列表或
   `"STRING"/"INT"`）。按名字判导致整份文件"少一个 widget"的假警报，我去改本来正确的代码。
2. 它只统计 `required` 里的输入，但画布也会为 `optional` 输入存 widget 值。
   Breeze 的大部分生成参数在 `optional` 里，于是每个节点都"少算"。

另外 `CLIPLoader` 的 `device` 是 optional 但画布仍存值，widget 表里必须带上。

### 第九轮：`/api/speak` 的默认资源写死

**报告**：`/api/speak` 用 `body.resource ?? 'tts'`。tts 关闭、breeze 启用时，
不指定 resource 的调用会收到一个关于 **tts** 的 409，而能说话的引擎就在同一端点后面。

**同一个问题存在于三个端点**：`/api/image ?? 'image'`、`/api/search ?? 'memory'`。
都是「调用方问的是能力，网关答的是资源 id」。

**修法**：能力路由（§6.3）。要点是**能力不等于 backend 名字**——用户建议的
`backend === 'gsv' || backend === 'comfy'` 会把 image/anima 也算成语音候选，
然后在内部失败。真正的依据是「工作流里有没有产出该输出的节点类」，
与 `/prompt` 推断模型同一份证据。

#### 实现时抓到的两个问题

**① 能力推断第一版把 breeze 算成能生图**。因为 `backend === 'comfy'` 就加 `image`，
但 breeze **没有 workflow**（它的图是代码拼的），`/api/image` 路由到它只会报
"no default workflow"。修法：`image` 能力要求**有 workflow**。
路由实测从 `image -> breeze` 纠正为 `image -> image`。

**② 我给 `/api/status` 引入了每 2 秒重复读文件**。能力推断调
`availableClasses()` → `buildWorkflow()` → **每次深拷贝整个工作流 JSON**。
而 `/api/status` 会为每个资源 × 每个能力算一遍，WebUI 每 2 秒轮询一次。
实测 `/api/status` 从 **122ms 降到 1–2ms**（加了按工作流名缓存之后）。
这是我自己加的负载，不是既有问题——但它是本轮唯一可能解释测试中那次进程消失的线索
（见下）。

#### 一次未定位的进程消失

跑回归途中网关死了一次：`cleanExit: false`、心跳停在 `GET /api/status`、
**stderr 为空且无 uncaughtException 记录**、父 `cmd.exe` 仍存活。

按已有诊断，这个组合排除了 JS 异常，指向「被外部终止或原生崩溃」。但**这次不是父进程
连坐**（父 cmd.exe 活着，node 是它的前台子进程），所以与之前那次的结论不同。

重启后 8 个测试套件全绿、网关稳定。**我没有定位到原因，也没有为了"看起来修好了"而
改动任何东西**。

它后来又发生了一次（`uptimeSec: 0`，启动约 2 秒后消失）。**两次都无法诊断，因为重启
脚本把日志覆盖了**——崩溃现场每次都恰好被下一次启动擦掉。

所以这一轮先补的是**诊断能力**，不是猜原因：

| 改动 | 为什么 |
|---|---|
| `start-gateway.ps1` 轮转日志（保留 5 次） | 崩溃的尾巴是唯一证据，覆盖等于销毁证据 |
| `starts.log` 记启动时间 | 让死亡能和时钟对上 |
| 心跳增加 `rssMiB` / `heapUsedMiB` / `externalMiB` | 单次采样看不出内存爬升，但爬升是"无异常死亡"最常见的原因 |
| `heartbeat-history.log` 逐次追加 | 崩溃后磁盘上还留着最后几行 |

**压力测试排除了一个怀疑**：每 200ms 轮询 `/api/status` 共 127 次，同时并发拉起
`memory`，网关存活、`state=starting` 正常过渡到 `ready`。所以不是 status 并发导致。

### 第十轮：进程死了，网关还认为它活着

**报告**：

```
网关账本:  breeze  state=ready  running=true  port=8188
实际端口:  8188 未监听
```

日志每 3 分钟还在刷 `breeze will be released in 180s unless used again`。调用方拿到 500，
**且无法区分「资源真的坏了」和「网关状态是旧的」**；只能手动 disable → enable 才恢复。

#### 三个独立缺陷叠在一起

**① `ensureRunning` 无条件信任 `ready`**

```js
if (state.state === 'ready' || state.state === 'busy') return;   // 从不验证
```

服务怎么死的网关都不知道——崩溃、被外部 kill、ComfyUI 自己退出，**没有任何回调**。
所以这个 `ready` 必须被验证而不是被相信。现在请求时探一次端口（本地 HTTP，1–2ms），
不通就 `forgetRunning` 然后正常拉起。

**② `/api/status` 只探测 idle 的资源**

原逻辑是 `if (state.state !== 'idle') return;`——只关心「有没有人偷偷起了服务」，
从不检查「声称活着的还活着吗」。所以面板会一直显示假状态。现在两个方向都探，
**声称 up 时用 `fresh` 绕过 2.5 秒探测缓存**（缓存会让刚死的服务继续显示"可达"）。

**③ idle 计时器在「未知」分支无限续命** ← 这就是"每 3 分钟刷新"

```js
if (busy === null) { arm(id); return; }   // 未知 → 重新计时
```

死掉的服务探测结果**恰好是 `null`**（连不上＝未知），于是每 3 分钟自我续命一次，
永远不清状态。这个分支本身是对的（未知不该停，因为可能是正在生成），
但**必须先排除"它根本不存在"**——端口不通不是未知，是证据。

修法：计时器到期时先探端口，不通就 `forgetRunning` 并**清的计时器**；
通了才进入"未知则续命"的保守分支。

#### 修复时我自己引入的回归

第一版把 `starting` 也算进「声称活着」，结果**正常启动过程中的服务被 status 轮询
重置成 idle**。日志里一眼可见：

```
[warn] breeze was recorded as starting but is not answering; resetting to idle
```

`starting` 表达的是「正在启动」，端口当然还没监听——这是**正确的观察，错误的结论**。
只有 `ready`/`busy` 才是"声称活着"。修掉后误报数为 0。

**这个回归还差点让测试假通过**：`test-stale` 断言「state 不再是 ready」，而误重置
让 state 变成 idle，测试就绿了——但它测的不是要测的东西。所以那条断言现在同时检查
`keepAliveRemainingSec === null`，确认是**清理**而不是**误判**。

#### 验证（`test-stale` 22/22）

用 `taskkill /F /T` 直接杀掉后端进程树，**不经过网关**——这正是生产中的情形：
网关是靠"发现"知道的，不是被通知的。

| 场景 | 断言 |
|---|---|
| 进程被杀后 | 端口确实关闭（真的死了，不是假死） |
| 下一次 `/api/status` | `state` 变 `idle`、`running=false`、`keepAliveRemainingSec=null` |
| 下一次请求 | **200 而不是 500**，且自动重启成功 |
| keepAlive 到期（6 秒） | **idle 计时器自己清理**，不需要任何 status 轮询 |
| 活着的服务被反复轮询 | 状态保持不变（不能每次轮询都停模型） |

### 第七轮：`elapsedSec` 恒为 null

**报告**：`/prompt` 的 history 里 `elapsedSec` 永远是 `null`。

**原因**：`comfy.runWorkflow` 返回 `{images, audio, promptId}`，**没有耗时字段**；
`comfyapi.js` 写了 `result.elapsedSec ?? null`，这个 `?? null` 把一个不存在的东西
伪装成了"暂时没有"——看起来像数据，实际永远不是。

**修的过程中又发现一个更隐蔽的问题**：补上耗时后，客户端实测 20.6 秒、网关报 7.2 秒。
差的那 13 秒正是冷启动——**而冷启动恰恰是这些字段存在的理由**。

根因是计时起点放在了 `runWorkflow` 内部（等 ComfyUI 开始干活之后），但调用方等的是
"从提交到出图"整段，其中包含网关让位腾显存、启动 ComfyUI、模型加载。起点必须放在
`/prompt` **受理**那一刻。

**第三个坑**：想让 `generateSec` 只算采样，就得知道 ComfyUI 什么时候开始执行。但实测
history 的 `status` 只有 `status_str` / `completed` / `messages`，**没有任何时间戳**。
所以改用**轮询 `/queue` 记录它不再排队的那一刻**；取不到就退回"整个等待都算生成"。

**最终三个字段**（实测冷启动）：

```
elapsedSec 20.5 s   ← 调用方实际等待（含冷启动）
generateSec 7.1 s   ← ComfyUI 真正执行
loadSec    13.4 s   ← 排队 + 模型加载 + 启服务   (客户端实测 20.6 s)
```

测试里锁了三条，防止再退化成"看起来有值"：
`elapsedSec` 是数字且为正、`generateSec + loadSec ≈ elapsedSec`、
**`elapsedSec` 与客户端自测相差 ≤3 秒**（最后这条是关键——只断言"是数字"的话，
一个恒为 7.2 的错误实现照样能通过）。