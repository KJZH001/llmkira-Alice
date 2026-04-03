import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installSkill, removeSkill, rollbackSkill, upgradeSkill } from "../src/skills/pkg.js";
import { getEntry } from "../src/skills/registry.js";

interface TestRoots {
  root: string;
  storeRoot: string;
  binDir: string;
  registryPath: string;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function makeRoots(): TestRoots {
  const root = mkdtempSync(join(tmpdir(), "alice-skill-pkg-"));
  tempRoots.push(root);
  return {
    root,
    storeRoot: join(root, "store"),
    binDir: join(root, "bin"),
    registryPath: join(root, "registry.json"),
  };
}

function writeSkillVersion(root: string, version: string, description: string): string {
  const skillDir = join(root, `skill-${version}`);
  const name = "demo-skill";
  mkdirSync(join(skillDir, "bin"), { recursive: true });

  writeFileSync(
    join(skillDir, "manifest.yaml"),
    [
      `name: ${name}`,
      `version: "${version}"`,
      `description: "${description}"`,
      "runtime:",
      "  backend: shell",
      "  timeout: 30",
      "  network: false",
      "  isolation: container",
      "  shell:",
      `    command: "printf '{\\"version\\":\\"${version}\\"}\\\\n'"`,
      "actions:",
      "  - name: use_demo_skill",
      '    category: "app"',
      '    description: ["demo action"]',
      '    whenToUse: "when testing package lifecycle"',
    ].join("\n"),
  );
  writeFileSync(join(skillDir, "bin", `${name}.ts`), "console.log('demo')\n");

  return join(skillDir, "manifest.yaml");
}

/** 验证 symlink 指向正确的目标（相对路径，解析后应指向 store 中的文件） */
function expectSymlinkPointsToStore(
  binDir: string,
  name: string,
  storeRoot: string,
  hash: string,
): void {
  const symlinkPath = join(binDir, name);
  expect(existsSync(symlinkPath)).toBe(true);
  expect(lstatSync(symlinkPath).isSymbolicLink()).toBe(true);

  // 解析 symlink 的实际目标
  const resolvedTarget = resolve(binDir, readlinkSync(symlinkPath));
  const expectedTarget = join(storeRoot, hash, name);
  expect(resolvedTarget).toBe(expectedTarget);
  expect(existsSync(resolvedTarget)).toBe(true);
}

describe("skill package lifecycle", () => {
  it("installs, upgrades, and rolls back through the exported system prefix", async () => {
    const roots = makeRoots();
    const v1Manifest = writeSkillVersion(roots.root, "1.0.0", "demo skill v1");
    const v2Manifest = writeSkillVersion(roots.root, "2.0.0", "demo skill v2");

    await installSkill(v1Manifest, roots);

    const v1Entry = getEntry("demo-skill", roots.registryPath);
    expect(v1Entry).toBeDefined();
    expect(v1Entry?.commandPath).toBe(join(roots.binDir, "demo-skill"));
    expectSymlinkPointsToStore(roots.binDir, "demo-skill", roots.storeRoot, v1Entry?.hash ?? "");

    await upgradeSkill("demo-skill", v2Manifest, roots);

    const v2Entry = getEntry("demo-skill", roots.registryPath);
    expect(v2Entry?.version).toBe("2.0.0");
    expect(v2Entry?.previousHash).toBe(v1Entry?.hash);
    expectSymlinkPointsToStore(roots.binDir, "demo-skill", roots.storeRoot, v2Entry?.hash ?? "");

    await rollbackSkill("demo-skill", roots);

    const rolledBack = getEntry("demo-skill", roots.registryPath);
    expect(rolledBack?.version).toBe("1.0.0");
    expect(rolledBack?.hash).toBe(v1Entry?.hash);
    expect(rolledBack?.previousHash).toBe(v2Entry?.hash);
    expectSymlinkPointsToStore(roots.binDir, "demo-skill", roots.storeRoot, rolledBack?.hash ?? "");
  });

  it("removes exported artifacts from the system prefix on uninstall", async () => {
    const roots = makeRoots();
    const manifestPath = writeSkillVersion(roots.root, "1.0.0", "demo skill v1");

    await installSkill(manifestPath, roots);
    expect(existsSync(join(roots.binDir, "demo-skill"))).toBe(true);

    await removeSkill("demo-skill", roots);

    expect(existsSync(join(roots.binDir, "demo-skill"))).toBe(false);
    expect(getEntry("demo-skill", roots.registryPath)).toBeUndefined();
  });
});
