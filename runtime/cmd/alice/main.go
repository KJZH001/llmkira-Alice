// alice — Alice 运行时管理 CLI
//
// 用法:
//
//	alice init     # 初始化当前目录
//	alice run      # 前台运行
//	alice start    # 后台运行
//	alice stop     # 停止
//	alice status   # 查看状态
//	alice doctor   # 环境诊断
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "1.0.0"

const pidFile = ".alice.pid"
const envFile = ".env"
const requiredNodeMajor = 22

const defaultEnvTemplate = `# Alice 配置文件

# Telegram（从 https://my.telegram.org/apps 获取）
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_PHONE=

# LLM（OpenAI-compatible）
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=
LLM_MODEL=gpt-4o
`

var requiredSystemBinaries = []string{"irc", "self", "alice-pkg"}

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
	_, _ = os.Stdout.WriteString(`Alice — 电子伴侣运行时管理

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
  cp -r ~/alice ~/bot2 && cd ~/bot2 && alice run
`)
}

func initDir() {
	// 创建 .env 模板
	if _, err := os.Stat(envFile); os.IsNotExist(err) {
		content, err := readEnvTemplate()
		if err != nil {
			fmt.Fprintf(os.Stderr, "❌ 读取 .env 模板失败: %v\n", err)
			os.Exit(1)
		}
		if err := os.WriteFile(envFile, content, 0644); err != nil {
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
	envVars, err := loadEnvFile(envFile)
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ 读取 .env 失败: %v\n", err)
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
	systemBinDir := findSystemBinDir(runtimeDir)
	if missing := findMissingSystemBinaries(systemBinDir); len(missing) > 0 {
		fmt.Fprintf(os.Stderr, "❌ 缺少 Alice system-bin：%s\n", strings.Join(missing, ", "))
		fmt.Fprintf(os.Stderr, "   预期目录: %s\n", absPath(systemBinDir))
		fmt.Fprintln(os.Stderr, "   请先执行 `pnpm run build:bin`，或重新运行安装脚本")
		os.Exit(1)
	}

	// 创建日志目录
	os.MkdirAll("logs", 0755)

	// 检测运行时（优先项目内 tsx，其次 pnpm exec，避免通过 npx 临时下载）
	cmd, warning, err := newRuntimeCommand(runtimeDir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "❌ %v\n", err)
		os.Exit(1)
	}
	if warning != "" {
		fmt.Fprintln(os.Stderr, warning)
	}

	// 设置环境
	cmd.Env = appendEnvVars(os.Environ(), envVars)
	cmd.Env = setEnvValue(cmd.Env, "ALICE_WORKDIR", absPath("."))

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
		_, _ = os.Stdout.WriteString("   查看日志: tail -f logs/$(date +%Y-%m-%d).log\n")
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
	runtimeDir := findRuntimeDir()

	// Go 版本
	fmt.Print("  Go 版本: ")
	if hasCommand("go") {
		out, _ := exec.Command("go", "version").Output()
		fmt.Printf("✅ %s\n", strings.Fields(string(out))[2])
	} else {
		fmt.Println("⚠️  未安装 (可选，用于编译)")
	}

	// Node.js
	fmt.Print("  Node.js: ")
	if hasCommand("node") {
		out, _ := exec.Command("node", "--version").Output()
		version := strings.TrimSpace(string(out))
		major, err := parseNodeMajor(version)
		switch {
		case err != nil:
			fmt.Printf("⚠️  %s（无法解析版本）\n", version)
			ok = false
		case major < requiredNodeMajor:
			fmt.Printf("❌ %s（需要 v%d+）\n", version, requiredNodeMajor)
			ok = false
		default:
			fmt.Printf("✅ %s\n", version)
		}
	} else {
		fmt.Println("❌ 未安装")
		ok = false
	}

	// Runtime
	fmt.Print("  Runtime: ")
	if runtimeDir != "" {
		fmt.Printf("✅ %s\n", absPath(runtimeDir))
	} else {
		fmt.Println("❌ 未找到 runtime 目录")
		ok = false
	}

	// System bin
	fmt.Print("  System bin: ")
	if runtimeDir == "" {
		fmt.Println("⚠️  跳过（未定位 runtime）")
	} else {
		systemBinDir := findSystemBinDir(runtimeDir)
		if missing := findMissingSystemBinaries(systemBinDir); len(missing) > 0 {
			fmt.Printf("❌ %s（缺少 %s）\n", absPath(systemBinDir), strings.Join(missing, ", "))
			ok = false
		} else {
			fmt.Printf("✅ %s\n", absPath(systemBinDir))
		}
	}

	// tsx
	fmt.Print("  tsx: ")
	if runtimeDir == "" {
		fmt.Println("⚠️  跳过（未定位 runtime）")
	} else if tsx := findTsxBinary(runtimeDir); tsx != "" {
		fmt.Printf("✅ %s\n", tsx)
	} else if hasCommand("pnpm") {
		fmt.Println("⚠️  未找到本地 tsx，将回退到 pnpm exec tsx")
		ok = false
	} else {
		fmt.Println("❌ 未找到 tsx 运行器")
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

	// better-sqlite3 / mtcute
	fmt.Print("  Native modules: ")
	if runtimeDir == "" || !hasCommand("node") {
		fmt.Println("⚠️  跳过（缺少 runtime 或 Node.js）")
	} else if err := checkNodeRuntime(runtimeDir); err != nil {
		fmt.Printf("❌ %s\n", err)
		ok = false
	} else {
		fmt.Println("✅ better-sqlite3 + @mtcute/node")
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
		envVars, err := loadEnvFile(envFile)
		fmt.Print("  配置项: ")
		if err != nil {
			fmt.Printf("❌ %v\n", err)
			ok = false
		} else {
			check := validateEnvFile(envVars)
			switch {
			case len(check.Missing) > 0 || len(check.Invalid) > 0:
				parts := make([]string, 0, len(check.Missing)+len(check.Invalid))
				if len(check.Missing) > 0 {
					parts = append(parts, "缺少 "+strings.Join(check.Missing, ", "))
				}
				if len(check.Invalid) > 0 {
					parts = append(parts, "非法 "+strings.Join(check.Invalid, ", "))
				}
				fmt.Printf("❌ %s\n", strings.Join(parts, "；"))
				ok = false
			default:
				fmt.Println("✅ 关键字段齐全")
			}
			if len(check.LegacyOnly) > 0 {
				fmt.Print("  旧字段: ")
				fmt.Printf("❌ 检测到 %s；Alice 现在只读取 LLM_*\n", strings.Join(check.LegacyOnly, ", "))
				ok = false
			} else if len(check.LegacySeen) > 0 {
				fmt.Print("  旧字段: ")
				fmt.Printf("⚠️  检测到 %s；当前以 LLM_* 为准\n", strings.Join(check.LegacySeen, ", "))
			}
		}
	} else {
		fmt.Println("⚠️  .env 不存在，运行 alice init")
		fmt.Println("  配置项: ⚠️  跳过")
	}

	fmt.Println()
	if ok {
		fmt.Println("✅ 环境检查通过")
		return
	}
	fmt.Println("❌ 环境不完整，请安装缺失的依赖")
	os.Exit(1)
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

func parseNodeMajor(version string) (int, error) {
	version = strings.TrimSpace(strings.TrimPrefix(version, "v"))
	parts := strings.SplitN(version, ".", 2)
	return strconv.Atoi(parts[0])
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

func findSystemBinDir(runtimeDir string) string {
	if dir := os.Getenv("ALICE_SYSTEM_BIN_DIR"); dir != "" {
		return dir
	}
	return filepath.Join(runtimeDir, "dist", "bin")
}

func findMissingSystemBinaries(systemBinDir string) []string {
	missing := make([]string, 0, len(requiredSystemBinaries))
	for _, name := range requiredSystemBinaries {
		path := filepath.Join(systemBinDir, name)
		info, err := os.Stat(path)
		if err != nil || info.IsDir() || info.Mode()&0o111 == 0 {
			missing = append(missing, name)
		}
	}
	return missing
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

func readEnvTemplate() ([]byte, error) {
	candidates := []string{".env.example"}
	if runtimeDir := findRuntimeDir(); runtimeDir != "" {
		candidates = append([]string{filepath.Join(runtimeDir, ".env.example")}, candidates...)
	}
	for _, candidate := range candidates {
		data, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		if strings.TrimSpace(string(data)) != "" {
			return data, nil
		}
	}
	return []byte(defaultEnvTemplate), nil
}

func loadEnvFile(path string) (map[string]string, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	env := make(map[string]string)
	scanner := bufio.NewScanner(file)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "export ") {
			line = strings.TrimSpace(strings.TrimPrefix(line, "export "))
		}
		idx := strings.IndexRune(line, '=')
		if idx <= 0 {
			return nil, fmt.Errorf("%s:%d: 无效行 %q", path, lineNo, line)
		}
		key := strings.TrimSpace(line[:idx])
		value := strings.TrimSpace(line[idx+1:])
		value = strings.Trim(value, `"'`)
		env[key] = value
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return env, nil
}

func appendEnvVars(base []string, extra map[string]string) []string {
	merged := append([]string(nil), base...)
	existing := make(map[string]struct{}, len(base))
	for _, item := range base {
		if idx := strings.IndexRune(item, '='); idx > 0 {
			existing[item[:idx]] = struct{}{}
		}
	}
	for key, value := range extra {
		if _, ok := existing[key]; ok {
			continue
		}
		merged = append(merged, key+"="+value)
	}
	return merged
}

func setEnvValue(env []string, key, value string) []string {
	prefix := key + "="
	for i, item := range env {
		if strings.HasPrefix(item, prefix) {
			env[i] = prefix + value
			return env
		}
	}
	return append(env, prefix+value)
}

type envValidation struct {
	Missing    []string
	Invalid    []string
	LegacySeen []string
	LegacyOnly []string
}

func validateEnvFile(env map[string]string) envValidation {
	result := envValidation{}
	required := []string{"TELEGRAM_API_ID", "TELEGRAM_API_HASH", "TELEGRAM_PHONE", "LLM_API_KEY"}
	for _, key := range required {
		if strings.TrimSpace(env[key]) == "" {
			result.Missing = append(result.Missing, key)
		}
	}
	if apiID := strings.TrimSpace(env["TELEGRAM_API_ID"]); apiID != "" {
		if _, err := strconv.Atoi(apiID); err != nil {
			result.Invalid = append(result.Invalid, "TELEGRAM_API_ID")
		}
	}
	legacy := map[string]string{
		"OPENAI_API_KEY":  "LLM_API_KEY",
		"OPENAI_BASE_URL": "LLM_BASE_URL",
		"OPENAI_MODEL":    "LLM_MODEL",
	}
	for oldKey, newKey := range legacy {
		if strings.TrimSpace(env[oldKey]) == "" {
			continue
		}
		result.LegacySeen = append(result.LegacySeen, oldKey)
		if strings.TrimSpace(env[newKey]) == "" {
			result.LegacyOnly = append(result.LegacyOnly, oldKey)
		}
	}
	sort.Strings(result.Missing)
	sort.Strings(result.Invalid)
	sort.Strings(result.LegacySeen)
	sort.Strings(result.LegacyOnly)
	return result
}

func newRuntimeCommand(runtimeDir string) (*exec.Cmd, string, error) {
	script := filepath.Join(runtimeDir, "src/index.ts")
	if tsx := findTsxBinary(runtimeDir); tsx != "" {
		return exec.Command(tsx, script), "", nil
	}
	if hasCommand("pnpm") {
		return exec.Command("pnpm", "--dir", runtimeDir, "exec", "tsx", "src/index.ts"), "⚠️  未找到本地 tsx，回退到 pnpm exec tsx", nil
	}
	return nil, "", fmt.Errorf("需要 Node.js + pnpm/tsx")
}

func findTsxBinary(runtimeDir string) string {
	seen := make(map[string]struct{})
	for _, root := range candidateNodeRoots(runtimeDir) {
		if root == "" {
			continue
		}
		candidate := filepath.Clean(filepath.Join(root, "node_modules", ".bin", "tsx"))
		if _, ok := seen[candidate]; ok {
			continue
		}
		seen[candidate] = struct{}{}
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			return candidate
		}
	}
	return ""
}

func candidateNodeRoots(runtimeDir string) []string {
	runtimeAbs := absPath(runtimeDir)
	return []string{
		runtimeDir,
		filepath.Dir(runtimeDir),
		runtimeAbs,
		filepath.Dir(runtimeAbs),
		".",
		"..",
	}
}

func checkNodeRuntime(runtimeDir string) error {
	cmd := exec.Command(
		"node",
		"--input-type=module",
		"-e",
		"await import('better-sqlite3'); await import('@mtcute/node');",
	)
	cmd.Dir = runtimeDir
	out, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := strings.TrimSpace(string(out))
	if msg == "" {
		msg = err.Error()
	}
	if idx := strings.IndexByte(msg, '\n'); idx >= 0 {
		msg = msg[:idx]
	}
	return fmt.Errorf("%s", msg)
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
