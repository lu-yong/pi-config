import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getInstalledPiVersion } from "./installed-pi.mjs";

const version = getInstalledPiVersion();
console.log(`同步扩展开发依赖到 Pi ${version}`);
const result = spawnSync(process.execPath, [
  process.env.npm_execpath,
  "install", "--save-dev", "--save-exact",
  ...["pi-ai", "pi-coding-agent", "pi-tui"].map((name) => `@earendil-works/${name}@${version}`),
], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
