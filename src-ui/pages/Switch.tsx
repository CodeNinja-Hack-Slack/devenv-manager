import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { GlassCard } from '../components/GlassCard';
import { MagneticButton } from '../components/MagneticButton';
import type { VersionVarInfo } from '../api';

/** 类别展示名称映射（与 scanner.ts / Dashboard.tsx 保持一致） */
const CATEGORY_LABEL: Record<string, string> = {
  java: 'Java', 'build-tool': '构建工具', node: 'Node.js',
  database: '数据库', 'web-server': 'Web 服务', container: '容器', ide: 'IDE', tool: '其他工具',
};
const CAT_ORDER = ['java', 'build-tool', 'node', 'database', 'web-server', 'container', 'ide', 'tool'];

const TOOL_ICON: Record<string, string> = {
  jdk: '☕', maven: '📦', gradle: '🐘', node: '🟢', mysql: '🐬', redis: '🔴',
  git: '🌿', docker: '🐳', go: '🐹', python: '🐍', nginx: '🌐',
};

/** 根据工具标识推导 homeVar */
function deriveHomeVar(tool: string): string {
  const map: Record<string, string> = {
    jdk: 'JAVA_HOME', maven: 'MAVEN_HOME', gradle: 'GRADLE_HOME',
    node: 'NODE_HOME', mysql: 'MYSQL_HOME', redis: 'REDIS_HOME',
    docker: 'DOCKER_HOME', git: 'GIT_HOME',
  };
  return map[tool] ?? `${tool.toUpperCase()}_HOME`;
}

