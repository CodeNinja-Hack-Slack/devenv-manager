import { describe, it, expect } from 'vitest';
import { mergeDashboardTools, pickCurrentTools, type DashboardTool } from '../src/core/scanner.js';
import type { InstalledTool, ScanResult } from '../src/types.js';

/** 构造一个已纳管工具条目（满足引擎 InstalledTool 形状） */
function installed(
  p: Partial<InstalledTool> & Pick<InstalledTool, 'tool' | 'name' | 'category' | 'version' | 'active'>,
): InstalledTool {
  return {
    id: `${p.category}/${p.tool}/${p.version}`,
    path: '',
    binPath: '',
    mode: 'online',
    addedToPath: false,
    installedAt: '2026-01-01',
    ...p,
  } as InstalledTool;
}

/** 构造一个系统检测条目（满足引擎 ScanResult 形状） */
function detected(
  p: Partial<ScanResult> & Pick<ScanResult, 'tool' | 'name' | 'category' | 'version' | 'inPath'>,
): ScanResult {
  return { path: null, ...p } as ScanResult;
}

describe('pickCurrentTools', () => {
  it('每个工具仅保留一个「当前使用」版本', () => {
    const merged = mergeDashboardTools(
      [
        installed({ tool: 'jdk', name: 'JDK', category: 'java', version: '17.0.9', active: true }),
        installed({ tool: 'jdk', name: 'JDK', category: 'java', version: '8.0', active: false }),
      ],
      [
        detected({ tool: 'jdk', name: 'JDK', category: 'java', version: '8.0', inPath: true, path: 'C:\\Program Files\\Java\\jdk8' }),
        detected({ tool: 'maven', name: 'Maven', category: 'build-tool', version: '3.9.6', inPath: true }),
      ],
    );
    const current = pickCurrentTools(merged);
    // 去重后 jdk 两 installed + maven 一 detected = 3 条合并；pick 后应为 2 个工具
    expect(merged.length).toBe(3);
    expect(current.length).toBe(2);
    const jdk = current.find((t) => t.tool === 'jdk')!;
    expect(jdk.current).toBe(true);
    // 已纳管且默认(active) 的 17.0.9 应优先于系统 PATH 的 8.0
    expect(jdk.version).toBe('17.0.9');
    expect(jdk.using).toBe('managed');
    const maven = current.find((t) => t.tool === 'maven')!;
    expect(maven.using).toBe('system');
    expect(maven.inPath).toBe(true);
  });

  it('无已纳管默认时，系统 PATH 命中版本成为当前使用', () => {
    const merged = mergeDashboardTools(
      [
        // 已纳管但非默认
        installed({ tool: 'jdk', name: 'JDK', category: 'java', version: '17.0.9', active: false }),
      ],
      [
        // 系统 PATH 命中
        detected({ tool: 'jdk', name: 'JDK', category: 'java', version: '8.0', inPath: true, path: 'C:\\Java\\jdk8' }),
      ],
    );
    const current = pickCurrentTools(merged);
    const jdk = current.find((t) => t.tool === 'jdk')!;
    expect(jdk.version).toBe('8.0');
    expect(jdk.using).toBe('system');
  });

  it('仅系统检测（含未在 PATH）时，仍能挑出一个当前使用版本', () => {
    const merged = mergeDashboardTools(null, [
      detected({ tool: 'git', name: 'Git', category: 'tool', version: '2.45.2', inPath: false, path: 'C:\\Git' }),
    ]);
    const current = pickCurrentTools(merged);
    expect(current.length).toBe(1);
    expect(current[0].tool).toBe('git');
    expect(current[0].current).toBe(true);
  });
});
