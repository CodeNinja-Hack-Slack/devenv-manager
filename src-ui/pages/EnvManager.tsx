import { useEffect, useState } from 'react';
import { api, type EnvInspectResult, type EnvToolVar, type EnvVarEntry } from '../api';
import { GlassCard } from '../components/GlassCard';
import { useStore } from '../store/useStore';

// 工具图标（与 Dashboard / Scanner / Switch 保持一致）
const TOOL_ICON: Record<string, string> = {
  jdk: '☕',
  maven: '📦',
  gradle: '🐘',
  node: '🟢',
  mysql: '🐬',
  redis: '🔴',
  git: '🌿',
  docker: '🐳',
  go: '🐹',
  python: '🐍',
  nginx: '🌐',
};

const SRC_LABEL: Record<EnvVarEntry['source'], string> = {
  user: '用户',
  system: '系统',
  process: '进程',
  none: '未设置',
};

function srcBadgeClass(src: EnvVarEntry['source']): string {
  switch (src) {
    case 'system':
      return 'sys';
    case 'user':
      return 'warn';
    case 'process':
      return 'ok';
    default:
      return '';
  }
}

function VarRow({ entry, sub }: { entry: EnvVarEntry; sub?: boolean }) {
  return (
    <div className={`env-var${sub ? ' sub' : ''}`}>
      <div className="env-var-key mono">{entry.key}</div>
      <div className="env-var-val">
        {entry.source === 'none' ? (
          <span className="muted">未设置</span>
        ) : (
          <>
            <code>{entry.effective}</code>
            {entry.expanded && entry.expanded !== entry.effective && (
              <span className="env-var-exp">→ {entry.expanded}</span>
            )}
          </>
        )}
      </div>
      <span className={`badge ${srcBadgeClass(entry.source)}`}>{SRC_LABEL[entry.source]}</span>
    </div>
  );
}

function ToolEnvCard({ t }: { t: EnvToolVar }) {
  const ico = TOOL_ICON[t.tool] ?? '📦';
  return (
    <GlassCard className="env-tool">
      <div className="env-tool-head">
        <span className="tool-card-ico" style={{ width: 32, height: 32, fontSize: 17 }}>
          {ico}
        </span>
        <div className="env-tool-meta">
          <div className="env-tool-name">{t.name}</div>
          <div className="muted small">{t.tool}</div>
        </div>
        <span className="mono env-homevar">{t.homeVar}</span>
      </div>
      <VarRow entry={t.entry} />
      {t.versionEntries.map((v) => (
        <VarRow key={v.key} entry={v} sub />
      ))}
    </GlassCard>
  );
}

export function EnvManager() {
  const [data, setData] = useState<EnvInspectResult | null>(null);
  const [loading, setLoading] = useState(false);
  const isDesktop = useStore((s) => s.isDesktop);

  const load = async () => {
    setLoading(true);
    try {
      setData(await api.envInspect());
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="page env-page">
      <div className="page-head">
        <div>
          <h1>
            环境<span className="gradient-text">变量</span>
          </h1>
          <div className="desc">
            仅展示 devenv 管理的开发工具所牵扯的环境变量（HOME 变量与 PATH 注入段），其余系统变量已隐藏
          </div>
        </div>
        <button className="btn ghost" onClick={load} disabled={loading}>
          {loading ? '刷新中…' : '↻ 刷新'}
        </button>
      </div>

      {!data && (
        <GlassCard>
          <div className="muted small">加载中…</div>
        </GlassCard>
      )}

      {data && data.tools.length === 0 && (
        <GlassCard>
          <div className="empty-state">
            <div className="e-ico">📭</div>
            <div className="e-title">暂无可展示的环境变量</div>
            <div className="muted small">尚未纳管任何开发工具，或系统中未检测到相关 HOME 变量</div>
          </div>
        </GlassCard>
      )}

      {data && data.tools.length > 0 && (
        <div className="env-list">
          {data.tools.map((t) => (
            <ToolEnvCard key={t.tool} t={t} />
          ))}
        </div>
      )}

      {data && (
        <GlassCard className="env-path">
          <div className="env-path-head">
            <h3>
              PATH <span className="muted small">（仅显示 devenv 注入的段）</span>
            </h3>
            <span className="muted small">
              共 {data.path.total} 段 · 其中 {data.path.oursCount} 段由 devenv 注入
            </span>
          </div>
          <div className="path-segs">
            {data.path.segments.length === 0 ? (
              <div className="muted small">未发现由 devenv 注入的 PATH 段</div>
            ) : (
              data.path.segments.map((s, i) => (
                <div key={i} className="path-seg ours">
                  <code className="path-seg-raw">{s.raw}</code>
                  {s.homeVar && <span className="path-seg-tag mono">{s.homeVar}</span>}
                  {s.expanded && s.expanded !== s.raw && (
                    <span className="path-seg-exp muted small">→ {s.expanded}</span>
                  )}
                </div>
              ))
            )}
          </div>
          {!isDesktop && (
            <div className="muted small env-note">
              浏览器预览为演示数据；桌面端将读取你系统的真实注册表（HKCU / HKLM）并自动过滤无关变量
            </div>
          )}
        </GlassCard>
      )}
    </div>
  );
}
