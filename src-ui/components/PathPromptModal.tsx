import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { MagneticButton } from './MagneticButton';

export interface PathPromptResult {
  /** 本次安装包缓存（下载）目录 */
  downloadDir: string;
  /** 本次软件落盘的精确文件夹（如 E:\devenv\data\install\java\jdk17.0.9）；引擎直接装到这里，不再套子目录 */
  targetDir: string;
  /** 是否勾选“以后均使用默认下载路径” */
  remember: boolean;
}

interface Props {
  open: boolean;
  /** 预填的默认下载目录（如 config 已有值或系统默认 <rootDir>/data/download） */
  defaultDownload: string;
  /** 预填的本次精确安装文件夹（引擎派生的默认路径 <基目录>/<类别>/<工具><版本>） */
  defaultTarget: string;
  /** 弹窗说明里展示的工具名（如 JDK / Node.js），增强可读性 */
  toolName?: string;
  /** 弹窗说明里展示的版本（如 17.0.9 / 17），增强可读性 */
  toolVersion?: string;
  onConfirm: (r: PathPromptResult) => void;
  onCancel: () => void;
}

/**
 * 安装路径询问弹窗（需求：每次安装前弹出，询问「本次装到哪个文件夹」）。
 * - 主问项：本次软件落盘的精确文件夹（预填引擎派生路径，用户可改或用“选择文件夹”）；
 * - 次问项：安装包下载/缓存目录；
 * - 勾选“记住默认下载路径”后，后续不再弹出（pathPromptEnabled=false）。
 */
export function PathPromptModal({ open, defaultDownload, defaultTarget, toolName, toolVersion, onConfirm, onCancel }: Props) {
  const [download, setDownload] = useState(defaultDownload);
  const [target, setTarget] = useState(defaultTarget);
  const [remember, setRemember] = useState(false);

  // 每次打开重置为最新默认值，并默认不“记住”
  useEffect(() => {
    if (open) {
      setDownload(defaultDownload);
      setTarget(defaultTarget);
      setRemember(false);
    }
  }, [open, defaultDownload, defaultTarget]);

  if (!open) return null;

  const pickDownload = async () => {
    const d = await api.pickFolder();
    if (d) setDownload(d);
  };
  const pickTarget = async () => {
    const d = await api.pickFolder();
    if (d) setTarget(d);
  };

  const confirm = () => {
    // 留空则回落到预填的派生默认路径（保证非空前端始终给引擎一个明确目标）
    const dl = download.trim() || defaultDownload;
    const td = target.trim() || defaultTarget;
    onConfirm({ downloadDir: dl, targetDir: td, remember });
  };

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h2>选择安装位置</h2>
        <p className="muted small">
          即将安装 <b>{toolName ?? '该工具'}</b>{' '}
          {toolVersion ? <>(版本 {toolVersion}) </> : null}
          请确认本次安装到哪个文件夹。
        </p>

        {/* 主问项：本次精确安装文件夹 */}
        <div className="field primary">
          <label>本次安装到哪个文件夹</label>
          <div className="dir-row">
            <input
              className="input"
              value={target}
              placeholder={defaultTarget}
              onChange={(e) => setTarget(e.target.value)}
            />
            <button className="btn ghost" onClick={pickTarget}>选择文件夹</button>
          </div>
          <div className="muted small mt">
            默认位置：<span className="mono">{defaultTarget || '（请先在设置中指定安装根目录）'}</span>
            <br />
            留空将使用上述默认位置；也可点“选择文件夹”指定任意目录。
          </div>
        </div>

        {/* 次问项：下载/缓存目录 */}
        <div className="field">
          <label>下载目录（安装包缓存位置）</label>
          <div className="dir-row">
            <input
              className="input"
              value={download}
              placeholder={defaultDownload}
              onChange={(e) => setDownload(e.target.value)}
            />
            <button className="btn ghost" onClick={pickDownload}>选择文件夹</button>
          </div>
          <div className="muted small mt">
            仅用于存放本次下载的安装包，与上方安装文件夹相互独立。
          </div>
        </div>

        <div className="switch-row">
          <label className="switch">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            <span className="slider" />
          </label>
          <div className="switch-text">
            <b>以后均使用默认下载路径</b>
            <div className="muted small mt">
              勾选后，后续安装将自动使用此次设定的下载目录，并不再弹出此询问提示（精确安装文件夹每次仍按默认位置预填）。
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>取消</button>
          <MagneticButton className="btn primary" onClick={confirm}>开始安装</MagneticButton>
        </div>
      </div>
    </div>
  );
}
