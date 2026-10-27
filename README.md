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

## 端口

| 用途 | 端口 |
|---|---|
| **网关（API + WebUI + 后端代理）** | **8790** |
| ComfyUI（`image` / `anima` / `breeze` 三者互斥） | 8188 |
| GPT-SoVITS（`tts`） | 9880 |
| embed-server 记忆检索（`memory`） | 9820 |

**调用方只需要 8790。** 后端端口由网关代管：

```
网关接口      http://127.0.0.1:8790/api/...
WebUI         http://127.0.0.1:8790/
后端原生接口  http://127.0.0.1:8790/backends/<id>/<path>
```

`active` 常驻。完整端口表与 curl 示例见 [docs/PORTS.md](docs/PORTS.md)，接口细节见 [docs/API.md](docs/API.md)。

### 为什么 8188 上有三个资源

`image`（Qwen-Image）、`anima`（Anima Turbo）、`breeze`（Breeze TTS 2）**共用 8188 且互斥**。
一个端口只能有一个监听者，所以任一时刻只有一个能跑——它们其实是同一个 ComfyUI 进程的三套配置：

| 资源 | 为什么必须独占 |
|---|---|
| `image` | 需要 DynamicVRAM **开启**（137s vs 638s） |
| `breeze` | 需要 DynamicVRAM **关闭**（40s vs 250s），与生图相反 |
| `anima` | 另一张工作流，文本字段叫 `text`（Qwen 叫 `prompt`） |

WebUI 上会显示成 `8188（3 个共用）`。**这不是配置错误**，是互斥声明。
想知道当前是哪一个在跑，看 `/api/status` 的 `active` 字段（`running` 只表示端口有应答，
同组三个都会是 true）。

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

```powershell
# 探活：不碰后端，很快。看 serveable 判断"能不能用"
Invoke-RestMethod -Uri 'http://127.0.0.1:8790/health'
```

```powershell
# 后端原生接口也不需要直连端口（例：查 ComfyUI 节点定义）
Invoke-RestMethod -Uri 'http://127.0.0.1:8790/backends/anima/object_info/KSampler'
```

```powershell
# 生图（中文正文按 UTF-8 字节发送，PowerShell 直接传中文会损坏）
$body = [System.Text.Encoding]::UTF8.GetBytes('{"prompt":"生成一张漫画风格的慵懒少女"}')
Invoke-WebRequest -Uri 'http://127.0.0.1:8790/api/image' -Method POST `
  -Body $body -ContentType 'application/json; charset=utf-8'
```

```powershell
# 看一眼状态
node src\cli.js status
```

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
- 加服务：在 `resources` 加一项
- 加工作流：把 API 格式 json 放进 `config/workflows/`，再 `POST /api/workflows/reload`

**切工作流时注意**：不同工作流的文本字段名可能不同（Qwen-Image 用 `prompt`，
Anima 用 `text`）。字段写错时 ComfyUI 会静默忽略，出图完全没用上你的提示词——
所以网关**直接报错**而不是放过。新工作流要确认 `inject`，必要时加 `injectByWorkflow`。

---

## 已知约束

- 可用显存约 6.6 GB；生图（5.5 GB）与记忆检索（1.2 GB）都放不下，任意两个大模型不能共存
- 生图需要 ComfyUI **开** DynamicVRAM（137s vs 638s），Breeze 需要**关**（40s vs 250s）
  —— 两者共用 8188，因此互斥且用不同启动参数
- ComfyUI 的 `cuda_graphs` 模式会让进程崩溃，Breeze 固定用 `eager`
- 冷启动：ComfyUI 约 17–70 秒，GPT-SoVITS 约 70 秒

完整约束清单见 [docs/DESIGN.md](docs/DESIGN.md) §11。

---

## 许可

MIT，见 [LICENSE](LICENSE)。