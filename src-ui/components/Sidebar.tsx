import React from 'react';
import { motion } from 'framer-motion';
import { useStore, type PageKey } from '../store/useStore';
import { ThemeSwitcher } from './ThemeSwitcher';

/** 按功能分组，减少扁平 8 项带来的认知负担 */
const SECTIONS: { label: string; items: { key: PageKey; label: string; ico: string }[] }[] = [
  {
    label: '概览',
    items: [{ key: 'dashboard', label: '环境概览', ico: '◎' }],
  },
  {
    label: '工具管理',
    items: [
      { key: 'scanner', label: '环境扫描', ico: '🔍' },
      { key: 'install', label: '安装工具', ico: '⬇' },
      { key: 'switch', label: '版本切换', ico: '⇄' },
      { key: 'env', label: '环境变量', ico: '⚙' },
    ],
  },
  {
    label: '系统',
    items: [
      { key: 'profiles', label: '配置方案', ico: '🗂' },
      { key: 'settings', label: '设置', ico: '🔧' },
    ],
  },
];

export function Sidebar() {
  const page = useStore((s) => s.page);
  const setPage = useStore((s) => s.setPage);
  const rootDir = useStore((s) => s.rootDir);

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="logo">D</div>
        <div>
          <div className="title">DevEnv</div>
          <div className="sub">Manager</div>
        </div>
      </div>
      <div className="sidebar-theme">
        <ThemeSwitcher compact />
      </div>

      {SECTIONS.map((sec) => (
        <div className="nav-section" key={sec.label}>
          <div className="nav-section-label">{sec.label}</div>
          {sec.items.map((n) => (
            <div
              key={n.key}
              className={`nav-item ${page === n.key ? 'active' : ''}`}
              onClick={() => setPage(n.key)}
            >
              {page === n.key && (
                <motion.span
                  layoutId="nav-pill"
                  className="nav-pill"
                  transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                />
              )}
              <span className="ico">{n.ico}</span>
              {n.label}
            </div>
          ))}
        </div>
      ))}

      <div className="sidebar-foot">
        <div className="root-chip" title={rootDir || '未配置'}>
          <span className="dot" />
          <span className="mono">{rootDir || '未配置'}</span>
        </div>
      </div>
    </aside>
  );
}
