import type { DevEnvConfig, ProfileSpec } from '../types.js';
import { saveConfig, loadConfig } from '../config/store.js';
import { ensureRootDirs } from '../config/store.js';
import { switchVersion } from './switch.js';
import type { EnvBackend } from '../platform/env.js';
import YAML from 'yaml';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ============================================================================
// 配置方案（Profiles）+ 导入/导出
// ============================================================================

/** 创建/更新一套配置方案 */
export async function saveProfile(cfg: DevEnvConfig, id: string, spec: ProfileSpec): Promise<void> {
  cfg.profiles[id] = spec;
  await saveConfig(cfg);
}

/** 应用方案：按 tool->version 逐一切换到对应版本 */
export async function applyProfile(
  cfg: DevEnvConfig,
  id: string,
  env: EnvBackend,
): Promise<{ ok: boolean; error?: string; switched: string[] }> {
  const spec = cfg.profiles[id];
  if (!spec) return { ok: false, error: `方案不存在：${id}`, switched: [] };
  const switched: string[] = [];
  const byTool = new Map<string, string>(); // tool -> version
  for (const [tool, version] of Object.entries(spec.tools)) byTool.set(tool, version);

  // 找到每个 tool 对应的 category（从已安装记录或注册表）
  const { getSpec } = await import('../tools/registry.js');
  for (const [tool, version] of byTool) {
    const spec2 = getSpec(tool);
    if (!spec2) continue;
    const r = await switchVersion(cfg, spec2.category, version, env);
    if (r.ok) switched.push(`${tool}@${version}`);
  }
  return { ok: true, switched };
}

/** 导出当前配置为 YAML 文件（用于换机迁移） */
export async function exportConfig(cfg: DevEnvConfig, filePath: string): Promise<void> {
  await fsp.writeFile(filePath, YAML.stringify(cfg), 'utf8');
}

/** 从 YAML 导入配置；可指定新根目录（换机时） */
export async function importConfig(
  filePath: string,
  newRoot?: string,
): Promise<DevEnvConfig> {
  const raw = await fsp.readFile(filePath, 'utf8');
  const cfg = YAML.parse(raw) as DevEnvConfig;
  if (newRoot) cfg.rootDir = newRoot;
  await ensureRootDirs(cfg.rootDir);
  await saveConfig(cfg);
  return cfg;
}

export { path };
