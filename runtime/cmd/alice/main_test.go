package main

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestLoadEnvFile(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, ".env")
	content := `# comment
export TELEGRAM_API_ID=123456
TELEGRAM_API_HASH="hash-value"
LLM_API_KEY='sk-test'
LLM_MODEL=gpt-4o
`
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write env: %v", err)
	}

	got, err := loadEnvFile(path)
	if err != nil {
		t.Fatalf("loadEnvFile(): %v", err)
	}

	want := map[string]string{
		"TELEGRAM_API_ID":   "123456",
		"TELEGRAM_API_HASH": "hash-value",
		"LLM_API_KEY":       "sk-test",
		"LLM_MODEL":         "gpt-4o",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("env mismatch\ngot:  %#v\nwant: %#v", got, want)
	}
}

func TestValidateEnvFile(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		env        map[string]string
		wantMiss   []string
		wantBad    []string
		wantLegacy []string
	}{
		{
			name: "valid current keys",
			env: map[string]string{
				"TELEGRAM_API_ID":   "123456",
				"TELEGRAM_API_HASH": "hash",
				"TELEGRAM_PHONE":    "+8613800138000",
				"LLM_API_KEY":       "sk-test",
			},
		},
		{
			name: "legacy openai keys only",
			env: map[string]string{
				"TELEGRAM_API_ID":   "123456",
				"TELEGRAM_API_HASH": "hash",
				"TELEGRAM_PHONE":    "+8613800138000",
				"OPENAI_API_KEY":    "sk-test",
			},
			wantMiss:   []string{"LLM_API_KEY"},
			wantLegacy: []string{"OPENAI_API_KEY"},
		},
		{
			name: "invalid api id",
			env: map[string]string{
				"TELEGRAM_API_ID":   "12x",
				"TELEGRAM_API_HASH": "hash",
				"TELEGRAM_PHONE":    "+8613800138000",
				"LLM_API_KEY":       "sk-test",
			},
			wantBad: []string{"TELEGRAM_API_ID"},
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			got := validateEnvFile(tt.env)
			if !reflect.DeepEqual(got.Missing, tt.wantMiss) {
				t.Fatalf("Missing mismatch\ngot:  %#v\nwant: %#v", got.Missing, tt.wantMiss)
			}
			if !reflect.DeepEqual(got.Invalid, tt.wantBad) {
				t.Fatalf("Invalid mismatch\ngot:  %#v\nwant: %#v", got.Invalid, tt.wantBad)
			}
			if !reflect.DeepEqual(got.LegacyOnly, tt.wantLegacy) {
				t.Fatalf("LegacyOnly mismatch\ngot:  %#v\nwant: %#v", got.LegacyOnly, tt.wantLegacy)
			}
		})
	}
}

func TestFindTsxBinaryPrefersRuntimeLocal(t *testing.T) {
	t.Parallel()

	root := t.TempDir()
	runtimeDir := filepath.Join(root, "runtime")
	runtimeBinDir := filepath.Join(runtimeDir, "node_modules", ".bin")
	parentBinDir := filepath.Join(root, "node_modules", ".bin")
	if err := os.MkdirAll(runtimeBinDir, 0755); err != nil {
		t.Fatalf("mkdir runtime bin: %v", err)
	}
	if err := os.MkdirAll(parentBinDir, 0755); err != nil {
		t.Fatalf("mkdir parent bin: %v", err)
	}

	runtimeTsx := filepath.Join(runtimeBinDir, "tsx")
	parentTsx := filepath.Join(parentBinDir, "tsx")
	if err := os.WriteFile(runtimeTsx, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write runtime tsx: %v", err)
	}
	if err := os.WriteFile(parentTsx, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write parent tsx: %v", err)
	}

	got := findTsxBinary(runtimeDir)
	if got != runtimeTsx {
		t.Fatalf("findTsxBinary() = %q, want %q", got, runtimeTsx)
	}
}

