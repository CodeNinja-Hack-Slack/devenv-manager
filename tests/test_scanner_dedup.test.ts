import { describe, it, expect } from 'vitest';
import { mergeDashboardTools } from '../src/core/scanner.js';
import type { InstalledTool, ScanResult } from '../src/types.js';

function installed(version: string, p: string): InstalledTool {
  return {
    id: `java/jdk/${version}`, tool: 'jdk', name: 'JDK', category: 'java',
    version, path: p, mode: 'online', active: true, addedToPath: true,
    installedAt: '', homeVar: 'JAVA_HOME',
  } as InstalledTool;
}
function detected(version: string, p: string, inPath = true): ScanResult {
  return { tool: 'jdk', name: 'JDK', category: 'java', version, path: p, inPath };
}

describe('scanner dedup (path normalization, Bug#2)', () => {
  it('dedups installed vs detected by normalized path (case/separator insensitive)', () => {
    // config 存正斜杠小写；系统扫描返回反斜杠大写 —— 归一化后应视为同一条
    const merged = mergeDashboardTools(
      [installed('17.0.9', 'E:/software/java/jdk/17.0.9')],
      [detected('17.0.9', 'E:\\Software\\Java\\jdk\\17.0.9')],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('installed');
  });

  it('keeps two entries when both version and normalized path differ', () => {
    // 版本不同（tool|version 键不命中）且路径归一化后也不同 → 保留两条
    const merged = mergeDashboardTools(
      [installed('17.0.9', 'E:/a/java/jdk/17.0.9')],
      [detected('17.0.12', 'E:\\b\\Java\\jdk\\17.0.12')],
    );
    expect(merged).toHaveLength(2);
  });

  it('dedups by tool+version even when paths differ but version matches (JDK8 normalize interplay)', () => {
    // 同一版本不同来源：一方 8u392（config），一方 1.8.0_392 已被规范为 8u392（detected）
    const merged = mergeDashboardTools(
      [installed('8u392', 'E:/software/java/jdk/8u392')],
      [detected('8u392', 'C:\\Program Files\\Java\\jdk8u392')],
    );
    expect(merged).toHaveLength(1);
  });
});
