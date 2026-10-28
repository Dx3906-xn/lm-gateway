# lm-gateway

本机所有 GPU 模型服务的统一网关：一个进程负责它们的生命周期、显存预算与对外接口。

**为什么需要它**：这台机器是一张 8 GB 笔记本显卡，桌面本身占 1.3–2 GB，而每个模型
单独就要 3–7 GB。它们**不能共存**，谁先起来谁占住卡。更糟的是显存不够时的失败方式：
ComfyUI 会把部分权重悄悄挪到内存，然后在生成中途死于一个 CPU/CUDA 张量不匹配的设备
错误——看起来像是模型坏了。所以这里做的是**准入**：按预算串行、可让位、按需释放。

---

## 快速开始

```powershell
# 启动（必须用这个脚本，见下方说明）
powershell -ExecutionPolicy Bypass -File E:\B\lm-gateway\scripts\start-gateway.ps1

# 停止（先停子服务再退出，不会遗留显存）
powershell -ExecutionPolicy Bypass -File E:\B\lm-gateway\scripts\stop-gateway.ps1
```

然后打开 **http://127.0.0.1:8790/** —— WebUI 与 API 同一个端口。

无依赖、无构建步骤：只用 Node 内置模块，`npm install` 不需要跑。

> **不要用 `Start-Process` 直接起 `node src/main.js`。** 那样发起方就是父进程，
> 它一退出网关会被连带回收，现象是「日志突然断掉、stderr 为空」——看起来像崩溃，
> 其实是被连坐。`start-gateway.ps1` 用 WMI 把网关挂到服务宿主下，与任何 shell 解耦。
> 同理不要用 `Stop-Process` 硬杀，那会遗留子服务占着显存。

---

## 端口：只有一个

**外部只需要 8790。** 后端模型端口由网关**动态分配**，不写死在配置或脚本里。

```
网关 + WebUI + 代理   http://127.0.0.1:8790      ← 唯一入口
ComfyUI / GPT-SoVITS / embed-server   端口由网关挑（运行时决定）
```

网关启动时会绑定探测找空闲端口，日志里第一行就是这个：

```
ports allocated: image=8188, anima=8188, breeze=8188, tts=8189, memory=8190
```

**同组资源强制共用一个端口**：`image`/`anima`/`breeze` 是同一个 ComfyUI 进程的三套配置，
给它们各分一个端口会让"任一时刻只有一个在跑"这个保证失效。

| 资源 | 为什么必须独占该进程 |
|---|---|
| `image` | 需要 DynamicVRAM **开启**（137s vs 638s） |
| `breeze` | 需要 DynamicVRAM **关闭**（40s vs 250s），与生图相反 |
| `anima` | 另一张工作流，文本字段叫 `text`（Qwen 叫 `prompt`） |

想知道当前是哪一个在跑，看 `/api/status` 的 `active` 字段（`running` 只表示端口有应答，
同组三个都会是 true）。

完整端口说明见 [docs/PORTS.md](docs/PORTS.md)，接口细节见 [docs/API.md](docs/API.md)。

---

## 三个开关

| 开关 | 位置 | 作用 |
|---|---|---|
| **总控** | WebUI 顶部 | 关闭 = 拒绝一切拉起 + 立即停止全部 |
| **资源开关** | 每张卡片 | 关闭 = 该资源**拒绝拉起**；切换瞬间**停止**它 |
| **保持时间** | 每张卡片 | `>0` 秒后自动释放；`0` 用完立刻释放；`-1` 常驻 |

默认没有任何东西常驻：用哪个拉哪个，用完按保持时间释放。保持时间可以在 WebUI 里随时改，
改完对**下一次释放**立即生效，不用重启网关。

---

## 调用示例

**主接口是 ComfyUI 的形状**——提交一张图，轮询拿结果。模型由网关从图里的节点类推断，
你不需要知道下面是哪个模型、占哪个端口。

