import React, { useState } from 'react';
import { motion } from 'framer-motion';
import { useStore } from '../store/useStore';
import { GlassCard } from './GlassCard';
import { MagneticButton } from './MagneticButton';
import { api } from '../api';

/**
 * 首次配置引导：当用户尚未指定统一安装根目录时显示。
 * 安装根目录完全由用户决定，不提供任何硬编码默认值。
 */
export function SetupWizard() {
  const [root, setRoot] = useState('');
  const [busy, setBusy] = useState(false);
  const init = useStore((s) => s.init);
  const toast = useStore((s) => s.toast);

  const confirm = async () => {
    const r = root.trim();
    if (!r) {
      toast('请先指定安装根目录', 'err');
      return;
    }
    setBusy(true);
    try {
      const res = await api.setRoot(r);
      if (res?.ok) {
        await init(); // 成功后 configured 置真，App 自动进入主界面
      } else {
        toast('设置失败', 'err');
      }
    } finally {
      setBusy(false);
    }
  };

  const browse = async () => {
    try {
      const p = await api.pickFolder();
      if (p) setRoot(p);
      else toast('未选择目录', 'info');
    } catch (e: any) {
      toast(`打开文件夹选择器失败：${e?.message || e}`, 'err');
    }
  };

  return (
    <div className="setup-screen">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <GlassCard className="setup-card">
          <div className="logo">💎</div>
          <h1>
            欢迎使用 DevEnv <span className="gradient-text">Manager</span>
          </h1>
          <p className="desc">
            请先指定一个<strong>统一安装根目录</strong>，所有开发工具都会安装在此目录下的规范化子目录中。
            该目录完全由你决定，软件不会使用任何预设默认路径。
          </p>

          <div className="field">
            <label>安装根目录</label>
            <div className="row">
              <input
                className="input"
                placeholder="例如：E:\devenv 或 /opt/devenv"
                value={root}
                onChange={(e) => setRoot(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && confirm()}
              />
              <MagneticButton className="btn" onClick={browse}>
                浏览…
              </MagneticButton>
            </div>
          </div>

          <div className="muted small">可在“设置中心”随时修改或迁移根目录。</div>

          <MagneticButton className="btn primary lg" onClick={confirm} disabled={busy}>
            {busy ? '正在配置…' : '开始配置 →'}
          </MagneticButton>
        </GlassCard>
      </motion.div>
    </div>
  );
}
