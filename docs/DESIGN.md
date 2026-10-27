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

**已占用，不得使用**：1234 LM Studio、3001 QQ、3080 DSH GUI、3081 DSH node、
8188 ComfyUI、9820 embed-server、9880 GPT-SoVITS。

| 用途 | 端口 | 说明 |
|---|---|---|
| **网关 HTTP（API + WebUI）** | **8790** | 唯一对外入口 |
| ComfyUI（生图 / Breeze） | 8188 | 由网关代管 |
| GPT-SoVITS | 9880 | 由网关代管 |
| embed-server 记忆检索 | 9820 | 由网关代管 |

所有调用方只认 **8790**。后端端口是内部实现细节。

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
      "inject": { "prompt": { "node": "4", "field": "prompt" } },
      "injectByWorkflow": {
        "anima-image.json": { "prompt": { "node": "4", "field": "text" } }
      }
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
| `injectByWorkflow` | 可选 | 按工作流覆盖注入点，**换工作流必查**（见下） |
| `outputDir` | 可选 | 产物落盘目录。给 `comfy` 后端填 ComfyUI 的 output 目录（`E:\B\output`），用于把裸文件名拼成绝对路径 |

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
| GPT-SoVITS v2ProPlus | 3060 MiB | ~0 | ~3000 MiB |
| embed-server | ~1200 MiB | — | ~1200 MiB |

配置取 `5500` / `5400`：略高于实测增量，既能在真正紧张时拒绝，又不会因为几 MiB
的浮动误拒（实测过 `6500` 配 `headroom 300` 时差 8 MiB 就拒绝的窘境）。

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

### 状态与控制

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | **`/health`** | **探活，不碰后端**。返回 `{ok, master, uptimeSec, resources{id:{enabled,state,serveable}}}`。`serveable` = 总控开且该资源 enabled，调用它不会被 409 拒绝。**注意 `state:"idle"` 是正常状态**——本网关不常驻任何模型 |
| `GET` | `/api/heartbeat` | 当前进程存活状态（`pid/at/activity/lastError/uptimeSec`） |
| `POST` | `/api/shutdown` | 优雅停止：先停全部子服务再退出。`scripts/stop-gateway.ps1` 用它 |
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

**`POST /api/image`**

```jsonc
{
  "prompt": "生成一张漫画风格的慵懒少女",
  "resource": "image",              // 可选，默认 image
  "workflow": "qwen21-image.json",   // 可选，默认取资源配置
  "override": { "5": { "seed": 123 } },  // 可选，按节点 id 覆盖
  "timeoutSec": 900
}
```

响应：

```jsonc
{
  "ok": true,
  "workflow": "qwen21-image.json",
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

**`POST /api/speak`**

GSV（`resource: "tts"`）**必须给 `refAudioPath`**（每次从参考音频克隆，没有默认值）
与 `promptText`（参考音频的准确文字）：

```jsonc
{ "resource": "tts", "text": "老大 我今天不想动",
  "refAudioPath": "E:\\B\\voices\\ref-1.wav",
  "promptText": "我之前听泰国歌曲好倒掉然后跟人家接" }
```
响应：`{ok, backend:"gsv", file, bytes, elapsedSec}`

Breeze（`resource: "breeze"`）要 `mode`，并按模式给参数：

```jsonc
{ "resource": "breeze", "mode": "design",
  "text": "老大 我今天不想动", "instruction": "一位温柔自信的年轻女性…" }
```
`clone` / `direction` 额外需要 `reference`（ComfyUI input 目录里的文件名）与
`referenceText`。响应：`{ok, backend:"comfy", mode, promptId, audio:[...], elapsedSec}`

**`POST /api/search`**

两种用法，二选一：

```jsonc
{ "texts": ["文本一", "文本二"] }                         // → {ok, vectors, dim}
{ "query": "查询", "candidates": ["候选1","候选2"], "topK": 5 }  // → {ok, ranked:[{index,score,text}]}
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

---

## 7. 调度规则

1. **串行化**：同一时刻只有一个资源在"启动中"，避免并发启动竞争。
2. **优先级**：`tts(10) > memory(20) > breeze(30) > image(40) > video(50)`。
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
| 8 | 注入点不静默失效 | `test-injection` 13/13：anima 用 `text`、qwen21 用 `prompt`，写错字段被拒 |
| 9 | 常驻服务（memory）能拉起并能停下 | `test-start memory` 10/10：冷启动 **10.9s**（修复前 120s 超时并杀掉健康进程） |
| 10 | 记忆检索端到端可用 | `test-memory` 16/16：`encodeVersion="2-maskpool"`、中文向量可区分、排序正确、stop 释放端口 |

复跑：

```powershell
node src\cli.js smoke            # 开关语义（约 30s，会真的停一次服务）
node src\test-injection.js       # 注入点（纯逻辑，秒级）
node src\test-start.js image     # 冷启动，长命令型（约 1 分钟）
node src\test-start.js memory    # 冷启动，常驻型（约 30 秒）
node src\test-memory.js          # 记忆检索端到端（约 30 秒）
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
  → 两者共用 8188，必须互斥且用不同启动参数
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