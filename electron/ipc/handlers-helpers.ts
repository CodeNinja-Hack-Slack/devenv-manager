// ============================================================================
// IPC 处理器纯函数辅助（抽离以便单测；不含任何 Electron / 子进程依赖）
// ============================================================================

/** 路径归一化：Windows 大小写不敏感 + 反斜杠统一 + 尾斜杠去除 */
export const normPathForActive = (p?: string) =>
  (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * 展开值中的 %VAR% 引用（最多迭代 6 次以支持链式引用），无对应变量则保留原样。
 * 把 JAVA_HOME=%JAVA_HOME17% 之类引用展开为绝对路径，便于阅读。
 */
export function expandEnv(s: string, env: Record<string, string | undefined>): string {
  let r = s;
  for (let i = 0; i < 6; i++) {
    const next = r.replace(/%([A-Za-z_][\w]*)%/g, (_match, n: string) => {
      const v = env[n] ?? env[n.toUpperCase()];
      return v !== undefined ? v : `%${n}%`;
    });
    if (next === r) break;
    r = next;
  }
  return r;
}
