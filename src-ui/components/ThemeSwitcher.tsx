import React, { useEffect, useState } from 'react';
import { getMode, setMode, type ThemeMode } from '../theme';

const OPTIONS: { mode: ThemeMode; label: string; ico: string }[] = [
  { mode: 'dark', label: '暗色', ico: '🌙' },
  { mode: 'light', label: '亮色', ico: '☀' },
  { mode: 'system', label: '跟随系统', ico: '🖥' },
];

export function ThemeSwitcher({ compact = false }: { compact?: boolean }) {
  const [mode, setLocal] = useState<ThemeMode>(getMode());

  useEffect(() => {
    setLocal(getMode());
  }, []);

  const choose = (m: ThemeMode) => {
    setMode(m);
    setLocal(m);
  };

  return (
    <div className={`seg theme-seg ${compact ? 'compact' : ''}`} role="group" aria-label="主题切换">
      {OPTIONS.map((o) => (
        <button
          key={o.mode}
          className={mode === o.mode ? 'on' : ''}
          onClick={() => choose(o.mode)}
          title={`切换到${o.label}主题`}
          aria-pressed={mode === o.mode}
        >
          <span className="ico">{o.ico}</span>
          {!compact && <span>{o.label}</span>}
        </button>
      ))}
    </div>
  );
}