export function SwitchPage() {
  const dashboardTools = useStore((s) => s.dashboardTools);
  const config = useStore((s) => s.config);
  const switchVersion = useStore((s) => s.switchVersion);
  const openFolder = useStore((s) => s.openFolder);
  const activateDetected = useStore((s) => s.activateDetected);
  const loadDashboardTools = useStore((s) => s.loadDashboardTools);
  // 版本变量详情（按 tool 分组的 Map）—— 这是主要数据源，包含 config + 注册表所有版本
  const [versionVarsMap, setVersionVarsMap] = useState<Record<string, VersionVarInfo[]>>({});
  // 展开状态：哪些工具展开显示变量细节
  const [expandedTool, setExpandedTool] = useState<string | null>(null);
  // 切换操作进行中标记——防止快速重复点击导致并发写入 config 覆盖数据
  const [switching, setSwitching] = useState<string | null>(null);

  // 进入页面时确保数据已加载
  useEffect(() => { if (!dashboardTools.length) loadDashboardTools(); }, []);

  // 加载版本变量信息（按需）—— 这是 Switch 页的核心数据源
  useEffect(() => {
    // 收集所有已知 tool 标识：dashboardTools 中的 + config.tools 中的
    const toolSet = new Set<string>();
    dashboardTools.forEach((t) => toolSet.add(t.tool));
    config?.tools?.forEach((t: any) => toolSet.add(t.tool));
    // 确保至少有基础工具列表（即使 dashboardTools 为空）
    const tools = [...toolSet];
    if (tools.length === 0 && dashboardTools.length === 0) return;

    tools.forEach(async (tool) => {
      try {
        const { api } = await import('../api');
        const vars = await api.listVersionVars(tool);
        setVersionVarsMap((prev) => ({ ...prev, [tool]: vars }));
      } catch { /* ignore */ }
    });
  }, [dashboardTools.length, config?.tools?.length]);

  // 按类别分组（基于 versionVarsMap + dashboardTools 的并集）
  // 构建完整的工具列表：每个 tool 取其所有版本变量
  const allToolEntries: { tool: string; name: string; category: string; homeVar: string; vars: VersionVarInfo[] }[] = [];
  for (const [tool, vars] of Object.entries(versionVarsMap)) {
    if (vars.length === 0) continue;
    // 从 dashboardTools 找名称和类别
    const dt = dashboardTools.find((t) => t.tool === tool);
    const ct = config?.tools?.find((t: any) => t.tool === tool);
    const name = dt?.name ?? ct?.name ?? tool.toUpperCase();
    const category = dt?.category ?? ct?.category ?? 'tool';
    const homeVar = ct?.homeVar ?? deriveHomeVar(tool);
    allToolEntries.push({ tool, name, category, homeVar, vars: vars.sort((a, b) => +(b.active) - +(a.active)) });
  }

  // 对于没有版本变量但有 dashboardTools 条目的工具也展示（兜底）
  const coveredTools = new Set(allToolEntries.map((e) => e.tool));
  for (const t of dashboardTools) {
    if (coveredTools.has(t.tool)) continue;
    allToolEntries.push({
      tool: t.tool,
      name: t.name,
      category: t.category,
      homeVar: deriveHomeVar(t.tool),
      vars: [{
        version: t.version,
        path: t.path,
        varName: `${deriveHomeVar(t.tool)}_${t.version.replace(/[.\-+]/g, '_')}`,
        active: t.source === 'installed' ? (t.active ?? false) : false,
        source: t.source === 'installed' ? 'config' : 'registry',
      }],
    });
  }

  // 按类别分组
  const groups = new Map<string, typeof allToolEntries>();
  for (const entry of allToolEntries) {
    const label = CATEGORY_LABEL[entry.category] ?? entry.category;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(entry);
  }
  // 按 CAT_ORDER 排序
  const sortedGroups = [...groups.entries()].sort(
    ([a], [b]) => (CAT_ORDER.indexOf(a) ?? 99) - (CAT_ORDER.indexOf(b) ?? 99),
  );

  // 统计
  const totalTools = allToolEntries.length;
  const totalVersions = allToolEntries.reduce((sum, e) => sum + e.vars.length, 0);
  const totalCats = groups.size;

  const toggleExpand = (key: string) => {
    setExpandedTool(expandedTool === key ? null : key);
  };

  /** 执行版本切换（带防重复点击保护） */
  const handleSwitch = async (entry: typeof allToolEntries[0], v: VersionVarInfo) => {
    // 防止并发切换：同一工具的切换操作互斥，避免并发写入 config 导致数据丢失
    const lockKey = `${entry.tool}@${v.varName}`;
    if (switching === lockKey) return;
    setSwitching(lockKey);
    try {
      if (v.source === 'registry') {
        // 系统/注册表发现、尚未纳管的版本：先「激活」（登记进 config + 建立引用关系）再切换。
        await activateDetected({
          tool: entry.tool,
          name: entry.name,
          category: entry.category,
          version: v.version,
          path: v.path,
          homeVar: entry.homeVar,
          source: 'detected',
        } as any);
      } else {
        // 已纳管版本：直接引用式切换（只改活跃变量的引用目标 %XXX_HOME_x_y%）
        await switchVersion(entry.category, v.version, v.path);
      }
      // 切换后刷新该工具的版本变量列表（更新 active 状态）
      try {
        const { api } = await import('../api');
        const vars = await api.listVersionVars(entry.tool);
        setVersionVarsMap((prev) => ({ ...prev, [entry.tool]: vars }));
      } catch (e: any) {
        console.error('[Switch] 刷新版本变量列表失败:', e?.message ?? e);
      }
    } finally {
      setSwitching(null);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>版本<span className="gradient-text">切换</span></h1>
          <div className="desc">
            引用式版本切换：每个版本拥有固定变量（如 <code className="mono" style={{ fontSize: 12 }}>JAVA_HOME17</code>），
            切换只需改活跃变量的引用目标（如 <code className="mono" style={{ fontSize: 12 }}>JAVA_HOME = %JAVA_HOME17%</code>）。
            PATH 自动跟随，无需手动更新。
          </div>
        </div>
        <div className="row" style={{ gap: 12 }}>
          <GlassCard style={{ padding: '10px 16px' }}>
            <span className="muted small">工具总数</span><br />
            <strong>{totalTools}</strong> 个 · {totalCats} 类别
          </GlassCard>
          <GlassCard style={{ padding: '10px 16px' }}>
            <span className="muted small">版本总数</span><br />
            <strong>{totalVersions}</strong> 个可切换
          </GlassCard>
        </div>
      </div>

      {/* 引用模式说明 */}
      <GlassCard style={{ marginBottom: 16, padding: '14px 18px' }}>
        <div className="row spread" style={{ marginBottom: 6 }}>
          <strong style={{ fontSize: 13 }}>📌 工作原理</strong>
          <button
            className="btn btn-ghost"
            style={{ fontSize: 11, padding: '2px 10px' }}
            onClick={() => toggleExpand('_help')}
          >
            {expandedTool === '_help' ? '收起' : '查看示例'}
          </button>
        </div>
        {expandedTool === '_help' && (
          <div className="muted small" style={{ lineHeight: 1.7, marginTop: 8 }}>
            <div style={{ fontFamily: 'monospace', fontSize: 12, background: 'rgba(0,0,0,0.15)', padding: '10px 14px', borderRadius: 8, margin: '6px 0' }}>
              <div><span style={{ color: '#7dd3fc' }}>// 固定变量：每个安装版本一个，写入后不变</span></div>
              <div>JAVA_HOME8   = E:\Software\Java\Java8\JDK</div>
              <div>JAVA_HOME11  = E:\Software\Java\Java11\JDK</div>
              <div>JAVA_HOME17  = E:\Software\Java\Java17\JDK</div>
              <div style={{ marginTop: 4 }}><span style={{ color: '#fde047' }}>// 活跃变量：只改这个来切换版本</span></div>
              <div>JAVA_HOME     = <span style={{ color: '#86efac' }}>%JAVA_HOME17%</span> &nbsp; ← 当前激活 JDK 17</div>
              <div style={{ marginTop: 4 }}><span style={{ color: '#fda4af' }}>// PATH 使用引用，自动跟随</span></div>
              <div>PATH = ...;<span style={{ color: '#86efac' }}>%JAVA_HOME%</span>\bin;...</div>
            </div>
          </div>
        )}
      </GlassCard>

      {/* 图例 */}
      {totalTools > 0 && (
        <div className="dash-legend row" style={{ gap: 16, marginBottom: 8 }}>
          <span className="row" style={{ gap: 4 }}>
            <span className="badge installed">软件</span>
            <span className="muted small">通过本软件安装/纳管</span>
          </span>
          <span className="row" style={{ gap: 4 }}>
            <span className="badge sys">系统</span>
            <span className="muted small">系统已检测到（未纳管）</span>
          </span>
          <span className="row" style={{ gap: 4 }}>
            <span className="badge ok" style={{ fontSize: 10, padding: '1px 6px' }}>REF</span>
            <span className="muted small">引用模式切换</span>
          </span>
        </div>
      )}

      {sortedGroups.length === 0 && (
        <GlassCard>
          <div className="muted small" style={{ textAlign: 'center', padding: 28 }}>
            尚未检测到任何开发工具。
            <br />
            请先在「环境扫描」页扫描系统，或前往「安装工具」安装所需软件。
          </div>
        </GlassCard>
      )}

      <div className="grid cols-2">
        {sortedGroups.map(([catLabel, entries]) => {
          // 该类别下所有版本的合计数
          const totalVersionsInCat = entries.reduce((sum, e) => sum + e.vars.length, 0);

          return (
            <GlassCard key={catLabel} title={`${catLabel} · ${entries.length} 个工具 · ${totalVersionsInCat} 个版本`} style={{ minHeight: 80 }}>
              {entries.map((entry) => {
                const activeVar = entry.vars.find((v) => v.active);
                const activeRef = activeVar ? `%${activeVar.varName}%` : null;

                return (
                  <div key={entry.tool} style={{ marginBottom: 16 }}>
                    {/* 工具头：名称 + 活跃变量引用 + 版本数 */}
                    <div className="row spread" style={{ marginBottom: 8, alignItems: 'center' }}>
                      <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                        <span className="tool-card-ico" style={{ width: 28, height: 28, fontSize: 15 }}>{TOOL_ICON[entry.tool] ?? '📦'}</span>
                        <strong>{entry.name}</strong>
                        {activeRef && (
                          <span className="muted tiny mono" style={{
                            background: 'rgba(134,237,172,0.1)',
                            border: '1px solid rgba(134,237,172,0.25)',
                            borderRadius: 4,
                            padding: '1px 6px',
                            color: '#86efac',
                          }}>
                            {entry.homeVar} = {activeRef}
                          </span>
                        )}
                        <span className="muted tiny">{entry.vars.length} 个版本</span>
                      </div>
                      {entry.vars.length > 1 && (
                        <button
                          className="btn btn-ghost"
                          style={{ fontSize: 10, padding: '1px 8px' }}
                          onClick={() => toggleExpand(entry.tool)}
                        >
                          {expandedTool === entry.tool ? '收起' : '展开全部'}
                        </button>
                      )}
                    </div>

                    {/* 展开时显示所有版本变量明细 */}
                    {expandedTool === entry.tool && (
                      <div style={{
                        background: 'rgba(0,0,0,0.12)',
                        borderRadius: 8,
                        padding: '8px 12px',
                        marginBottom: 8,
                        fontSize: 12,
                      }}>
                        <div className="muted tiny" style={{ marginBottom: 4 }}>版本固定变量：</div>
                        {entry.vars.map((v) => (
                          <div key={v.varName} className={`row spread ${v.active ? '' : 'muted'}`}
                            style={{ padding: '3px 0', fontSize: 11.5 }}
                          >
                            <span>
                              <span className={`mono ${v.active ? '' : ''}`}
                                style={{ color: v.active ? '#86efac' : undefined }}
                              >
                                {v.varName}
                              </span>
                              {v.active && (
                                <span className="badge ok" style={{ marginLeft: 6, fontSize: 9, padding: '0 4px' }}>
                                  ← {entry.homeVar} 引用此
                                </span>
                              )}
                              {v.source === 'registry' && (
                                <span className="badge sys" style={{ marginLeft: 6, fontSize: 9, padding: '0 4px' }}>注册表</span>
                              )}
                            </span>
                            <span className="mono tiny" title={v.path}>{v.path}</span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 所有版本列表 —— 每个版本一行，可点击切换 */}
                    <div>
                      {entry.vars.map((v) => {
                        const isActive = v.active;
                        return (
                          <div key={`${entry.tool}-${v.varName}`} className="tool-row">
                            <div className="tool-info">
                              <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                                <strong style={{ fontSize: 13 }}>{entry.name}</strong>
                                <span className={`badge ${v.source === 'config' ? 'installed' : 'sys'}`} style={{ fontSize: 11 }}>
                                  {v.source === 'config' ? '软件' : '系统'}
                                </span>
                                {isActive && <span className="badge active">当前默认</span>}
                                <span className="badge ok" style={{ fontSize: 9, padding: '0 5px' }}>REF</span>
                              </div>
                              <div className="row" style={{ gap: 8, alignItems: 'center' }}>
                                <span className="mono small" style={{ fontWeight: 600 }}>{v.version}</span>
                                <span className="mono xsmall muted"
                                  style={{
                                    color: isActive ? '#86efac' : 'rgba(134,237,172,0.5)',
                                    fontWeight: isActive ? 600 : 400,
                                  }}
                                  title={`${v.varName} = ${v.path}`}
                                >
                                  {v.varName}
                                </span>
                              </div>
                              <div className="mono tiny path-text" title={v.path}>{v.path}</div>
                            </div>

                            <div className="tool-actions">
                              <span title={isActive
                                ? '已是当前默认版本'
                                : `切换至 ${v.version}（${entry.homeVar} → %${v.varName}%）`}
                              >
                                <MagneticButton
                                  className={`btn ${isActive ? 'btn-ghost' : ''}`}
                                  disabled={isActive || switching !== null}
                                  onClick={() => handleSwitch(entry, v)}
                                >
                                  {switching === `${entry.tool}@${v.varName}` ? '切换中…' : (isActive ? '当前默认' : '切换')}
                                </MagneticButton>
                              </span>
                              {v.path && (
                                <button className="icon-btn" title="打开安装目录所在文件夹" onClick={() => openFolder(v.path)}>📂 打开</button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </GlassCard>
          );
        })}
      </div>
    </>
  );
}
