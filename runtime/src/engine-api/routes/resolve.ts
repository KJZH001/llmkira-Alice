/**
 * Engine API - 名称解析路由。
 *
 * POST /resolve/name -> { ok: true, result: { nodeId, telegramId, type } }
 *
 * ADR-237: 让 LLM 能用名称（如 @林秀）指定目标，而非数字 ID。
 * 复用 display.ts 的 resolveDisplayName 函数。
 *
 * @see docs/adr/237-name-resolution.md
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { extractNumericId } from "../../graph/constants.js";
import { resolveDisplayName } from "../../graph/display.js";
import type { EngineApiDeps } from "../server.js";

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf-8");
        resolve(raw.length > 0 ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

/**
 * POST /resolve/name
 * Body: { name: string } 或 { name: string, type?: "contact" | "channel" }
 *
 * 返回:
 * - { ok: true, result: { nodeId, telegramId, type } } — 找到
 * - { ok: true, result: null } — 未找到
 */
export async function handleResolveName(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EngineApiDeps,
): Promise<void> {
  let body: unknown;
  try {
    body = await readBody(req);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }

  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "body must be a JSON object" }));
    return;
  }

  const { name } = body as Record<string, unknown>;
  if (typeof name !== "string" || name.trim() === "") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "name is required and must be a non-empty string" }));
    return;
  }

  // 去掉 @ 前缀（LLM 习惯写 @林秀）
  const cleanName = name.startsWith("@") ? name.slice(1) : name;

  // 调用 resolveDisplayName
  const nodeId = resolveDisplayName(deps.G, cleanName);

  if (nodeId === null) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        result: null,
        message: `no entity found with name "${cleanName}"`,
      }),
    );
    return;
  }

  // 提取 Telegram 数字 ID
  const telegramId = extractNumericId(nodeId) ?? null;

  // 判断类型
  const type = nodeId.startsWith("contact:")
    ? "contact"
    : nodeId.startsWith("channel:")
      ? "channel"
      : "unknown";

  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: true,
      result: {
        nodeId,
        telegramId,
        type,
        displayName: cleanName,
      },
    }),
  );
}
