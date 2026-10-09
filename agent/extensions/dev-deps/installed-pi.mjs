import { execFileSync } from "node:child_process";
import path from "node:path";

export function getInstalledPiVersion(env = process.env) {
  // npm run prepends project dependency bins, including the Pi we want to update.
  const searchPath = (env.PATH ?? "").split(path.delimiter).filter((entry) => {
    const directory = path.resolve(entry);
    return !(path.basename(directory) === ".bin" && path.basename(path.dirname(directory)) === "node_modules");
  }).join(path.delimiter);

  let version;
  try {
    version = execFileSync("pi", ["--version"], {
      env: { ...env, PATH: searchPath },
      encoding: "utf8",
      timeout: 15000,
    }).trim();
  } catch (cause) {
    throw new Error("无法运行已安装的 pi；请确认 pi 在 PATH 中，且 pi --version 可正常执行。", { cause });
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`pi --version 返回了无效版本：${JSON.stringify(version)}`);
  }
  return version;
}
