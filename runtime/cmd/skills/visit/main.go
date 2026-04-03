// visit — 网页访问/摘要
//
// 用法: visit <url>
// 输出: JSON to stdout
//
// 环境变量: ALICE_ENGINE_URL — Engine API URL
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/LlmKira/alice/runtime/internal/engine"
)

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: visit <url>")
		os.Exit(1)
	}

	url := os.Args[1]
	client := engine.NewClient()

	result, err := client.Query("/fetch", map[string]string{"url": url})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Fetch failed: %v\n", err)
		os.Exit(1)
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}