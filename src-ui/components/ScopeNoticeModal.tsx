import React, { useEffect, useState } from 'react';
import { MagneticButton } from './MagneticButton';

interface Props {
  open: boolean;
  /** 弹窗说明里展示的工具名（如 JDK / Node.js），增强可读性 */
  toolName?: string;
  /** 弹窗说明里展示的版本（如 17.0.9 / 17），增强可读性 */
  toolVersion?: string;
  /** 用户确认继续安装；dontAsk=true 表示「不再提示」（写入配置 scopePromptEnabled=false） */
  onConfirm: (dontAsk: boolean) => void;
  onCancel: () => void;
}

/**
 * 用户级环境变量提示弹窗（需求：双击打开、未以管理员运行时，安装前提示环境变量将写入用户级）。
 * - 说明当前为普通用户身份运行，HOME/PATH 将写入【用户级变量】（仅当前账户生效、免管理员）；
 * - 如需【系统级变量】（对所有用户生效）请右键以管理员身份运行本程序；
 * - 提供「不再提示」勾选，勾选后本次及以后不再弹出（scopePromptEnabled=false）。
 */
export function ScopeNoticeModal({ open, toolName, toolVersion, onConfirm, onCancel }: Props) {
  const [dontAsk, setDontAsk] = useState(false);

  // 每次打开重置「不再提示」勾选
  useEffect(() => {
    if (open) setDontAsk(false);
  }, [open]);

  if (!open) return null;

  const confirm = () => onConfirm(dontAsk);

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card scope-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="scope-banner">
          <span className="scope-banner-icon">🔒</span>
          <div>
            <div className="scope-banner-title">将以普通用户身份安装</div>
            <div className="scope-banner-sub">未检测到管理员权限</div>
          </div>
        </div>

        <h2>环境变量将写入「用户级」</h2>
        <p className="muted small">
          即将安装 <b>{toolName ?? '该工具'}</b>{' '}
          {toolVersion ? <>(版本 {toolVersion}) </> : null}
          。由于当前是<b>双击启动（未以管理员身份运行）</b>，开发工具的
          <code className="mono">HOME</code> 与 <code className="mono">PATH</code> 将写入
          <b> 用户级环境变量（HKCU）</b>。
        </p>

        <div className="scope-points">
          <div className="scope-point">
            <span className="scope-dot user" />
            <div>
              <b>用户级变量（本次生效）</b>
              <div className="muted small mt">
                仅对<b>你当前的 Windows 账户</b>生效，<b>不需要管理员权限</b>，安装后即可在终端直接使用。
                其他 Windows 账户不会受到影响。
              </div>
            </div>
          </div>
          <div className="scope-point">
            <span className="scope-dot system" />
            <div>
              <b>系统级变量（可选）</b>
              <div className="muted small mt">
                如需对环境变量对所有用户生效（写入系统级 HKLM），请<b>关闭本程序</b>，
                右键程序图标 →「<b>以管理员身份运行</b>」后重试。
              </div>
            </div>
          </div>
        </div>

        <div className="muted small scope-note">
          提示：两种情况下工具文件都会照常安装到统一目录，区别仅在于环境变量注册的位置。
        </div>

        <div className="switch-row">
          <label className="switch">
            <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
            <span className="slider" />
          </label>
          <div className="switch-text">
            <b>不再提示</b>
            <div className="muted small mt">
              勾选后，后续安装将不再弹出此提示（环境变量仍按当前身份写入用户级）。
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <MagneticButton className="btn primary" onClick={confirm}>继续安装</MagneticButton>
        </div>
      </div>
    </div>
  );
}
