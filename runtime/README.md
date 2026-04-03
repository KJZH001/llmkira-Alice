# Alice — 电子伴侣

以 Telegram userbot 为身体、以压力场为神经系统、以 LLM 为大脑的自主实体。

## 快速开始

```bash
# 一键安装（需要 Go 1.22+ 或 Docker）
curl -fsSL https://raw.githubusercontent.com/LlmKira/Alice/main/runtime/install.sh | sh

# 创建工作目录
mkdir ~/alice && cd ~/alice

# 初始化配置
alice init
vim .env  # 填写 Telegram API ID 和 LLM API Key

# 环境诊断
alice doctor

# 启动
alice run     # 前台运行（Ctrl+C 停止）
# 或
alice start   # 后台运行
```

## 多实例

每个工作目录是一个独立的 bot 实例：

```bash
mkdir ~/bot1 && cd ~/bot1 && alice init && alice start
mkdir ~/bot2 && cd ~/bot2 && alice init && alice start  # 不同配置
```

## alice CLI

| 命令 | 作用 |
|------|------|
| `alice init` | 初始化当前目录（创建 .env 模板） |
| `alice run` | 前台运行（日志输出到 stdout） |
| `alice start` | 后台运行（日志写入 logs/） |
| `alice stop` | 停止后台进程 |
| `alice status` | 查看状态和日志位置 |
| `alice doctor` | 环境诊断 |

## 日志

```bash
# 前台运行：日志直接输出
alice run

# 后台运行：日志写入文件
alice start
tail -f logs/$(date +%Y-%m-%d).log

# 错误日志（独立文件）
tail -f alice-errors.log
```

### 日志轮转

创建 `/etc/logrotate.d/alice`：

```
/path/to/alice/logs/*.log {
    daily
    rotate 7
    compress
    missingok
}
```

## 配置 (.env)

```bash
# LLM Provider
OPENAI_API_KEY=sk-xxx
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# Telegram (从 https://my.telegram.org 获取)
TELEGRAM_API_ID=123456
TELEGRAM_API_HASH=abcdef123456
```

## 系统服务 (systemd)

`~/.config/systemd/user/alice.service`：

```ini
[Unit]
Description=Alice Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/alice
ExecStart=/usr/local/bin/alice run
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now alice
journalctl --user -u alice -f
```

## 目录结构

```
~/alice/              # 工作目录
├── .env              # 配置
├── .alice.pid        # PID 文件
├── alice.db          # 数据库
├── alice-errors.log  # 错误日志
└── logs/             # 运行日志
    └── 2026-04-02.log
```

## 依赖

| 依赖 | 用途 | 必需 |
|------|------|------|
| Go 1.22+ | 编译 skills | 安装时 |
| Node.js 22+ | 运行时 | ✅ |
| SQLite | 数据库 | ✅ |
| Docker | 容器隔离（安全执行 skills） | ✅ |

> **安全说明**：所有 skills 在 Docker 容器中隔离执行。
> Docker 是必需的，未安装时 `alice doctor` 会报错。

## 文档

- [愿景](../docs/adr/00-vision.md)
- [架构概览](../docs/adr/02-architecture-overview.md)
- [理论基础](../docs/adr/01-theoretical-foundations.md)

## License

MIT