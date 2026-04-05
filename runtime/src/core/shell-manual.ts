/**
 * Shell-native manual generator.
 *
 * ADR-217: 统一 self 命名空间 + irc 子命令签名。
 * 唯一事实来源：Mod definitions (指令/查询) + irc citty definitions (子命令)。
 */

import type { z } from "zod";
import { alicePkgSubCommands } from "../system/alice-pkg-cli.js";
import { renderSubCommandSynopsis } from "../system/citty-synopsis.js";
import { ircSubCommands } from "../system/irc-cli.js";
import { probeCommandCatalog } from "./command-catalog.js";
import { registerKnownCommands } from "./script-validator.js";
import type { ModDefinition, ParamDefinition } from "./types.js";

function isOptionalParam(param: ParamDefinition): boolean {
  return param.schema.isOptional();
}

/** snake_case → kebab-case for CLI display. */
function toKebab(snake: string): string {
  return snake.replace(/_/g, "-");
}

const MANUAL_OMIT_ARGS = new Set(["json"]);

function renderIrcSection(): string[] {
  const lines = [
    "## irc",
    "",
    "Named flags only. `--in` omitted = current chat. Hidden compatibility aliases are omitted here.",
    "",
    ...renderSubCommandSynopsis("irc", ircSubCommands, { omitArgs: MANUAL_OMIT_ARGS }),
  ];
  lines.push("");
  return lines;
}

// ─── self 指令/查询渲染 ──────────────────────────────────────────────
// POSIX synopsis 风格：一行一个命令，<required> [optional] a|b|c=枚举。

/**
 * 从 zod schema 提取枚举值列表。
 * 支持 z.enum / z.default(z.enum) / z.optional(z.enum)。
 * 返回 null 表示非枚举。
 */
function extractEnumValues(schema: z.ZodTypeAny): string[] | null {
  const typeName = (schema._def as { typeName?: string }).typeName;
  if (!typeName) return null;

  if (typeName === "ZodEnum") {
    const values = (schema._def as { values?: unknown }).values;
    return Array.isArray(values) ? (values as string[]) : null;
  }
  if (typeName === "ZodDefault" || typeName === "ZodOptional") {
    const inner = (schema._def as { innerType?: z.ZodTypeAny }).innerType;
    return inner ? extractEnumValues(inner) : null;
  }
  return null;
}

/** 生成参数的值占位符：枚举用 <a|b|c>，其余用 <name>。 */
function paramPlaceholder(paramName: string, schema: z.ZodTypeAny): string {
  const enumValues = extractEnumValues(schema);
  if (enumValues && enumValues.length <= 10) {
    return `<${enumValues.join("|")}>`;
  }
  return `<${paramName}>`;
}

function renderSelfCommands(mods: readonly ModDefinition[]): string[] {
  const lines: string[] = ["## self", ""];

  for (const mod of mods) {
    const instructionEntries = Object.entries(mod.instructions ?? {}).filter(
      ([, def]) => def.affordance != null,
    );
    const queryEntries = Object.entries(mod.queries ?? {}).filter(
      ([, def]) => def.affordance != null,
    );

    for (const [name, def] of instructionEntries) {
      const derivedKeys = def.deriveParams
        ? new Set(Object.keys(def.deriveParams))
        : new Set<string>();
      const parts: string[] = [`self ${toKebab(name)}`];
      for (const [paramName, param] of Object.entries(def.params)) {
        if (derivedKeys.has(paramName)) continue;
        const optional = isOptionalParam(param);
        const placeholder = paramPlaceholder(paramName, param.schema);
        const flag = `--${paramName} ${placeholder}`;
        parts.push(optional ? `[${flag}]` : flag);
      }
      lines.push(parts.join(" "));
    }

    for (const [name, def] of queryEntries) {
      const derivedKeys = def.deriveParams
        ? new Set(Object.keys(def.deriveParams))
        : new Set<string>();
      const parts: string[] = [`self ${toKebab(name)}`];
      for (const [paramName, param] of Object.entries(def.params)) {
        if (derivedKeys.has(paramName)) continue;
        const optional = isOptionalParam(param);
        const placeholder = paramPlaceholder(paramName, param.schema);
        const flag = `--${paramName} ${placeholder}`;
        parts.push(optional ? `[${flag}]` : flag);
      }
      lines.push(parts.join(" "));
    }
  }

  lines.push("");
  return lines;
}

// ─── Command Catalog（系统命令 + Skill 命令发现）──────────────────────

function renderAlicePkgSection(): string[] {
  const lines = ["## alice-pkg", "", ...renderSubCommandSynopsis("alice-pkg", alicePkgSubCommands)];
  lines.push("");
  return lines;
}

// ─── Skill 命令（外部二进制，参数各异，用 --help 查看）──────────────

async function renderSkillCatalog(): Promise<string[]> {
  const catalog = await probeCommandCatalog();
  registerKnownCommands(catalog.commands.map((c) => c.name));
  const lines: string[] = [];

  const skillCommands = catalog.commands.filter((entry) => entry.kind === "skill");

  if (skillCommands.length > 0) {
    lines.push("## Skills on PATH (use <command> --help for details)", "");
    for (const entry of skillCommands) {
      const hint = entry.whenToUse ? ` | ${entry.whenToUse}` : "";
      lines.push(`${entry.name} — ${entry.summary}${hint}`);
    }
    lines.push("");
  }

  return lines;
}

// ─── 入口 ────────────────────────────────────────────────────────────

export async function generateShellManual(mods: readonly ModDefinition[]): Promise<string> {
  const skillCatalog = await renderSkillCatalog();
  const parts = [
    "## Shell Contract",
    "",
    "Write a multi-line POSIX sh script. One command per line. `# ...` comments = inner monologue.",
    "All commands support --help.",
    "Do not invent aliases or positional shorthand. For `irc`, use named flags exactly as shown below.",
    "",
    "## Afterward",
    "",
    "`done` | `waiting_reply` | `watching` | `fed_up` (closes chat) | `cooling_down` (freezes ~30min)",
    "",
    ...renderIrcSection(),
    ...renderSelfCommands(mods),
    ...renderAlicePkgSection(),
    ...skillCatalog,
  ];

  return parts.join("\n");
}
