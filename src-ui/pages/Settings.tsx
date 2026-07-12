import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { GlassCard } from '../components/GlassCard';
import { MagneticButton } from '../components/MagneticButton';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { api } from '../api';
import { join, DATA_DIR } from '../../src/utils/path';

export function Settings() {
  const rootDir = useStore((s) => s.rootDir);
  const config = useStore((s) => s.config);
  const migrate = useStore((s) => s.migrate);
  const init = useStore((s) => s.init);
  const saveSettings = useStore((s) => s.saveSettings);
  const toast = useStore((s) => s.toast);

  const [newRoot, setNewRoot] = useState('');
  const [draftRoot, setDraftRoot] = useState(rootDir);

  // 下载 / 安装目录（用户可选；留空使用默认，且默认目录不会预先创建）
  const [downloadDir, setDownloadDir] = useState('');
  const [installDir, setInstallDir] = useState('');

  // 偏好设置（受控，便于"保存设置"时整体持久化）
  const [language, setLanguage] = useState<string>('zh');
  const [threads, setThreads] = useState<number>(4);
  // 是否将环境变量写入系统（默认开；测试期可关以保护本机环境）
  const [applyEnv, setApplyEnv] = useState<boolean>(true);
  // 每次安装前是否询问下载/安装路径（默认询问；关闭=使用已保存默认路径，不弹窗）
  const [askPath, setAskPath] = useState<boolean>(true);

  // 配置加载后同步到表单
  useEffect(() => {
    if (config) {
      setLanguage(config.language ?? 'zh');
      setThreads(config.download?.threads ?? 4);
      setDownloadDir(config.downloadDir ?? '');
      setInstallDir(config.installDir ?? '');
      setApplyEnv(config.applyEnv ?? true);
      setAskPath(config.pathPromptEnabled ?? true);
    }
  }, [config]);

  const pickDownload = async () => {
    const dir = await api.pickFolder();
    if (dir) setDownloadDir(dir);
  };
  const pickInstall = async () => {
    const dir = await api.pickFolder();
    if (dir) setInstallDir(dir);
  };

  const saveRoot = async () => {
    const r = await api.setRoot(draftRoot);
    if (r.ok) {
      toast('根目录已设置', 'ok');
      await init();
    } else toast('设置失败', 'err');
  };

  const onSaveSettings = async () => {
    if (!config) {
      toast('配置尚未加载，请稍候', 'err');
      return;
    }
    const next = {
      ...config,
      language,
      download: {
        ...config.download,
        threads,
      },
      // 留空（默认）存为 undefined，保持 YAML 干净；非空才写入用户自定义路径
      downloadDir: downloadDir.trim() || undefined,
      installDir: installDir.trim() || undefined,
      // 环境变量写入开关：关 = 测试模式（不写系统，仅记录预览）
      applyEnv,
      // 路径询问开关：关 = 使用已保存默认路径，不再弹窗
      pathPromptEnabled: askPath,
    };
    await saveSettings(next);
  };

  // 计算“当前生效路径”，用于下方预览（保证长路径完整可见、可换行）
  const rootHint = rootDir || '<根目录>';
  const resolvedDownload = downloadDir.trim() || join(rootHint, DATA_DIR, 'download');
  const resolvedInstall = installDir.trim() || join(rootHint, DATA_DIR, 'install');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>设置<span className="gradient-text">中心</span></h1>
          <div className="desc">统一安装根目录 / 下载源 / 语言 / 外观主题 / 根目录迁移</div>
        </div>
      </div>

      <div className="grid cols-2">
        <GlassCard title="统一安装根目录">
          <div className="field">
            <label>安装根目录（所有工具安装在此之下的规范化子目录）</label>
            <input className="input" value={draftRoot} onChange={(e) => setDraftRoot(e.target.value)} />
          </div>
          <MagneticButton className="btn primary" onClick={saveRoot}>保存根目录</MagneticButton>
          <div className="muted small mt">
            当前：<span className="mono">{rootDir || '未配置'}</span>
          </div>
        </GlassCard>

        <GlassCard title="外观主题">
          <div className="field">
            <label>界面主题（暗色 / 亮色 / 跟随系统，立即生效）</label>
            <ThemeSwitcher />
          </div>
          <div className="muted small">选择"跟随系统"后，将随操作系统的明暗偏好自动切换。</div>
        </GlassCard>

        <GlassCard title="语言与下载">
          <div className="field">
            <label>界面语言</label>
            <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </div>
          <div className="field">
            <label>下载并发线程数</label>
            <input
              className="input"
              type="number"
              min={1}
              max={16}
              value={threads}
              onChange={(e) => setThreads(Math.max(1, Math.min(16, Number(e.target.value) || 1)))}
            />
          </div>
          <MagneticButton className="btn primary" onClick={onSaveSettings}>保存设置</MagneticButton>
          <div className="muted small mt">点击后将当前偏好（下载源 / 语言 / 线程数）持久化保存到配置文件。</div>
        </GlassCard>

        <GlassCard title="下载与安装目录">
          <div className="field">
            <label>下载目录（安装包缓存位置）</label>
            <div className="dir-row">
              <input
                className="input"
                placeholder="未设置 → 使用默认 data/download 子目录"
                value={downloadDir}
                onChange={(e) => setDownloadDir(e.target.value)}
              />
              <button className="btn ghost" onClick={pickDownload}>选择文件夹</button>
            </div>
            <div className="dir-preview">
              当前生效：<b>{resolvedDownload}</b>
              {!downloadDir.trim() && '（默认，未预先创建）'}
            </div>
          </div>
          <div className="field">
            <label>安装目录（工具实际安装位置）</label>
            <div className="dir-row">
              <input
                className="input"
                placeholder="未设置 → 使用默认 data/install 子目录"
                value={installDir}
                onChange={(e) => setInstallDir(e.target.value)}
              />
              <button className="btn ghost" onClick={pickInstall}>选择文件夹</button>
            </div>
            <div className="dir-preview">
              当前生效：<b>{resolvedInstall}</b>
              {!installDir.trim() && '（默认，未预先创建）'}
            </div>
          </div>

          <div className="switch-row">
            <label className="switch">
              <input
                type="checkbox"
                checked={askPath}
                onChange={(e) => setAskPath(e.target.checked)}
              />
              <span className="slider" />
            </label>
            <div className="switch-text">
              <b>每次安装前都询问下载/安装路径</b>
              <div className="muted small mt">
                关闭后，将直接使用上方已保存的默认路径，不再弹出路径询问提示。
              </div>
            </div>
          </div>

          <MagneticButton className="btn primary" onClick={onSaveSettings}>保存设置</MagneticButton>
          <div className="muted small mt">
            两项均<b>可留空</b>：留空时使用软件目录下的 <span className="mono">data/download</span> / <span className="mono">data/install</span> 默认子目录（统一收纳于 <span className="mono">data</span> 数据目录），
            且<b>不会预先创建</b>这些文件夹（仅在你显式指定自定义路径、或真正执行下载/安装时才生成）。
          </div>
        </GlassCard>

        <GlassCard title="环境变量写入">
          <div className="switch-row">
            <label className="switch">
              <input
                type="checkbox"
                checked={applyEnv}
                onChange={(e) => setApplyEnv(e.target.checked)}
              />
              <span className="slider" />
            </label>
            <div className="switch-text">
              <b>
                {applyEnv
                  ? '已开启：安装 / 切换会写入系统环境变量（JAVA_HOME、PATH 等）'
                  : '已关闭（测试模式）：不写入系统环境变量'}
              </b>
              <div className="muted small mt">
                关闭后，安装 / 切换 / 迁移仅把将要执行的 JAVA_HOME、PATH 等操作记录到
                <span className="mono"> {'<根目录>'}/config/env-preview.json</span>，
                <b>绝不改动你本机已有的 Java 8 / 11 / 17 / 21 等环境</b>。
                正式发布时请保持开启。
              </div>
            </div>
          </div>
          <MagneticButton className="btn primary" onClick={onSaveSettings}>保存设置</MagneticButton>
        </GlassCard>

        <GlassCard title="根目录迁移">
          <div className="field">
            <label>迁移到新根目录（如 E:\a → D:\dev）</label>
            <input className="input" placeholder="D:\dev" value={newRoot} onChange={(e) => setNewRoot(e.target.value)} />
          </div>
          <MagneticButton
            className="btn"
            disabled={!newRoot}
            onClick={() => migrate(newRoot, false)}
          >
            迁移并更新环境变量
          </MagneticButton>
          <div className="muted small mt">将批量更新所有已安装工具的环境变量指向（物理文件移动默认关闭，可在桌面端开启）。</div>
        </GlassCard>

        <GlassCard title="关于">
          <div className="small" style={{ lineHeight: 1.9 }}>
            DevEnv Manager · v0.1.0<br />
            统一开发环境管理工具<br />
            在线/离线双模式 · 多版本共存 · 一键切换
          </div>
        </GlassCard>
      </div>
    </>
  );
}
