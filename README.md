# lm-gateway

本机所有 GPU 模型服务的统一网关：一个进程负责它们的生命周期、显存预算与对外接口。

**为什么需要它**：这台机器是一张 8 GB 笔记本显卡，桌面本身占 1.3–2 GB，而每个模型
单独就要 3–7 GB。它们**不能共存**，谁先起来谁占住卡。更糟的是显存不够时的失败方式：
ComfyUI 会把部分权重悄悄挪到内存，然后在生成中途死于一个 CPU/CUDA 张量不匹配的设备
错误——看起来像是模型坏了。所以这里做的是**准入**：按预算串行、可让位、按需释放。

---

## 快速开始

```powershell
cd E:\B\lm-gateway
node src\main.js
```

然后打开 **http://127.0.0.1:8790/** —— WebUI 与 API 同一个端口。

无依赖、无构建步骤：只用 Node 内置模块，`npm install` 不需要跑。

---

## 端口

| 用途 | 端口 |
|---|---|
| **网关（API + WebUI）** | **8790** |
| ComfyUI（生图 / Breeze） | 8188 |
| GPT-SoVITS | 9880 |
| embed-server 记忆检索 | 9820 |

**调用方只认 8790。** 后端端口由网关代管，不要直连。
完整端口表与 curl 示例见 [docs/PORTS.md](docs/PORTS.md)，接口细节见 [docs/API.md](docs/API.md)。

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
# 生图（中文正文按 UTF-8 字节发送，PowerShell 直接传中文会损坏）
$body = [System.Text.Encoding]::UTF8.GetBytes('{"prompt":"生成一张漫画风格的慵懒少女"}')
Invoke-WebRequest -Uri 'http://127.0.0.1:8790/api/image' -Method POST `
  -Body $body -ContentType 'application/json; charset=utf-8'
```

```powershell
# 看一眼状态
node src\cli.js status
```

---

## 自测

```powershell
node src\cli.js smoke            # 开关语义：关闭时必须拒绝且不拉起进程（约 30s）
node src\test-injection.js       # prompt 注入点（纯逻辑，秒级）
node src\test-start.js image     # 冷启动真实拉起，长命令型（约 1 分钟）
node src\test-start.js memory    # 冷启动真实拉起，常驻型（约 30 秒）
node src\test-memory.js          # 记忆检索端到端 + encodeVersion（约 30 秒）
node src\measure-image.js "提示词"   # 端到端生图 + 显存采样（约 3 分钟）
```

验收标准的逐条证据见 [docs/DESIGN.md](docs/DESIGN.md) §10。

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