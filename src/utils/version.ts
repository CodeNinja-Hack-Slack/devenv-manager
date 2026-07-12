// ============================================================================
// 版本号解析与比较工具（纯函数，可单测）
// ============================================================================

/**
 * 规范化 JDK 版本：1.8 -> 8，11 -> 11，17.0.9 -> 17.0.9
 * 许多发行版把 Java 8 写作 1.8.0_xxx，需归一化便于比较/切换。
 */
export function normalizeJdkVersion(v: string): string {
  const m = v.match(/^1\.(\d+)(\.\d+)?(_\d+)?/);
  if (m) {
    const patch = m[2] ? m[2].slice(1) : '0';
    return `${m[1]}.${patch}`;
  }
  return v;
}

/** 把 "17.0.9" 拆成数字数组 [17,0,9]，非数字段记 0 */
export function parseVersion(v: string): number[] {
  return v
    .split(/[.\-_+]/)
    .map((s) => {
      const n = parseInt(s, 10);
      return Number.isFinite(n) ? n : 0;
    });
}

/** 比较版本：a<b 返回 -1，a==b 返回 0，a>b 返回 1 */
export function compareVersions(a: string, b: string): number {
  const na = parseVersion(normalizeJdkVersion(a));
  const nb = parseVersion(normalizeJdkVersion(b));
  const len = Math.max(na.length, nb.length);
  for (let i = 0; i < len; i++) {
    const x = na[i] ?? 0;
    const y = nb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 主版本号，例如 17.0.9 -> 17 */
export function majorVersion(v: string): number {
  return parseVersion(normalizeJdkVersion(v))[0] ?? 0;
}

/** 把工具名映射到“短标签”（用于目录名），保持与需求示例一致 */
export function dirLabel(tool: string, version: string): string {
  return `${tool}${version}`;
}
