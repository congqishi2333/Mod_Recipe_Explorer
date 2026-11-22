import fs from 'fs';

// 正式版列表：Mojang version_manifest_v2 中 type=release 且版本 >= 1.21.1。
// 1.21.11 之后 Mojang 改用 26.x 命名，所以既保留 1.21.x 也包含 26.x。
const cfg = JSON.parse(fs.readFileSync(new URL('../config/versions.json', import.meta.url), 'utf8'));

export const SUPPORTED_VERSIONS = cfg.versions;
export const LATEST_VERSION = cfg.versions[0];
export const DEFAULT_VERSION = process.env.MC_VERSION && cfg.versions.includes(process.env.MC_VERSION)
  ? process.env.MC_VERSION
  : cfg.default;

// 版本串会进入路径与 URL，只允许 1.21.1 / 26.3 这种点分数字形式，防路径穿越。
const VERSION_RE = /^\d+(?:\.\d+){1,3}$/;

export function normalizeMcVersion(input) {
  if (input === undefined || input === null || input === '') return DEFAULT_VERSION;
  const v = String(input).trim();
  if (!VERSION_RE.test(v)) {
    const e = new Error(`Invalid mcVersion: ${v}`);
    e.status = 400;
    throw e;
  }
  return v;
}
