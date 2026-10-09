import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getInstalledPiVersion } from "./installed-pi.mjs";

// 测试依赖里的 pi 包必须与本机 pi 版本锁步,否则测的是过时 API。
// 漂移时运行:cd agent/extensions && npm run sync-pi

const nodeModules = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules");
const PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
];

test("devDependencies 与已安装 pi 版本锁步", () => {
  const piVersion = getInstalledPiVersion();
  for (const pkg of PACKAGES) {
    const manifest = JSON.parse(readFileSync(path.join(nodeModules, pkg, "package.json"), "utf8"));
    assert.equal(
      manifest.version,
      piVersion,
      `${pkg}@${manifest.version} 与 pi@${piVersion} 不一致 — 在 agent/extensions/ 运行 npm run sync-pi`,
    );
  }
});
