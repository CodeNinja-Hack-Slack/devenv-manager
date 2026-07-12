// ============================================================================
// 主题控制：暗色 / 亮色 / 跟随系统
// - 用户选择存于 localStorage('devenv.theme')
// - 实际生效的色板通过 <html data-theme="dark|light"> 切换（CSS 控制）
// - "跟随系统"模式监听 prefers-color-scheme，操作系统主题变化时即时切换
// ============================================================================

export type ThemeMode = 'dark' | 'light' | 'system';

const KEY = 'devenv.theme';

export function getMode(): ThemeMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-color-scheme: dark)').matches
    : true;
}

/** 将用户选择的模式解析为实际生效的色板（dark/light） */
function resolveActual(mode: ThemeMode): 'dark' | 'light' {
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

/** 把当前模式应用到 <html> 上（立即生效） */
export function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const mode = getMode();
  const root = document.documentElement;
  root.setAttribute('data-theme', resolveActual(mode));
  root.setAttribute('data-mode', mode); // 仅用于调试/查看当前选择
}

/** 切换主题模式并持久化 */
export function setMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* ignore */
  }
  applyTheme();
}

/** 应用启动时调用一次：应用已保存主题 + 注册系统主题变化监听 */
export function initTheme(): void {
  applyTheme();
  if (typeof window !== 'undefined' && window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (getMode() === 'system') applyTheme();
    };
    // 兼容新旧浏览器
    if (mq.addEventListener) mq.addEventListener('change', onChange);
    else if ((mq as any).addListener) (mq as any).addListener(onChange);
  }
}