```powershell
# 1. 看有什么可用（含网关分配的端口）
Invoke-RestMethod -Uri 'http://127.0.0.1:8790/models'

# 2. 看能提交哪些节点类
Invoke-RestMethod -Uri 'http://127.0.0.1:8790/object_info'

# 3. 提交一张图（中文按 UTF-8 字节发送，PowerShell 直接传会损坏）
$graph = @{
  prompt = @{
    '1' = @{ class_type='UNETLoader'; inputs=@{ unet_name='anima-turbo-v1.1.safetensors'; weight_dtype='default' } }
    '2' = @{ class_type='CLIPLoader'; inputs=@{ clip_name='qwen_3_06b_base.safetensors'; type='stable_diffusion' } }
    '3' = @{ class_type='VAELoader';  inputs=@{ vae_name='qwen_image_vae.safetensors' } }
    '4' = @{ class_type='CLIPTextEncode'; inputs=@{ clip=@('2',0); text='masterpiece, 1girl, lazy' } }
    '5' = @{ class_type='CLIPTextEncode'; inputs=@{ clip=@('2',0); text='worst quality' } }
    '6' = @{ class_type='EmptySD3LatentImage'; inputs=@{ width=512; height=512; batch_size=1 } }
    '7' = @{ class_type='KSampler'; inputs=@{ model=@('1',0); positive=@('4',0); negative=@('5',0)
             latent_image=@('6',0); seed=42; steps=8; cfg=2.5; sampler_name='euler'; scheduler='simple'; denoise=1.0 } }
    '8' = @{ class_type='VAEDecode'; inputs=@{ samples=@('7',0); vae=@('3',0) } }
  }
} | ConvertTo-Json -Depth 10
$bytes = [System.Text.Encoding]::UTF8.GetBytes($graph)
$r = Invoke-RestMethod -Uri 'http://127.0.0.1:8790/prompt' -Method POST -Body $bytes -ContentType 'application/json; charset=utf-8'
$r.prompt_id

# 4. 轮询结果
Invoke-RestMethod -Uri "http://127.0.0.1:8790/history/$($r.prompt_id)"
```

```powershell
# 探活：不碰后端，很快。看 serveable 判断"能不能用"
Invoke-RestMethod -Uri 'http://127.0.0.1:8790/health'

# 看一眼状态
node src\cli.js status
```

**旧的语义化接口仍然可用**（`/api/image`、`/api/speak`、`/api/search`），但不再是推荐入口。

**产出文件的统一形态**：`/api/image` 与 `/api/speak` 都返回

```json
"artifacts": [ { "type": "image", "filename": "qwen21_00001_.png", "path": "E:\\B\\output\\qwen21_00001_.png" } ]
```

带绝对路径，调用方不必先知道自己调的是哪个端点。`images` / `file` 作为兼容字段保留。

**`state: "idle"` 是正常的**——本网关不常驻任何模型。`/health` 的 `serveable` 才是
"这个资源现在能不能用"。

---

## 自测

```powershell
node src\cli.js smoke            # 开关语义：关闭时必须拒绝且不拉起进程（约 30s）
node src\test-injection.js       # prompt 注入点（纯逻辑，秒级）
node src\test-start.js image     # 冷启动真实拉起，长命令型（约 1 分钟）
node src\test-start.js memory    # 冷启动真实拉起，常驻型（约 30 秒）
node src\test-memory.js          # 记忆检索端到端 + encodeVersion（约 30 秒）
node src\test-prompt-delivery.js # prompt 真的进了模型？用 ComfyUI /history 复核（约 1 分钟）
node src\test-resources.js       # 共用端口/独立控制/8790 代理（约 1 分钟）
node src\test-comfyapi.js        # ComfyUI 形状接口 + 模型推断（约 2 分钟）
node src\test-crash.js           # 并发/中断/轮询压力：网关是否还活着（约 1 分钟）
node src\measure-image.js "提示词"   # 端到端生图 + 显存采样（约 3 分钟）
```

