import React, { useState, useMemo, useEffect } from 'react';
import { useStore } from '../store/useStore';
import { GlassCard } from '../components/GlassCard';
import { MagneticButton } from '../components/MagneticButton';
import type { ScanResult, DashboardTool } from '../api';
import { api } from '../api';

// 工具 → HOME 变量 / 类别（UI 镜像，与 REGISTRY 对齐）
const TOOL_META: Record<string, { name: string; category: string; homeVar?: string }> = {
  jdk: { name: 'JDK', category: 'java', homeVar: 'JAVA_HOME' },
  maven: { name: 'Maven', category: 'build-tool', homeVar: 'MAVEN_HOME' },
  gradle: { name: 'Gradle', category: 'build-tool', homeVar: 'GRADLE_HOME' },
  node: { name: 'Node.js', category: 'node' },
  mysql: { name: 'MySQL', category: 'database', homeVar: 'MYSQL_HOME' },
  redis: { name: 'Redis', category: 'database', homeVar: 'REDIS_HOME' },
  git: { name: 'Git', category: 'tool' },
  docker: { name: 'Docker', category: 'container' },
  go: { name: 'Go', category: 'go', homeVar: 'GOROOT' },
  python: { name: 'Python', category: 'python', homeVar: 'PYTHONHOME' },
  nginx: { name: 'Nginx', category: 'web-server', homeVar: 'NGINX_HOME' },
};
const TOOL_ICON: Record<string, string> = {
  jdk: '☕', maven: '📦', gradle: '🐘', node: '🟢', mysql: '🐬', redis: '🔴',
  git: '🌿', docker: '🐳', go: '🐹', python: '🐍', nginx: '🌐',
};
const ADD_TOOLS = [...Object.keys(TOOL_META), 'other'];

