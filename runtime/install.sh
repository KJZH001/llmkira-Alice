#!/bin/sh
# alice-install — Alice 一键安装
#
# 用法:
#   curl -fsSL https://raw.githubusercontent.com/LlmKira/alice/main/runtime/install.sh | sh
#
# 需要: Go 1.22+ 或 Docker（二选一）
#
# 安装位置:
#   /usr/local/bin/alice          # CLI
#   /usr/local/bin/hitokoto, ...  # skills
#   /usr/local/lib/alice/runtime/ # 运行时代码
#
# 工作目录（用户创建）:
#   ~/alice/.env      # 配置
#   ~/alice/logs/     # 日志
#   ~/alice/alice.db  # 数据库

set -e

# ── 配置 ───────────────────────────────────────────────────────────

REPO="LlmKira/alice"
BRANCH="main"
PREFIX="${ALICE_PREFIX:-/usr/local}"
WORKDIR="${TMPDIR:-/tmp}/alice-build-$$"

# ── 颜色 ───────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { printf "$GREEN▶$NC %s\n" "$1"; }
warn()  { printf "$YELLOW⚠$NC %s\n" "$1"; }
fail()  { printf "$RED✗$NC %s\n" "$1"; exit 1; }
step()  { printf "$BLUE▪$NC %s\n" "$1"; }

# ── 清理 ───────────────────────────────────────────────────────────

cleanup() {
    [ -d "$WORKDIR" ] && rm -rf "$WORKDIR"
}
trap cleanup EXIT

# ── 检查依赖 ───────────────────────────────────────────────────────

info "检查编译依赖..."

BUILD_METHOD=""

if command -v go >/dev/null 2>&1; then
    GO_VERSION=$(go version 2>/dev/null | grep -oE 'go[0-9]+\.[0-9]+' | head -1)
    MAJOR=$(echo "$GO_VERSION" | cut -d. -f1 | tr -d 'go')
    MINOR=$(echo "$GO_VERSION" | cut -d. -f2)

    if [ "$MAJOR" -gt 1 ] || { [ "$MAJOR" -eq 1 ] && [ "$MINOR" -ge 22 ]; }; then
        info "使用 Go $GO_VERSION"
        BUILD_METHOD="go"
    else
        warn "Go 版本过低 ($GO_VERSION)，需要 1.22+"
    fi
fi

if [ -z "$BUILD_METHOD" ] && command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
        warn "使用 Docker 编译（未检测到 Go 1.22+）"
        BUILD_METHOD="docker"
    fi
fi

if [ -z "$BUILD_METHOD" ]; then
    fail "需要 Go 1.22+ 或 Docker

安装方法:
  Go: curl -fsSL https://go.dev/dl/go1.22.linux-amd64.tar.gz | sudo tar -C /usr/local -xzf -
      export PATH=\$PATH:/usr/local/go/bin

  Docker: https://docs.docker.com/get-docker/"
fi

# ── 克隆仓库 ───────────────────────────────────────────────────────

info "克隆仓库..."
mkdir -p "$WORKDIR"

if command -v git >/dev/null 2>&1; then
    step "git clone --depth 1 https://github.com/$REPO"
    git clone --depth 1 --branch "$BRANCH" "https://github.com/$REPO" "$WORKDIR/alice" 2>&1 | while read line; do step "$line"; done
else
    step "下载压缩包..."
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" | tar -xzf - -C "$WORKDIR"
    mv "$WORKDIR/alice-$BRANCH" "$WORKDIR/alice"
fi

cd "$WORKDIR/alice/runtime"

# ── 编译 ────────────────────────────────────────────────────────────

info "编译..."

case "$BUILD_METHOD" in
    go)
        step "使用本地 Go"
        mkdir -p dist/bin

        step "编译 alice CLI"
        CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/alice ./cmd/alice

        for skill in cmd/skills/*/; do
            name=$(basename "$skill")
            step "编译 $name"
            CGO_ENABLED=0 go build -ldflags="-s -w" -o "dist/bin/$name" "./$skill"
        done
        ;;

    docker)
        step "使用 Docker"
        mkdir -p dist/bin

        docker run --rm \
            -v "$(pwd):/workspace" \
            -w /workspace \
            --network host \
            golang:1.22-alpine \
            sh -c '
                apk add --no-cache git ca-certificates
                mkdir -p dist/bin
                CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/alice ./cmd/alice
                for skill in cmd/skills/*/; do
                    name=$(basename $skill)
                    CGO_ENABLED=0 go build -ldflags="-s -w" -o dist/bin/$name ./$skill
                done
            '
        ;;
esac

COUNT=$(ls dist/bin/ | wc -l)
info "编译完成: $COUNT 个二进制"

# ── 安装 ────────────────────────────────────────────────────────────

info "安装到 $PREFIX ..."

# 安装二进制
sudo mkdir -p "$PREFIX/bin"
for bin in dist/bin/*; do
    name=$(basename "$bin")
    step "安装 $name"
    sudo install -m 755 "$bin" "$PREFIX/bin/$name"
done

# 安装运行时代码
info "安装运行时代码..."
sudo mkdir -p "$PREFIX/lib/alice/runtime"

# 复制必要的运行时文件
for item in src package.json bun.lock tsconfig.json drizzle.config.ts skills; do
    step "复制 $item"
    sudo cp -r "$item" "$PREFIX/lib/alice/runtime/"
done

# 安装依赖
info "安装运行时依赖..."
cd "$PREFIX/lib/alice/runtime"
if command -v bun >/dev/null 2>&1; then
    sudo bun install --frozen-lockfile 2>/dev/null || sudo bun install
else
    sudo npm install --omit=dev 2>/dev/null || sudo npm install
fi

# ── 构建 Docker 镜像 ─────────────────────────────────────────────────

info "构建 Docker 镜像（skill 隔离执行环境）..."
cd "$WORKDIR/alice/runtime"

if ! docker image inspect alice-skill-runner:bookworm >/dev/null 2>&1; then
    step "构建 alice-skill-runner:bookworm"
    docker build -t alice-skill-runner:bookworm -f Dockerfile.skill-runner . 2>&1 | while read line; do step "$line"; done
else
    step "镜像已存在，跳过构建"
fi

# ── 运行时依赖检查 ─────────────────────────────────────────────────

echo ""
warn "运行时依赖:"

MISSING=""
if ! command -v node >/dev/null 2>&1; then
    MISSING="$MISSING node"
    warn "  Node.js 未安装"
fi

if ! command -v docker >/dev/null 2>&1; then
    MISSING="$MISSING docker"
    warn "  Docker 未安装（skill 安全执行必需）"
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
    MISSING="$MISSING sqlite3"
    warn "  SQLite 未安装"
fi

# ── 完成 ────────────────────────────────────────────────────────────

echo ""
if [ -n "$MISSING" ]; then
    fail "缺少必需依赖:$MISSING

安装方法:
  Node.js: https://nodejs.org/
  Docker: https://docs.docker.com/get-docker/
  SQLite: sudo apt install sqlite3 (Debian) 或 sudo pacman -S sqlite (Arch)"
fi

info "✅ 安装完成!"
echo ""
echo "下一步:"
echo "  1. 创建工作目录: mkdir -p ~/alice && cd ~/alice"
echo "  2. 初始化配置: alice init"
echo "  3. 编辑配置: vim .env"
echo "  4. 环境诊断: alice doctor"
echo "  5. 启动服务: alice run"
echo ""
echo "多实例:"
echo "  mkdir ~/bot2 && cd ~/bot2 && alice init && alice run"
echo ""