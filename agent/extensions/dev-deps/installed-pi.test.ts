import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getInstalledPiVersion } from "./installed-pi.mjs";

test("读取 PATH 中安装的 Pi，跳过 npm 注入的旧开发依赖", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "sync-pi-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const localBin = path.join(root, "extensions", "node_modules", ".bin");
  const parentBin = path.join(root, "node_modules", ".bin");
  const installedBin = path.join(root, "bin");
  for (const [directory, version] of [[localBin, "0.87.1"], [parentBin, "0.90.0"], [installedBin, "1.1.0"]]) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "pi"), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  }
  const env = { ...process.env, PATH: [localBin, parentBin, installedBin].join(path.delimiter) };
  assert.equal(getInstalledPiVersion(env), "1.1.0");
  assert.equal(env.PATH, [localBin, parentBin, installedBin].join(path.delimiter));

  writeFileSync(path.join(installedBin, "pi"), "#!/bin/sh\nprintf 'unexpected output\\n'\n");
  assert.throws(() => getInstalledPiVersion(env), /无效版本/);

  assert.throws(() => getInstalledPiVersion({ ...env, PATH: localBin }), /无法运行已安装的 pi/);
});
