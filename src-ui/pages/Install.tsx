import React, { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { GlassCard } from '../components/GlassCard';
import { MagneticButton } from '../components/MagneticButton';
import { PathPromptModal } from '../components/PathPromptModal';
import { api, type RecognizedPackage, type InstallPlanUI, type StepPlanUI, type StepPreviewUI } from '../api';
import { join, DATA_DIR } from '../../src/utils/path';

const TOOLS = ['jdk', 'maven', 'gradle', 'node', 'mysql', 'redis', 'git', 'docker', 'go', 'python', 'nginx'];

/** 仅纳管型工具（无可行便携包，需用户先自行安装再用「扫描」纳管），安装页禁用自动安装 */
const MANAGED_ONLY = new Set(['docker']);

/** 竖向时间线中单个步骤的视图状态 */
interface StepView {
  id: string;
  title: string;
  description?: string;
  optional?: boolean;
  status: 'pending' | 'running' | 'done' | 'warn' | 'error';
  message?: string;
}

/** 取版本的首个数字段作为“大版本”：17.0.9 → 17，8u392 → 8，v18.20.4 → 18 */
function majorOf(version: string): string {
  const m = version.match(/\d+/);
  return m ? m[0] : version;
}
function toolLabel(tool: string): string {
  const map: Record<string, string> = {
    jdk: 'JDK', maven: 'Maven', gradle: 'Gradle', node: 'Node.js',
    mysql: 'MySQL', redis: 'Redis', git: 'Git', docker: 'Docker',
  };
  return map[tool] ?? tool.toUpperCase();
}

export function Install() {
  const [mode, setMode] = useState<'online' | 'offline'>('online');
  const [tool, setTool] = useState('jdk');
  const [version, setVersion] = useState('');
  const [major, setMajor] = useState('');
  const [localPath, setLocalPath] = useState('');
  // 需求 #4：允许用户为本次安装指定「精确的目标安装文件夹」（与全局 installDir/下载目录相互独立）
  const [targetDir, setTargetDir] = useState('');
  /** Maven/Gradle 安装时是否启用国内镜像（阿里云），由界面勾选 */
  const [useMirror, setUseMirror] = useState(false);
  const [recognized, setRecognized] = useState<RecognizedPackage | null>(null);
  const [versions, setVersions] = useState<string[]>([]);
  /** 步骤时间线：每个步骤的实时状态（由引擎进度事件驱动） */
  const [steps, setSteps] = useState<StepView[]>([]);
  const [percent, setPercent] = useState(0);
  const [busy, setBusy] = useState(false);
  // 路径询问弹窗状态
  const [promptOpen, setPromptOpen] = useState(false);
  // 规划模式（先规划后执行）状态
  const [plan, setPlan] = useState<InstallPlanUI | null>(null);
  const [stepValues, setStepValues] = useState<Record<string, Record<string, any>>>({});
  const [showPlan, setShowPlan] = useState(false);
  const [planDownloadDir, setPlanDownloadDir] = useState('');
  const [planTargetDir, setPlanTargetDir] = useState('');
  const { installOnline, installOffline, planInstall, saveSettings, toast, isDesktop, rootDir, config } = useStore((s) => ({
    installOnline: s.installOnline,
    installOffline: s.installOffline,
    planInstall: s.planInstall,
    saveSettings: s.saveSettings,
    toast: s.toast,
    isDesktop: s.isDesktop,
    rootDir: s.rootDir,
    config: s.config,
  }));

  // 在线：精确版本列表；离线：由版本推导“大版本”
  useEffect(() => {
    api.listRemote(tool).then((v) => {
      setVersions(v);
      setVersion(v[0] ?? '');
      setMajor(majorOf(v[0] ?? '1.0.0'));
    });
    setRecognized(null);
    // 切换工具时重置「国内镜像」选项（仅 Maven/Gradle 适用，避免串味）
    setUseMirror(false);
  }, [tool]);

  const majors = Array.from(new Set(versions.map(majorOf)));
  const recMajor = recognized?.version ? majorOf(recognized.version) : '';
  const majorOptions = Array.from(new Set([...majors, ...(recMajor ? [recMajor] : [])])).sort(
    (a, b) => Number(a) - Number(b),
  );

  const pick = async () => {
    const p = await api.pickFile();
    if (!p) return;
    setLocalPath(p);
    const rec = await api.recognize(p);
    setRecognized(rec);
    if (rec) {
      // 识别到工具且可选项内 → 自动选中，减少用户操作
      if (TOOLS.includes(rec.tool)) setTool(rec.tool);
      if (rec.version) {
        const rm = majorOf(rec.version);
        if (rm) setMajor(rm);
      }
    }
  };


  // 离线模式下最终用于落盘的版本（预览用，真实以引擎识别为准）
  const offlineResolved = recognized?.version ?? major;

  // 预览：实际生效的版本与安装基目录（与引擎路径规划一致）
  const resolvedVersion = mode === 'offline' ? offlineResolved : version;
  const installBase =
    config?.installDir?.trim() || (rootDir ? join(rootDir, DATA_DIR, 'install') : '');

  // 弹窗预填：下载默认目录（config 已有值优先，否则回落 <rootDir>/data/download）
  const defaultDownload = (config?.downloadDir && config.downloadDir.trim()) || (rootDir ? join(rootDir, DATA_DIR, 'download') : '');
  // 弹窗预填：本次精确安装文件夹的默认派生路径（<基目录>/<类别>/<工具><版本>）
  const defaultTargetDir = installBase ? join(installBase, catOf(tool), `${tool}${resolvedVersion}`) : '';
  // 概览卡预览用的目标文件夹（弹窗确认后以具体选择为准，否则用派生默认）
  const previewTarget = targetDir.trim() || defaultTargetDir;

  // 接收引擎透传的真实步骤进度，更新竖向时间线（事件驱动，无假进度条）
  const onProgress = (p: any) => {
    setPercent(typeof p.percent === 'number' ? p.percent : 0);
    if (p.phase === 'plan' && Array.isArray(p.plan)) {
      // 安装开始前先渲染完整步骤计划骨架（含作用说明），让用户一开始就看清全貌
      setSteps(
        p.plan.map((s: any) => ({
          id: s.id,
          title: s.title,
          description: s.description,
          optional: !!s.optional,
          status: 'pending' as const,
          message: '',
        })),
      );
    } else if (p.phase === 'step' && p.stepId != null) {
      setSteps((prev) => {
        const total = p.totalSteps ?? prev.length;
        // 若还没有骨架（未收到 plan 事件），按 total 预建占位
        const base = prev.length
          ? prev.slice()
          : Array.from({ length: total }, () => ({ id: '', title: '', status: 'pending' as const, message: '' }));
        const idx = typeof p.stepIndex === 'number' ? p.stepIndex : base.findIndex((s) => s.id === p.stepId);
        if (idx >= 0 && idx < base.length) {
          base[idx] = {
            id: p.stepId,
            title: p.stepTitle ?? p.stepId,
            description: p.stepDescription,
            optional: prev[idx]?.optional,
            status: p.stepStatus ?? 'running',
            message: p.message,
          };
        }
        return base;
      });
    } else if (p.phase === 'done') {
      setSteps((prev) => prev.map((s) => (s.status === 'pending' || s.status === 'running' ? { ...s, status: 'done' as const } : s)));
    } else if (p.phase === 'rollback') {
      setSteps((prev) => prev.map((s) => (s.status === 'running' ? { ...s, status: 'error' as const, message: p.message } : s)));
    }
  };

  /** 真正执行安装；overrides 为单次路径/参数覆盖（不持久化） */
  const doInstall = async (overrides?: { downloadDir?: string; installDir?: string; targetDir?: string; stepParams?: Record<string, Record<string, any>> }) => {
    setBusy(true);
    setSteps([]);
    setPercent(0);
    // 本次精确目标目录（targetDir）优先用覆盖参数（来自弹窗/规划视图），否则用页面状态；
    // 与全局 installDir/下载目录相互独立。仅 Maven/Gradle 勾选国内镜像时带 useMirror。
    const merged = {
      ...(overrides ?? {}),
      targetDir: (overrides?.targetDir ?? targetDir).trim() || undefined,
      useMirror: tool === 'maven' || tool === 'gradle' ? useMirror : undefined,
      stepParams: overrides?.stepParams,
    };
    try {
      if (mode === 'online') await installOnline(tool, version, merged, onProgress);
      else {
        await installOffline(
          tool,
          { majorVersion: major || undefined, localPath, ...merged } as any,
          onProgress,
        );
      }
    } finally {
      // 安装结束后稍作停留，让用户看清最终步骤状态，再复位忙碌态
      setTimeout(() => {
        setBusy(false);
      }, 600);
    }
  };

  /** 进入规划视图：调用 planInstall 拿到完整步骤计划（参数 + 预览），不触碰系统 */
  const openPlan = async (downloadDir?: string, target?: string) => {
    setBusy(true);
    try {
      const r = await planInstall(tool, version, {
        mode,
        downloadDir: downloadDir || undefined,
        targetDir: (target ?? targetDir).trim() || undefined,
        useMirror: tool === 'maven' || tool === 'gradle' ? useMirror : undefined,
        majorVersion: mode === 'offline' ? major || undefined : undefined,
        localPath: mode === 'offline' ? localPath : undefined,
      });
      if (!r.ok || !r.plan) {
        toast(`规划失败：${r.error ?? '未知错误'}`, 'err');
        return;
      }
      // 用计划里每步的默认参数初始化可编辑值
      const init: Record<string, Record<string, any>> = {};
      for (const s of r.plan.steps) {
        init[s.id] = Object.fromEntries(s.params.map((p) => [p.key, p.value]));
      }
      setPlan(r.plan);
      setStepValues(init);
      setPlanDownloadDir(downloadDir || '');
      // 目标目录始终以 plan.destDir 为基准，用户可改；空时回退到 plan.destDir
      setPlanTargetDir(target || r.plan.destDir || '');
      setShowPlan(true);
    } finally {
      setBusy(false);
    }
  };

  /** 规划视图「执行安装」：带用户编辑后的步骤参数 + 路径，真正安装 */
  const executePlan = async () => {
    setShowPlan(false);
    await doInstall({ downloadDir: planDownloadDir || undefined, targetDir: planTargetDir || undefined, stepParams: stepValues });
  };

  /** 规划视图「取消」：什么都不做，关闭规划视图 */
  const cancelPlan = () => {
    setShowPlan(false);
    setPlan(null);
    setStepValues({});
  };

  /** 编辑某步骤的某个参数值（仅停留在规划阶段，不触碰系统） */
  const setStepValue = (stepId: string, key: string, value: string | boolean) => {
    setStepValues((prev) => ({ ...prev, [stepId]: { ...(prev[stepId] ?? {}), [key]: value } }));
  };

  /**
   * 规划视图参数/目标目录变化时，debounce 重新调用 planInstall 计算预览。
   * 这样用户改 node_global/node_cache 后，下方 CMD 与 DIR 预览实时跟着变。
   */
  useEffect(() => {
    if (!showPlan) return;
    const timer = setTimeout(async () => {
      const r = await planInstall(tool, version, {
        mode,
        downloadDir: planDownloadDir || undefined,
        targetDir: planTargetDir.trim() || undefined,
        useMirror: tool === 'maven' || tool === 'gradle' ? useMirror : undefined,
        majorVersion: mode === 'offline' ? major || undefined : undefined,
        localPath: mode === 'offline' ? localPath : undefined,
        stepParams: stepValues,
      });
      if (r.ok && r.plan) {
        setPlan(r.plan);
      }
    }, 200);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepValues, planTargetDir, showPlan, tool, version, mode, planDownloadDir, useMirror, major, localPath]);

  const run = async () => {
    if (MANAGED_ONLY.has(tool)) {
      return toast(`${toolLabel(tool)} 为「仅纳管」工具，请先安装后再用「扫描」功能纳管`, 'err');
    }
    if (mode === 'offline') {
      if (!localPath) return toast('请选择本地安装包', 'err');
      if (!major && !recognized?.version)
        return toast('请选择大版本（如 JDK 17），或确保文件名包含版本号', 'err');
    } else if (!version) {
      return toast('请选择版本', 'err');
    }
    if (!rootDir) return toast('请先在“设置”中指定安装根目录', 'err');

    // 已关闭路径询问（用户曾勾选“记住默认路径”）：直接用默认路径进入规划视图（仍不立即执行）
    if (config?.pathPromptEnabled === false) {
      await openPlan();
      return;
    }
    // 否则每次操作主动询问下载/安装路径，确认后再进入规划视图
    setPromptOpen(true);
  };

  const onConfirmPrompt = async (r: { downloadDir: string; targetDir: string; remember: boolean }) => {
    setPromptOpen(false);
    setTargetDir(r.targetDir || ''); // 同步到状态，供概览卡预览
    if (r.remember) {
      // 记住默认：把本次下载目录持久化到配置，并关闭路径询问（pathPromptEnabled=false），后续不再弹窗
      const next = { ...config, downloadDir: r.downloadDir || undefined, pathPromptEnabled: false };
      await saveSettings(next);
    }
    // 无论是否记住，都先进入规划视图（不立即执行）
    await openPlan(r.downloadDir, r.targetDir);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>安装<span className="gradient-text">工具</span></h1>
          <div className="desc">在线自动下载 或 离线本地安装包，均落入统一目录并自动配置环境变量</div>
        </div>
        <div className="seg">
          <button className={mode === 'online' ? 'on' : ''} onClick={() => setMode('online')}>在线安装</button>
          <button className={mode === 'offline' ? 'on' : ''} onClick={() => setMode('offline')}>离线安装</button>
        </div>
      </div>

      <div className="grid cols-2">
        <GlassCard title={mode === 'online' ? '在线安装' : '离线安装'}>
          <div className="field">
            <label>工具</label>
            <select className="select" value={tool} onChange={(e) => setTool(e.target.value)}>
              {TOOLS.map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>

          {mode === 'online' ? (
            <>
              <div className="field">
                <label>版本</label>
                <select className="select" value={version} onChange={(e) => setVersion(e.target.value)}>
                  {versions.map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label>大版本</label>
                <select className="select" value={major} onChange={(e) => setMajor(e.target.value)}>
                  {majorOptions.map((m) => (
                    <option key={m} value={m}>{toolLabel(tool)} {m}</option>
                  ))}
                </select>
                <div className="muted small mt">离线安装只需选大版本，具体版本由安装包自动识别</div>
              </div>
              <div className="field">
                <label>本地安装包</label>
                <div className="row">
                  <input
                    className="input"
                    style={{ flex: 1 }}
                    placeholder={isDesktop ? '点击选择文件' : 'C:\\...\\jdk-17.0.9.zip'}
                    value={localPath}
                    onChange={(e) => setLocalPath(e.target.value)}
                  />
                  <MagneticButton className="btn" onClick={pick} disabled={!isDesktop}>
                    选择
                  </MagneticButton>
                </div>
                {recognized ? (
                  <div className="muted small mt">
                    识别结果：<b>{recognized.name}</b> {recognized.version}
                    {recognized.version !== offlineResolved ? `（将按 ${offlineResolved} 落盘）` : ''} · {recognized.format}
                  </div>
                ) : (
                  <div className="muted small mt">支持自动识别类型与版本（来自文件名，如 jdk-17.0.9）</div>
                )}
              </div>
            </>
          )}

          {(tool === 'maven' || tool === 'gradle') && !MANAGED_ONLY.has(tool) && (
            <div className="field">
              <label className="opt-label">
                <input
                  type="checkbox"
                  checked={useMirror}
                  onChange={(e) => setUseMirror(e.target.checked)}
                />
                <span>使用国内镜像（阿里云）加速依赖下载</span>
              </label>
              <div className="muted small mt">
                安装后将写入 {tool === 'maven' ? '~/.m2/settings.xml' : '~/.gradle/init.gradle'} 的阿里云镜像配置，
                使依赖从 maven.aliyun.com 获取，大幅提升下载速度。
              </div>
            </div>
          )}

          {busy && (
            <div className="field">
              <label>安装进度 {percent}%</label>
              <div className="progress">
                <i style={{ width: `${percent}%` }} />
              </div>
              <div className="step-timeline mt">
                {steps.length === 0 && (
                  <div className="step step-pending">
                    <span className="step-dot" />
                    <div className="step-body">
                      <div className="step-title">准备中…</div>
                    </div>
                  </div>
                )}
                {steps.map((s, i) => (
                  <div className={`step step-${s.status}`} key={s.id || i}>
                    <span className="step-dot" />
                    <div className="step-body">
                      <div className="step-title">
                        {s.title || `步骤 ${i + 1}`}
                        {s.optional && <span className="step-optional">可选</span>}
                      </div>
                      {s.description && <div className="step-desc">{s.description}</div>}
                      {s.message && <div className="step-msg">{s.message}</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {MANAGED_ONLY.has(tool) && (
            <div className="field">
              <div className="muted small" style={{ padding: '12px 14px', border: '1px dashed var(--border)', borderRadius: 12, lineHeight: 1.7 }}>
                🔧 <b>{toolLabel(tool)}</b> 为「仅纳管」工具：没有可自动下载的便携包（Docker Desktop 为独立安装器）。<br />
                请先安装 {toolLabel(tool)}，再到「扫描」页发现并纳管，本页不提供自动安装。
              </div>
            </div>
          )}

          <MagneticButton className="btn primary" onClick={run} disabled={busy || MANAGED_ONLY.has(tool)}>
            {busy ? '安装中…' : '开始安装'}
          </MagneticButton>
        </GlassCard>

        <GlassCard title="统一目录预览">
          <div className="muted small">安装后将落在：</div>
          <div className="mono mt" style={{ lineHeight: 1.9, wordBreak: 'break-all', overflowWrap: 'anywhere' }}>
            {previewTarget ? (
              <>{previewTarget}<div className="muted small mt">（本次精确安装文件夹，可在安装前弹窗中修改）</div></>
            ) : (
              <span className="muted">（请在“设置”中指定安装根目录后显示）</span>
            )}
          </div>
          <div className="muted small mt">
            目录结构：<span className="mono">&lt;安装基目录&gt;/{catOf(tool)}/{tool}{resolvedVersion}</span>
            <br />
            多版本按版本号区分、互不冲突（如 {tool}8 与 {tool}17 并存）
          </div>
          <hr style={{ borderColor: 'var(--border)', margin: '18px 0' }} />
          <div className="muted small">
            安装完成后自动：<br />
            · 设置 {homeVarOf(tool)} 指向安装目录<br />
            · 将 bin 目录追加到 PATH<br />
            · 写入 devenv.yaml 并加入 cache
          </div>
        </GlassCard>
      </div>

      <PathPromptModal
        open={promptOpen}
        defaultDownload={defaultDownload}
        defaultTarget={defaultTargetDir}
        toolName={toolLabel(tool)}
        toolVersion={resolvedVersion}
        onConfirm={onConfirmPrompt}
        onCancel={() => setPromptOpen(false)}
      />

      {/* 规划视图：先规划后执行。未点「执行安装」前，系统不会做任何改动 */}
      {showPlan && plan && (
        <div className="modal-backdrop" onClick={cancelPlan}>
          <div className="plan-modal" onClick={(e) => e.stopPropagation()}>
            <div className="plan-head">
              <div>
                <h2>安装规划 · {plan.name} {plan.version}</h2>
                <div className="plan-safety">
                  <span className="plan-safety-dot" />
                  <span>未点击「执行安装」前，系统不会做任何改动；点「取消」即可安全退出。</span>
                </div>
                <div className="muted small mt">
                  下图为本次安装将执行的<b>全部步骤</b>与<b>变更预览</b>。
                </div>
              </div>
              <button className="modal-x" onClick={cancelPlan} aria-label="关闭">✕</button>
            </div>

            <div className="plan-scroll">
              {/* 目标目录（规划阶段可改） */}
              <div className="plan-dest">
                <label>本次安装目录（落盘位置）</label>
                <div className="dir-row">
                  <input
                    className="input"
                    value={planTargetDir}
                    placeholder={plan.destDir}
                    onChange={(e) => setPlanTargetDir(e.target.value)}
                    onBlur={() => {
                      if (!planTargetDir.trim() && plan?.destDir) setPlanTargetDir(plan.destDir);
                    }}
                  />
                  <MagneticButton
                    className="btn ghost"
                    onClick={async () => {
                      const p = await api.pickFolder();
                      if (p) setPlanTargetDir(p);
                    }}
                  >
                    选择文件夹
                  </MagneticButton>
                </div>
                <div className="muted small mt">
                  工具最终安装到该文件夹；可改为任意空目录或新路径。
                </div>
              </div>

              {plan.steps.map((s, idx) => (
                <div className={`plan-step${s.optional ? ' optional' : ''}`} key={s.id || idx}>
                  <div className="plan-step-head">
                    <span className="plan-step-idx">{idx + 1}</span>
                    <span className="plan-step-title">{s.title}</span>
                    {s.optional && <span className="step-optional">可选</span>}
                  </div>
                  {s.description && <div className="step-desc">{s.description}</div>}

                  {/* 可编辑参数（如 node_global / node_cache / MySQL 数据目录等） */}
                  {s.params.length > 0 && (
                    <div className="plan-params">
                      {s.params.map((p) => (
                        <div className="plan-param" key={p.key}>
                          <label>{p.label}</label>
                          {p.type === 'checkbox' ? (
                            <input
                              type="checkbox"
                              checked={!!stepValues[s.id]?.[p.key]}
                              onChange={(e) => setStepValue(s.id, p.key, e.target.checked)}
                            />
                          ) : p.type === 'path' ? (
                            <div className="dir-row">
                              <input
                                className="input"
                                type="text"
                                value={(stepValues[s.id]?.[p.key] ?? '') as string}
                                placeholder={p.placeholder}
                                onChange={(e) => setStepValue(s.id, p.key, e.target.value)}
                              />
                              <MagneticButton
                                className="btn ghost"
                                onClick={async () => {
                                  const folder = await api.pickFolder();
                                  if (folder) setStepValue(s.id, p.key, folder);
                                }}
                              >
                                选择文件夹
                              </MagneticButton>
                            </div>
                          ) : (
                            <input
                              className="input"
                              type="text"
                              style={{ width: '100%' }}
                              value={(stepValues[s.id]?.[p.key] ?? '') as string}
                              placeholder={p.placeholder}
                              onChange={(e) => setStepValue(s.id, p.key, e.target.value)}
                            />
                          )}
                          {p.hint && <div className="muted small mt">{p.hint}</div>}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* 变更预览 */}
                  <PlanPreview p={s.preview} />
                </div>
              ))}
            </div>

            <div className="plan-foot">
              <MagneticButton className="btn ghost" onClick={() => exportPlanJson(plan)}>导出 JSON</MagneticButton>
              <MagneticButton className="btn" onClick={cancelPlan}>取消（不安装）</MagneticButton>
              <MagneticButton className="btn primary" onClick={executePlan}>执行安装</MagneticButton>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/** 导出规划结果为 JSON（纯前端 Blob 下载，不触碰系统环境变量/注册表/PATH；零新增 IPC） */
function exportPlanJson(plan: InstallPlanUI) {
  if (!plan) return;
  const json = JSON.stringify(plan, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `devenv-plan-${plan.tool}-${plan.version}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** 单步骤的「变更预览」区块：环境 / 文件 / 目录 / 命令 / 说明，分区展示 */
function PlanPreview({ p }: { p: StepPreviewUI }) {
  if (!p) return null;
  const has =
    (p.envOps && p.envOps.length) ||
    (p.files && p.files.length) ||
    (p.dirs && p.dirs.length) ||
    (p.commands && p.commands.length) ||
    (p.notes && p.notes.length);
  if (!has) return null;
  return (
    <div className="plan-preview">
      <div className="plan-preview-title">本步骤将产生以下变更：</div>
      {p.envOps?.map((e, i) => (
        <div className="pv-row" key={`env${i}`}>
          <span className="pv-kind env">{e.kind}</span>
          <span className="pv-text">{e.name}{e.value ? ` = ${e.value}` : ''}</span>
        </div>
      ))}
      {p.files?.map((f, i) => (
        <div className="pv-row" key={`file${i}`}>
          <span className="pv-kind file">file</span>
          <span className="pv-text">{f.path}{f.note ? ` · ${f.note}` : ''}</span>
        </div>
      ))}
      {p.dirs?.map((d, i) => (
        <div className="pv-row" key={`dir${i}`}>
          <span className="pv-kind dir">dir</span>
          <span className="pv-text">{d}</span>
        </div>
      ))}
      {p.commands?.map((c, i) => (
        <div className="pv-row" key={`cmd${i}`}>
          <span className="pv-kind cmd">cmd</span>
          <span className="pv-text mono">{c}</span>
        </div>
      ))}
      {p.notes?.map((n, i) => (
        <div className="pv-row" key={`note${i}`}>
          <span className="pv-kind note">·</span>
          <span className="pv-text">{n}</span>
        </div>
      ))}
    </div>
  );
}

function catOf(tool: string): string {
  const map: Record<string, string> = {
    jdk: 'java', maven: 'build-tool', gradle: 'build-tool', node: 'node',
    mysql: 'database', redis: 'database', git: 'tool', docker: 'container', nginx: 'web-server',
  };
  return map[tool] ?? 'tool';
}
function homeVarOf(tool: string): string {
  const map: Record<string, string> = {
    jdk: 'JAVA_HOME', maven: 'MAVEN_HOME', gradle: 'GRADLE_HOME', mysql: 'MYSQL_HOME', redis: 'REDIS_HOME',
    node: 'NODE_HOME', git: 'GIT_HOME', docker: 'DOCKER_HOME', go: 'GOROOT', python: 'PYTHONHOME',
    nginx: 'NGINX_HOME',
  };
  return map[tool] ?? '—';
}
