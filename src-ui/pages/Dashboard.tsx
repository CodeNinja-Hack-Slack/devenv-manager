import React from 'react';
import { useStore } from '../store/useStore';
import { GlassCard } from '../components/GlassCard';
import { MagneticButton } from '../components/MagneticButton';

// 类别展示名与排序（UI 不能引用引擎 scanner，故在此镜像一份）
const CAT_LABEL: Record<string, string> = {
  java: 'Java',
  'build-tool': '构建工具',
  node: 'Node.js',
  python: 'Python',
  go: 'Go',
  database: '数据库',
  'web-server': 'Web 服务',
  container: '容器',
  ide: 'IDE',
  tool: '其他工具',
};
const CAT_ORDER = ['java', 'build-tool', 'node', 'python', 'go', 'database', 'web-server', 'container', 'ide', 'tool'];
const catLabel = (c: string) => CAT_LABEL[c] ?? c;

// 工具图标（提升可读性，弱化纯文字行）
const TOOL_ICON: Record<string, string> = {
  jdk: '☕', maven: '📦', gradle: '🐘', node: '🟢', mysql: '🐬', redis: '🔴',
  git: '🌿', docker: '🐳', go: '🐹', python: '🐍', nginx: '🌐',
};
const toolIcon = (t: string) => TOOL_ICON[t] ?? '📦';

export function Dashboard() {
  const config = useStore((s) => s.config);
  const currentTools = useStore((s) => s.currentTools);
  const setPage = useStore((s) => s.setPage);
  const isDesktop = useStore((s) => s.isDesktop);
  const openFolder = useStore((s) => s.openFolder);

  // 按类别分组（合并来源：已纳管 + 系统已检测），同类内已纳管优先
  const groups = React.useMemo(() => {
    const map = new Map<string, any[]>();
    for (const t of currentTools) {
      if (!map.has(t.category)) map.set(t.category, []);
      map.get(t.category)!.push(t);
    }
    const ordered = [...map.keys()].sort((a, b) => {
      const ia = CAT_ORDER.indexOf(a), ib = CAT_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    return ordered.map((cat) => ({
      cat,
      items: map.get(cat)!.sort((x: any, y: any) =>
        x.source !== y.source ? (x.source === 'installed' ? -1 : 1) : x.name.localeCompare(y.name),
      ),
    }));
  }, [currentTools]);

  const catCount = new Set(currentTools.map((t) => t.category)).size;

  return (
    <>
      <div className="dash-hero">
        <div className="dash-hero-text">
          <h2>开发环境一览</h2>
        <p>
          统一管理你的 <b>{currentTools.length}</b> 个在用开发工具 · 在线/离线双模式安装 · 多版本共存一键切换
        </p>
        </div>
      </div>

      {!isDesktop && (
        <div className="glass card mt" style={{ borderColor: 'rgba(255,207,107,0.3)' }}>
          <span className="badge warn">预览模式</span> 当前在浏览器中预览，系统级操作（扫描/安装/环境变量）需通过桌面端 Electron 运行。
        </div>
      )}

      <div className="grid cols-3 mt">
        <GlassCard className="stat">
          <div className="value">{currentTools.length}</div>
          <div className="label">当前使用工具</div>
          <div className="kpi-accent" />
        </GlassCard>
        <GlassCard className="stat">
          <div className="value">{catCount}</div>
          <div className="label">工具类别</div>
          <div className="kpi-accent" />
        </GlassCard>
        <GlassCard className="stat">
          <div className="value">{config?.rootDir ? '✓' : '—'}</div>
          <div className="label">统一根目录</div>
          <div className="kpi-accent" />
        </GlassCard>
      </div>

      <div className="grid cols-dash mt">
        <div>
          <div className="row spread" style={{ marginBottom: 12 }}>
            <h3 className="card-title" style={{ margin: 0 }}>当前使用中的工具</h3>
            <div className="dash-legend">
              <span className="lg"><span className="dot inst" />软件默认</span>
              <span className="lg"><span className="dot sys" />系统 PATH</span>
            </div>
          </div>

          {currentTools.length === 0 && (
            <div className="empty-state glass">
              <div className="e-ico">📭</div>
              <div className="e-title">暂无正在使用的工具</div>
              <div className="small">去“安装工具”开始，或到“环境扫描”纳管已有软件。</div>
            </div>
          )}

          {groups.map((g) => (
            <div className="cat-card" key={g.cat} style={{ marginBottom: 14 }}>
              <div className="cat-card-head">
                <span className="cat-dot" />
                {catLabel(g.cat)}
                <span className="count">{g.items.length}</span>
              </div>
              <div className="cat-tools">
                {g.items.map((t: any) => (
                  <div className="tool-card" key={`${t.source}-${t.tool}-${t.version}-${t.path}`}>
                    <div className="tool-card-top">
                      <span className="tool-card-ico">{toolIcon(t.tool)}</span>
                      <span className="tool-card-name" title={t.name}>{t.name}</span>
                      <span className={`status-dot ${t.using === 'managed' ? 'managed' : 'sys'}`}
                        title={t.using === 'managed' ? '软件默认' : '系统 PATH'} />
                    </div>
                    <div className="tool-card-meta">
                      <span className="ver-chip">{t.version}</span>
                      {t.using === 'managed' ? (
                        <>
                          <span className={`badge ${t.mode === 'online' ? 'ok' : t.mode === 'external' ? 'sys' : 'warn'}`}>
                            {t.mode === 'online' ? '在线' : t.mode === 'external' ? '外部' : '离线'}
                          </span>
                          <span className="badge active">默认</span>
                        </>
                      ) : (
                        <span className="badge sys">系统 PATH</span>
                      )}
                    </div>
                    {t.path && <div className="tool-card-path" title={t.path}>{t.path}</div>}
                    <div className="tool-card-foot">
                      <span className="muted small">{t.path ? '已安装' : '—'}</span>
                      {t.path && (
                        <button className="icon-btn" title="打开安装目录所在文件夹" onClick={() => openFolder(t.path)}>
                          📂 打开
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <GlassCard title="快捷操作">
          <div className="quick-actions">
            <button className="quick-btn" onClick={() => setPage('scanner')}>
              <span className="q-ico">🗂</span> 软件管理
            </button>
            <button className="quick-btn" onClick={() => setPage('scanner')}>
              <span className="q-ico">🔍</span> 扫描环境
            </button>
            <button className="quick-btn" onClick={() => setPage('switch')}>
              <span className="q-ico">⇄</span> 切换版本
            </button>
            <button className="quick-btn" onClick={() => setPage('profiles')}>
              <span className="q-ico">🗂</span> 配置方案
            </button>
            <MagneticButton className="quick-btn" onClick={() => setPage('install')}>
              <span className="q-ico">⬇</span> 安装新工具
            </MagneticButton>
          </div>
          <div className="mt muted small">
            根目录：<span className="mono">{config?.rootDir ?? '未配置'}</span>
          </div>
        </GlassCard>
      </div>
    </>
  );
}