func TestNewRuntimeCommandFallsBackToPnpm(t *testing.T) {
	t.Parallel()

	if !hasCommand("pnpm") {
		t.Skip("pnpm not installed")
	}

	runtimeDir := t.TempDir()
	srcDir := filepath.Join(runtimeDir, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte("export {};\n"), 0644); err != nil {
		t.Fatalf("write index.ts: %v", err)
	}

	cmd, warning, err := newRuntimeCommand(runtimeDir)
	if err != nil {
		t.Fatalf("newRuntimeCommand(): %v", err)
	}
	if filepath.Base(cmd.Path) != "pnpm" {
		t.Fatalf("cmd.Path = %q, want basename pnpm", cmd.Path)
	}
	if warning == "" {
		t.Fatalf("warning should not be empty")
	}
	wantArgs := []string{"pnpm", "--dir", runtimeDir, "exec", "tsx", "src/index.ts"}
	if !reflect.DeepEqual(cmd.Args, wantArgs) {
		t.Fatalf("cmd.Args mismatch\ngot:  %#v\nwant: %#v", cmd.Args, wantArgs)
	}
}

func TestReadEnvTemplatePrefersRuntimeExample(t *testing.T) {
	runtimeDir := t.TempDir()
	templatePath := filepath.Join(runtimeDir, ".env.example")
	srcDir := filepath.Join(runtimeDir, "src")
	if err := os.MkdirAll(srcDir, 0755); err != nil {
		t.Fatalf("mkdir src: %v", err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "index.ts"), []byte("export {};\n"), 0644); err != nil {
		t.Fatalf("write index.ts: %v", err)
	}
	want := "LLM_API_KEY=test-from-template\n"
	if err := os.WriteFile(templatePath, []byte(want), 0644); err != nil {
		t.Fatalf("write template: %v", err)
	}

	t.Setenv("ALICE_RUNTIME_DIR", runtimeDir)

	got, err := readEnvTemplate()
	if err != nil {
		t.Fatalf("readEnvTemplate(): %v", err)
	}
	if string(got) != want {
		t.Fatalf("template mismatch\ngot:  %q\nwant: %q", string(got), want)
	}
}

func TestAppendEnvVarsDoesNotOverrideExisting(t *testing.T) {
	t.Parallel()

	base := []string{"LLM_API_KEY=from-shell", "PATH=/usr/bin"}
	extra := map[string]string{
		"LLM_API_KEY":    "from-dotenv",
		"TELEGRAM_PHONE": "+8613800138000",
	}

	got := appendEnvVars(base, extra)
	want := []string{"LLM_API_KEY=from-shell", "PATH=/usr/bin", "TELEGRAM_PHONE=+8613800138000"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("appendEnvVars() mismatch\ngot:  %#v\nwant: %#v", got, want)
	}
}

func TestParseNodeMajor(t *testing.T) {
	t.Parallel()

	tests := []struct {
		version string
		want    int
	}{
		{version: "v22.3.0", want: 22},
		{version: "20.19.4", want: 20},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.version, func(t *testing.T) {
			t.Parallel()

			got, err := parseNodeMajor(tt.version)
			if err != nil {
				t.Fatalf("parseNodeMajor(%q): %v", tt.version, err)
			}
			if got != tt.want {
				t.Fatalf("parseNodeMajor(%q) = %d, want %d", tt.version, got, tt.want)
			}
		})
	}
}

func TestFindSystemBinDirPrefersEnv(t *testing.T) {
	t.Setenv("ALICE_SYSTEM_BIN_DIR", "/tmp/alice-system-bin")
	got := findSystemBinDir("/opt/alice/runtime")
	if got != "/tmp/alice-system-bin" {
		t.Fatalf("findSystemBinDir() = %q, want %q", got, "/tmp/alice-system-bin")
	}
}

func TestFindMissingSystemBinaries(t *testing.T) {
	t.Parallel()

	systemBinDir := t.TempDir()
	for _, name := range []string{"irc", "self"} {
		path := filepath.Join(systemBinDir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"), 0755); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}

	got := findMissingSystemBinaries(systemBinDir)
	want := []string{"alice-pkg"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("findMissingSystemBinaries() mismatch\ngot:  %#v\nwant: %#v", got, want)
	}
}