验收标准的逐条证据见 [docs/DESIGN.md](docs/DESIGN.md) §10。

---

## 排障：网关不见了怎么办

`output/logs/heartbeat.json` 是死因记录。它每 5 秒写一次（pid / 时间 / 当前操作），
**干净退出会重写为 `cleanExit: true`**。所以：

- 下次启动打印 `previous run ended without a clean shutdown (...)`
  → 上次是被外部终止的，括号里给出最后时间、停了多久、以及**最后在处理什么请求**
- 日志停在某一行、`stderr` 是 0 字节、又没有 `uncaughtException` 记录
  → 不是 JS 异常，看是不是用 `Start-Process` 起的（见上方警告）

`stop_services.ps1` 用来回收可能被遗留的子服务显存。

---

## 换模型 / 加服务

**只改配置，不改代码。**

- 换模型：改 `config/resources.json` 里该项的 `vramMiB`、`start.args`、`workflow`
- 加服务：在 `resources` 加一项。**`port` 填 `0` 让网关自己挑**，启动命令里用 `{port}` 占位
- 加工作流：把 API 格式 json 放进 `config/workflows/`，再 `POST /api/workflows/reload`

**切工作流时注意**：不同工作流的文本字段名可能不同（Qwen-Image 用 `prompt`，
Anima 用 `text`）。字段写错时 ComfyUI 会静默忽略，出图完全没用上你的提示词——
所以网关**直接报错**而不是放过。

**代码生成图的资源要声明 `classes`**：Breeze 的图是每次请求现拼的，没有 JSON 可
introspect，所以配置里显式列出它能跑的节点类，否则 `/prompt` 推断时找不到它。

### 工作流文件（可直接拖进 ComfyUI）

`config/workflows/` 里每套都有两种格式：

| 文件 | 用途 |
|---|---|
| `*-ui.json` | **拖进 ComfyUI 或 File > Open**，带画布布局 |
| `*-api.json` | 提交给 `POST /prompt`，无布局 |

三套：`qwen21-image`（7 节点）、`anima-image`（9 节点）、`breeze-tts`（6 节点，含 design/clone/direction 三种模式节点）。

重新生成：`python E:\B\scripts\export_all_workflows.py`

---

## 已知约束

- 可用显存约 6.6 GB；生图（5.5 GB）与记忆检索（1.2 GB）都放不下，任意两个大模型不能共存
- 生图需要 ComfyUI **开** DynamicVRAM（137s vs 638s），Breeze 需要**关**（40s vs 250s）
  —— 两者同组互斥，用不同启动参数
- ComfyUI 的 `cuda_graphs` 模式会让进程崩溃，Breeze 固定用 `eager`
- 冷启动：ComfyUI 约 17–70 秒，GPT-SoVITS 约 70 秒
- **后端端口是运行时决定的**：日志第一行 `ports allocated:` 才是真值；
  文档里的 8188 只是默认起点，不是保证
- **`/prompt` 靠 `class_type` 推断模型**：自造节点类的图会被 400 拒绝，这是设计
- **ComfyUI 的 `/queue` 看不到"正在执行"**：生成期间它是空的，所以网关靠**自己记的未完成
  执行**判断忙闲。这也是「生成到一半被停用」那个 bug 的根因
- **后端进程死亡没有通知**：网关会探端口发现并自愈（下一次请求自动重新拉起），
  不再需要手动 disable/enable。`/api/status` 也会即时反映
- **日志会轮转保留 5 次**（`gateway.1.out.log` …）：崩溃现场不再被重启覆盖
- **心跳带 `rssMiB` / `heapUsedMiB`**，逐次追加到 `heartbeat-history.log`：
  如果网关再次"无声消失"，先看这两个数有没有爬升

完整约束清单见 [docs/DESIGN.md](docs/DESIGN.md) §11。

---

## 许可

MIT，见 [LICENSE](LICENSE)。