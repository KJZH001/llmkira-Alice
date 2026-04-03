// google — Google 搜索
//
// 用法: google <query>
// 输出: JSON to stdout
//
// 环境变量: ALICE_ENGINE_URL — Engine API URL（用于代理搜索）
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/LlmKira/Alice/runtime/internal/engine"
)

type GoogleResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet,omitempty"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "Usage: google <query>")
		os.Exit(1)
	}

	query := os.Args[1]
	client := engine.NewClient()

	result, err := client.Query("/search/google", map[string]string{"query": query})
	if err != nil {
		fmt.Fprintf(os.Stderr, "Search failed: %v\n", err)
		os.Exit(1)
	}

	output, _ := json.Marshal(result)
	fmt.Println(string(output))
}