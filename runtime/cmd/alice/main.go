// alice — Alice 运行时管理 CLI
//
// 用法:
//   alice init     # 初始化当前目录
//   alice run      # 前台运行
//   alice start    # 后台运行
//   alice stop     # 停止
//   alice status   # 查看状态
//   alice doctor   # 环境诊断
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"
)

var version = "1.0.0"

const pidFile = ".alice.pid"
const envFile = ".env"

func main() {
	if len(os.Args) < 2 {
		printUsage()
		os.Exit(1)
	}

	cmd := os.Args[1]
	switch cmd {
	case "init":
		initDir()
	case "run":
		run(false)
	case "start":
		run(true)
	case "stop":
		stop()
	case "status":
		status()
	case "doctor":
		doctor()
	case "version":
		fmt.Printf("alice v%s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	case "help", "-h", "--help":
		printUsage()
	default:
		fmt.Fprintf(os.Stderr, "Unknown command: %s\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Println(`Alice — 电子伴侣运行时管理

用法:
  alice <command>

命令:
  init      初始化当前目录
  run       前台运行（日志输出到 stdout）
  start     后台运行（日志写入 logs/YYYY-MM-DD.log）
  stop      停止
  status    查看状态和日志位置
  doctor    环境诊断
  version   显示版本
  help      显示帮助

日志:
  前台: alice run                    # 输出到 stdout
  后台: alice start                  # 写入 logs/
  查看: tail -f logs/$(date +%F).log

多实例:
  cp -r ~/alice ~/bot2 && cd ~/bot2 && alice run`)
}

func initDir() {
	// 创建 .env 模板
	if _, err := os.Stat(envFile); os.IsNotExist(err) {
		content := `# Alice 配置文件

# LLM Provider
OPENAI_API_KEY=your-api-key-here
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-4o

# Telegram (从 https://my.telegram.org 获取)
TELEGRAM_API_ID=your-api-id
TELEGRAM_API_HASH=your-api-hash
`
		if err := os.WriteFile(envFile, []byte(content), 0644); err != nil {
			fmt.Fprintf(os.Stderr, "❌ 创建 .env 失败: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("✅ 已创建 .env 模板，请编辑配置")
	} else {
		fmt.Println("⚠️  .env 已存在")
	}

	// 创建数据目录
	for _, dir := range []string{"logs", "skills/store"} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			fmt.Fprintf(os.Stderr, "❌ 创建目录失败: %v\n", err)
			os.Exit(1)
		}
	}
	fmt.Println("✅ 已创建数据目录")
}

func run(daemon bool) {
	// 检查 .env
	if _, err := os.Stat(envFile); os.IsNotExist(err) {
		fmt.Fprintln(os.Stderr, "❌ 缺少 .env 配置文件，运行 alice init")
		os.Exit(1)
	}

	// 检查是否已在运行
	if isRunning() {
		fmt.Fprintln(os.Stderr, "⚠️  Alice 已在运行，使用 alice stop 先停止")
		os.Exit(1)
	}

	// 查找 runtime 目录
	runtimeDir := findRuntimeDir()
	if runtimeDir == "" {
		fmt.Fprintln(os.Stderr, "❌ 找不到 runtime 目录")
		fmt.Fprintln(os.Stderr, "   请在包含 src/index.ts 的目录运行，或设置 ALICE_RUNTIME_DIR")
		os.Exit(1)
	}

	// 创建日志目录
	os.MkdirAll("logs", 0755)

	// 检测运行时（优先 Node.js，因为 better-sqlite3 兼容性）
	var cmd *exec.Cmd
	if hasCommand("npx") {
		cmd = exec.Command("npx", "tsx", filepath.Join(runtimeDir, "src/index.ts"))
	} else if hasCommand("bun") {
		// Bun 有 better-sqlite3 兼容问题，提示用户
		fmt.Fprintln(os.Stderr, "⚠️  使用 Bun 运行，但 better-sqlite3 可能不兼容")
		fmt.Fprintln(os.Stderr, "   推荐安装 Node.js: curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs")
		cmd = exec.Command("bun", filepath.Join(runtimeDir, "src/index.ts"))
	} else {
		fmt.Fprintln(os.Stderr, "❌ 需要 Node.js 或 Bun")
		os.Exit(1)
	}

	// 设置环境
	cmd.Env = append(os.Environ(), "ALICE_WORKDIR="+absPath("."))

	if daemon {
		// 后台运行 — 日志写入文件
		logFile := filepath.Join("logs", time.Now().Format("2006-01-02")+".log")
		logF, err := os.OpenFile(logFile, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0644)
		if err != nil {
			fmt.Fprintf(os.Stderr, "❌ 创建日志文件失败: %v\n", err)
			os.Exit(1)
		}

		cmd.Stdin = nil
		cmd.Stdout = logF
		cmd.Stderr = logF
		cmd.SysProcAttr = &syscall.SysProcAttr{
			Setsid: true,
		}

		if err := cmd.Start(); err != nil {
			logF.Close()
			fmt.Fprintf(os.Stderr, "❌ 启动失败: %v\n", err)
			os.Exit(1)
		}

		// 写 pid 文件
		pid := cmd.Process.Pid
		writePidFile(pid, logFile)
		fmt.Printf("✅ Alice 已启动 (pid: %d)\n", pid)
		fmt.Printf("   日志: %s\n", logFile)
		fmt.Println("   停止: alice stop")
		fmt.Println("   查看日志: tail -f logs/$(date +%Y-%m-%d).log")
	} else {
		// 前台运行 — 日志输出到 stdout/stderr
		cmd.Stdin = os.Stdin
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr

		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		go func() {
			<-sigChan
			cmd.Process.Signal(syscall.SIGTERM)
		}()

		if err := cmd.Run(); err != nil {
			fmt.Fprintf(os.Stderr, "❌ 运行失败: %v\n", err)
			os.Exit(1)
		}
	}
}

func stop() {
	pid, err := readPidFile()
	if err != nil {
		fmt.Fprintln(os.Stderr, "⚠️  Alice 未运行")
		return
	}

	process, err := os.FindProcess(pid)
	if err != nil {
		fmt.Fprintln(os.Stderr, "⚠️  进程不存在")
		os.Remove(pidFile)
		return
	}

	if err := process.Signal(syscall.SIGTERM); err != nil {
		fmt.Fprintf(os.Stderr, "❌ 停止失败: %v\n", err)
		os.Exit(1)
	}

	// 等待进程结束
	for i := 0; i < 10; i++ {
		if !isProcessRunning(pid) {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}

	os.Remove(pidFile)
	fmt.Println("✅ Alice 已停止")
}

func status() {
	data, err := readPidData()
	if err != nil {
		fmt.Println("状态: 未运行")
		return
	}

	pid := int(data["pid"].(float64))
	if isProcessRunning(pid) {
		fmt.Printf("状态: 运行中 (pid: %d)\n", pid)
		if workdir, ok := data["workdir"].(string); ok {
			fmt.Printf("工作目录: %s\n", workdir)
		}
		if logFile, ok := data["logFile"].(string); ok {
			fmt.Printf("日志文件: %s\n", logFile)
			fmt.Printf("查看日志: tail -f %s\n", logFile)
		}
	} else {
		fmt.Println("状态: 已停止（残留 pid 文件）")
		os.Remove(pidFile)
	}
}

func doctor() {
	fmt.Println("🔍 Alice 环境诊断")
	fmt.Println()

	ok := true

	// Go 版本
	fmt.Print("  Go 版本: ")
	if hasCommand("go") {
		out, _ := exec.Command("go", "version").Output()
		fmt.Printf("✅ %s\n", strings.Fields(string(out))[2])
	} else {
		fmt.Println("⚠️  未安装 (可选，用于编译)")
	}

	// Bun
	fmt.Print("  Bun: ")
	if hasCommand("bun") {
		out, _ := exec.Command("bun", "--version").Output()
		fmt.Printf("✅ %s\n", strings.TrimSpace(string(out)))
	} else {
		fmt.Println("⚠️  未安装，推荐: curl -fsSL https://bun.sh/install | bash")
	}

	// Node.js
	fmt.Print("  Node.js: ")
	if hasCommand("node") {
		out, _ := exec.Command("node", "--version").Output()
		fmt.Printf("✅ %s\n", strings.TrimSpace(string(out)))
	} else {
		fmt.Println("❌ 未安装")
		ok = false
	}

	// Docker
	fmt.Print("  Docker: ")
	if hasCommand("docker") {
		if out, err := exec.Command("docker", "version", "--format", "{{.Server.Version}}").Output(); err == nil {
			fmt.Printf("✅ %s\n", strings.TrimSpace(string(out)))
		} else {
			fmt.Println("❌ 已安装但未运行")
			ok = false
		}
	} else {
		fmt.Println("❌ 未安装（skill 执行必需）")
		ok = false
	}

	// SQLite
	fmt.Print("  SQLite: ")
	if hasCommand("sqlite3") {
		out, _ := exec.Command("sqlite3", "--version").Output()
		fmt.Printf("✅ %s\n", strings.Fields(string(out))[0])
	} else {
		fmt.Println("❌ 未安装")
		ok = false
	}

	// Skills
	fmt.Print("  Skills: ")
	if skillDir := findSkillDir(); skillDir != "" {
		files, _ := os.ReadDir(skillDir)
		fmt.Printf("✅ %d 个\n", len(files))
	} else {
		fmt.Println("⚠️  未找到")
	}

	// 配置文件
	fmt.Print("  配置: ")
	if _, err := os.Stat(envFile); err == nil {
		fmt.Println("✅ .env 存在")
	} else {
		fmt.Println("⚠️  .env 不存在，运行 alice init")
	}

	fmt.Println()
	if ok {
		fmt.Println("✅ 环境检查通过")
	} else {
		fmt.Println("❌ 环境不完整，请安装缺失的依赖")
	}
}

// ── 辅助函数 ───────────────────────────────────────────────────────

func hasCommand(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

func absPath(path string) string {
	abs, _ := filepath.Abs(path)
	return abs
}

func findRuntimeDir() string {
	// 1. 环境变量
	if dir := os.Getenv("ALICE_RUNTIME_DIR"); dir != "" {
		if _, err := os.Stat(filepath.Join(dir, "src/index.ts")); err == nil {
			return dir
		}
	}

	// 2. 全局安装位置
	globalDirs := []string{
		"/usr/local/lib/alice/runtime",
		"/usr/lib/alice/runtime",
	}
	for _, dir := range globalDirs {
		if _, err := os.Stat(filepath.Join(dir, "src/index.ts")); err == nil {
			return dir
		}
	}

	// 3. 当前目录
	if _, err := os.Stat("src/index.ts"); err == nil {
		return "."
	}
	// 4. runtime 子目录
	if _, err := os.Stat("runtime/src/index.ts"); err == nil {
		return "runtime"
	}
	// 5. 父目录
	if _, err := os.Stat("../src/index.ts"); err == nil {
		return ".."
	}

	return ""
}

func findSkillDir() string {
	candidates := []string{"dist/bin", "skills/store", "/usr/local/lib/alice/skills"}
	for _, dir := range candidates {
		if _, err := os.Stat(dir); err == nil {
			return dir
		}
	}
	return ""
}

func writePidFile(pid int, logFile string) {
	data := map[string]any{
		"pid":       pid,
		"startedAt": time.Now().Format(time.RFC3339),
		"workdir":   absPath("."),
		"logFile":   logFile,
	}
	bytes, _ := json.Marshal(data)
	os.WriteFile(pidFile, bytes, 0644)
}

func readPidData() (map[string]any, error) {
	data, err := os.ReadFile(pidFile)
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return m, nil
}

func readPidFile() (int, error) {
	m, err := readPidData()
	if err != nil {
		return 0, err
	}
	pid := int(m["pid"].(float64))
	return pid, nil
}

func isRunning() bool {
	pid, err := readPidFile()
	if err != nil {
		return false
	}
	return isProcessRunning(pid)
}

func isProcessRunning(pid int) bool {
	process, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	return process.Signal(syscall.Signal(0)) == nil
}