export function Scanner() {
  const {
    dashboardTools, scanResults, scanning, doScan, toast,
    activateDetected, switchVersion, addExisting, removeExisting, uninstallTool, openFolder, isDesktop,
  } = useStore((s) => ({
    dashboardTools: s.dashboardTools,
    scanResults: s.scanResults,
    scanning: s.scanning,
    doScan: s.doScan,
    toast: s.toast,
    activateDetected: s.activateDetected,
    switchVersion: s.switchVersion,
    addExisting: s.addExisting,
    removeExisting: s.removeExisting,
    uninstallTool: s.uninstallTool,
    openFolder: s.openFolder,
    isDesktop: s.isDesktop,
  }));
  const currentTools = useStore((s) => s.currentTools);

  // 纳管开关的乐观状态：记录「已点过纳管」的检测项 key，使按钮立即翻转为「移除纳管」（无需等后端刷新）
  const [adoptedKeys, setAdoptedKeys] = useState<Set<string>>(new Set());
  const adoptKey = (t: DashboardTool) => `${t.tool}|${t.version}|${t.path ?? ''}`;
  const onAdopt = async (t: DashboardTool) => {
    await addExisting({
      tool: t.tool, name: t.name, category: t.category, version: t.version,
      path: t.path, homeVar: TOOL_META[t.tool]?.homeVar,
    });
    setAdoptedKeys((prev) => new Set(prev).add(adoptKey(t)));
  };
  const onRemoveAdopt = async (t: DashboardTool) => {
    await removeExisting({ tool: t.tool, version: t.version, path: t.path });
    setAdoptedKeys((prev) => {
      const next = new Set(prev);
      next.delete(adoptKey(t));
      return next;
    });
  };

  // 当前使用匹配键（路径/版本），用于标记正在用的版本
  const currentKeys = useMemo(() => {
    const set = new Set<string>();
    for (const t of currentTools) {
      if (t.path) set.add(`path:${t.path}`);
      if (t.version && t.version !== '未知') set.add(`${t.tool}|${t.version}`);
    }
    return set;
  }, [currentTools]);
  const isCurrent = (t: DashboardTool) =>
    (t.path != null && currentKeys.has(`path:${t.path}`)) ||
    (t.version != null && currentKeys.has(`${t.tool}|${t.version}`));

  const exportReport = async (fmt: 'json' | 'md') => {
    const content = await (window as any).devenv?.exportReport(fmt);
    if (content) {
      const blob = new Blob([content], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `devenv-report.${fmt}`;
      a.click();
    } else {
      toast('导出需在桌面端执行', 'info');
    }
  };

  // ── 卸载确认弹窗 ──
  const [confirmUninstall, setConfirmUninstall] = useState<DashboardTool | null>(null);
  const [deleteFiles, setDeleteFiles] = useState(true);
  const openUninstall = (t: DashboardTool) => {
    setDeleteFiles(true);
    setConfirmUninstall(t);
  };
  const doUninstall = async () => {
    if (!confirmUninstall?.id) return;
    const t = confirmUninstall;
    setConfirmUninstall(null);
    await uninstallTool(t.id!, { deleteFiles });
  };

  // ── 纳管现有软件弹窗 ──
  const [showAdd, setShowAdd] = useState(false);
  const [addTool, setAddTool] = useState('jdk');
  const [addPath, setAddPath] = useState('');
  const [addVersion, setAddVersion] = useState('');
  const pickAddFolder = async () => {
    const dir = await api.pickFolder();
    if (dir) setAddPath(dir);
  };
  const confirmAdd = async () => {
    if (!addPath.trim()) return toast('请选择软件安装目录', 'err');
    if (!addVersion.trim()) return toast('请填写版本号', 'err');
    const meta = TOOL_META[addTool] ?? { name: addTool.toUpperCase(), category: 'tool' };
    setShowAdd(false);
    await addExisting({
      tool: addTool === 'other' ? addTool : addTool,
      name: meta.name,
      category: meta.category,
      version: addVersion.trim(),
      path: addPath.trim(),
      homeVar: meta.homeVar,
    });
    setAddPath(''); setAddVersion(''); setAddTool('jdk');
  };

  // 设为默认：已纳管用 switchVersion，未纳管(系统已有)用 activateDetected
  const makeDefault = async (t: DashboardTool) => {
    if (t.source === 'installed' && t.id) {
      await switchVersion(t.category, t.version, t.path);
    } else {
      await activateDetected(t);
    }
  };

  // 统一列表：以 dashboardTools 为准，按「工具」分组（每个工具折叠/展开）
  const groups = useMemo(() => {
    const map = new Map<string, DashboardTool[]>();
    for (const t of dashboardTools) {
      if (!map.has(t.tool)) map.set(t.tool, []);
      map.get(t.tool)!.push(t);
    }
    const ordered = [...map.keys()].sort((a, b) => {
      const aName = (map.get(a)![0].name || a).toLowerCase();
      const bName = (map.get(b)![0].name || b).toLowerCase();
      return aName.localeCompare(bName);
    });
    return ordered.map((tool) => ({
      tool,
      name: map.get(tool)![0].name,
      category: map.get(tool)![0].category,
      items: map.get(tool)!.sort((x, y) => {
        // installed / 已纳管 优先；同类型按版本字符串简单排
        if (x.source !== y.source) return x.source === 'installed' ? -1 : 1;
        return x.version.localeCompare(y.version);
      }),
    }));
  }, [dashboardTools]);

  // 折叠状态：默认全部展开；后续有新工具加入时自动展开
  const [expanded, setExpanded] = useState<Set<string>>(new Set(groups.map((g) => g.tool)));
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const g of groups) {
        if (!next.has(g.tool)) { next.add(g.tool); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [groups]);
  const toggleGroup = (tool: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(tool)) next.delete(tool);
      else next.add(tool);
      return next;
    });
  const expandAll = () => setExpanded(new Set(groups.map((g) => g.tool)));
  const collapseAll = () => setExpanded(new Set());
  return (
    <>
      <div className="page-head">
        <div>
          <h1>软件<span className="gradient-text">管理</span></h1>
          <div className="desc">统一管理「本软件安装的」与「电脑上已存在的」开发工具 · 纳管 / 卸载 / 一键切换</div>
        </div>
        <div className="row">
          <MagneticButton className="btn primary" onClick={doScan} disabled={scanning}>
            {scanning ? '扫描中…' : '🔍 开始扫描'}
          </MagneticButton>
          <MagneticButton className="btn" onClick={() => setShowAdd(true)} disabled={!isDesktop}>
            + 纳管现有软件
          </MagneticButton>
          <MagneticButton className="btn" onClick={() => exportReport('md')}>导出 MD</MagneticButton>
          <MagneticButton className="btn" onClick={() => exportReport('json')}>导出 JSON</MagneticButton>
        </div>
      </div>

      <GlassCard>
        <div className="dash-legend" style={{ marginBottom: 14 }}>
          <span className="lg"><span className="dot inst" />本软件安装</span>
          <span className="lg"><span className="dot sys" />系统已有(待纳管)</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button className="btn ghost sm" onClick={expandAll}>全部展开</button>
            <button className="btn ghost sm" onClick={collapseAll}>全部收起</button>
          </span>
        </div>

        <div className="scanner-groups">
          {groups.map((g) => {
            const isOpen = expanded.has(g.tool);
            const currentItem = g.items.find((t) => isCurrent(t));
            const allInstalled = g.items.every((t) => t.source === 'installed');
            const allDetected = g.items.every((t) => t.source !== 'installed');
            return (
              <div className={`scanner-group ${isOpen ? 'open' : ''}`} key={g.tool}>
                <div className="scanner-group-head" onClick={() => toggleGroup(g.tool)}>
                  <span className={`scanner-chevron ${isOpen ? 'open' : ''}`}>▶</span>
                  <span className="tool-card-ico" style={{ width: 26, height: 26, fontSize: 14 }}>{TOOL_ICON[g.tool] ?? '📦'}</span>
                  <span className="scanner-tool-name">{g.name}</span>
                  <span className="scanner-tool-cat">{g.category}</span>
                  <span className="scanner-count">{g.items.length} 个版本</span>
                  <span className="scanner-actions" onClick={(e) => e.stopPropagation()}>
                    {currentItem ? (
                      <span className="badge active">当前使用 {currentItem.version}</span>
                    ) : allDetected ? (
                      <span className="badge sys">待纳管</span>
                    ) : allInstalled ? (
                      <span className="badge ok">已管理</span>
                    ) : (
                      <span className="badge warn">部分纳管</span>
                    )}
                  </span>
                </div>
                {isOpen && (
                  <div className="scanner-versions">
                    {g.items.map((t) => (
                      <div className="scanner-version" key={`${t.source}-${t.id ?? ''}-${t.tool}-${t.version}-${t.path}`}>
                        <div className="scanner-version-main">
                          <span className="scanner-version-ver">{t.version}</span>
                          <span className="mono small" title={t.path}>{t.path || '—'}</span>
                          <span className="scanner-version-source">
                            {t.source === 'installed' ? (
                              <span className="badge ok">{t.mode === 'external' ? '已纳管' : (t.mode === 'online' ? '在线' : '离线')}</span>
                            ) : (
                              <span className="badge sys">系统</span>
                            )}
                          </span>
                          <span className="scanner-version-current">
                            {isCurrent(t) ? <span className="badge active">当前使用</span> : <span className="badge">—</span>}
                          </span>
                        </div>
                        <div className="scanner-version-ops">
                          {t.source === 'installed' && t.id ? (
                            <>
                              {!t.active && (
                                <button className="btn ghost sm" onClick={() => makeDefault(t)}>设为默认</button>
                              )}
                              {t.mode === 'external' && (
                                <button className="btn ghost sm" onClick={() => removeExisting({ id: t.id })}>移除纳管</button>
                              )}
                              <button className="btn ghost sm danger" onClick={() => openUninstall(t)}>卸载</button>
                            </>
                          ) : (
                            <>
                              <button className="btn ghost sm" onClick={() => makeDefault(t)}>设为默认</button>
                              {adoptedKeys.has(adoptKey(t)) ? (
                                <button className="btn ghost sm" onClick={() => onRemoveAdopt(t)}>移除纳管</button>
                              ) : (
                                <button className="btn ghost sm" onClick={() => onAdopt(t)}>纳管</button>
                              )}
                            </>
                          )}
                          {t.path && (
                            <button className="icon-btn" title="打开安装目录所在文件夹" onClick={() => openFolder(t.path)}>📂 打开</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {dashboardTools.length === 0 && (
            <div className="muted small" style={{ textAlign: 'center', padding: 28 }}>
              {scanning ? '正在扫描系统…' : '暂无数据，点击右上角"开始扫描"或"纳管现有软件"'}
            </div>
          )}
        </div>
      </GlassCard>

      {/* 卸载确认弹窗 */}
      {confirmUninstall && (
        <div className="modal-overlay" onClick={() => setConfirmUninstall(null)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2>确认卸载 {confirmUninstall.name} {confirmUninstall.version}</h2>
            <p className="muted small">
              该操作将从管理列表移除记录，并清理其环境变量（PATH 引用等）。
            </p>
            <div className="field">
              <label className="switch-inline">
                <input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />
                <span>同时删除安装目录文件（<span className="mono">{confirmUninstall.path}</span>）</span>
              </label>
              <div className="muted small mt">
                ⚠️ 文件删除不可逆。位于系统保护目录（如 Program Files、用户目录）下的文件不会被自动删除，需手动清理。
              </div>
              <div className="muted small mt">
                🧹 勾选「同时删除安装目录文件」后，卸载成功时其上因本次卸载而变为<b>空的父目录（如空的类别文件夹）也会一并清理</b>，但不会越过安装基目录 / 数据根，避免误删共享目录。
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setConfirmUninstall(null)}>取消</button>
              <MagneticButton className="btn danger" onClick={doUninstall}>确认卸载</MagneticButton>
            </div>
          </div>
        </div>
      )}

      {/* 纳管现有软件弹窗 */}
      {showAdd && (
        <div className="modal-overlay" onClick={() => setShowAdd(false)}>
          <div className="modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2>纳管现有软件</h2>
            <p className="muted small">将电脑上已安装的软件开发工具纳入统一管理（仅登记，不修改其文件与环境变量）。</p>
            <div className="field">
              <label>工具类型</label>
              <select className="select" value={addTool} onChange={(e) => setAddTool(e.target.value)}>
                {ADD_TOOLS.map((t) => (
                  <option key={t} value={t}>{TOOL_META[t]?.name ?? t.toUpperCase()}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>版本号</label>
              <input className="input" placeholder="如 17.0.12 / 3.9.9" value={addVersion} onChange={(e) => setAddVersion(e.target.value)} />
            </div>
            <div className="field">
              <label>安装目录</label>
              <div className="dir-row">
                <input className="input" placeholder={isDesktop ? '点击选择目录' : 'C:\\...\\Java17'} value={addPath} onChange={(e) => setAddPath(e.target.value)} />
                <button className="btn ghost" onClick={pickAddFolder} disabled={!isDesktop}>选择文件夹</button>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowAdd(false)}>取消</button>
              <MagneticButton className="btn primary" onClick={confirmAdd}>纳入管理</MagneticButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
