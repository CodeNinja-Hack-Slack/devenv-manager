import { create } from 'zustand';
import { api, isDesktop as _isDesktopFn, type ScanResult, type ProfileSpec, type DashboardTool, type VersionVarInfo } from '../api';

/** 根据工具标识查找对应的环境变量名 */
function lookupHomeVar(tool: string): string | undefined {
  const map: Record<string, string> = {
    jdk: 'JAVA_HOME', maven: 'MAVEN_HOME', gradle: 'GRADLE_HOME',
    node: 'NODE_HOME', mysql: 'MYSQL_HOME', redis: 'REDIS_HOME',
    docker: 'DOCKER_HOME', git: 'GIT_HOME',
  };
  return map[tool];
}

export type PageKey =
  | 'dashboard'
  | 'scanner'
  | 'install'
  | 'switch'
  | 'env'
  | 'profiles'
  | 'settings';

interface Toast {
  id: number;
  msg: string;
  type: 'ok' | 'err' | 'info';
}

interface Store {
  page: PageKey;
  rootDir: string;
  configured: boolean;
  isDesktop: boolean;
  config: any;
  scanResults: ScanResult[];
  scanning: boolean;
  profiles: Record<string, ProfileSpec>;
  /** 概览「已安装工具」：合并已纳管 + 系统已检测，按类别分组展示 */
  dashboardTools: DashboardTool[];
  /** 概览「当前使用中的工具」：每个工具仅挑出正在用的那一版 */
  currentTools: DashboardTool[];
  toasts: Toast[];

  setPage: (p: PageKey) => void;
  init: () => Promise<void>;
  refreshConfig: () => Promise<void>;
  loadDashboardTools: () => Promise<void>;
  loadCurrentTools: () => Promise<void>;
  doScan: () => Promise<void>;
  installOnline: (tool: string, version: string, opts?: { downloadDir?: string; installDir?: string; targetDir?: string; useMirror?: boolean }, onProgress?: (p: any) => void) => Promise<void>;
  installOffline: (tool: string, opts: { version?: string; majorVersion?: string; localPath: string; downloadDir?: string; installDir?: string; targetDir?: string; useMirror?: boolean }, onProgress?: (p: any) => void) => Promise<void>;
  /** 安装规划（先规划后执行）：返回完整步骤计划，不触碰系统 */
  planInstall: (tool: string, version: string, opts?: { mode?: string; downloadDir?: string; installDir?: string; targetDir?: string; useMirror?: boolean; majorVersion?: string; localPath?: string; stepParams?: Record<string, Record<string, any>> }) => Promise<{ ok: boolean; plan?: any; error?: string }>;
  switchVersion: (category: string, version: string, toolPath?: string) => Promise<void>;
  /** 激活系统检测到的工具为默认版本 */
  activateDetected: (tool: DashboardTool) => Promise<void>;
  /** 纳管「电脑上已存在的开发软件」 */
  addExisting: (payload: { tool: string; name: string; category: string; version: string; path: string; homeVar?: string }) => Promise<void>;
  /** 移除纳管：仅从配置删除「外部纳管」记录（不删文件、不改环境变量），实现「纳管 ↔ 移除」开关 */
  removeExisting: (payload: { id?: string; tool?: string; version?: string; path?: string }) => Promise<void>;
  /** 卸载工具（本软件安装的 + 已纳管的外部软件） */
  uninstallTool: (id: string, opts?: { deleteFiles?: boolean }) => Promise<void>;
  /** 在文件资源管理器中定位「安装目录所在文件夹」位置（每个软件工具行通用） */
  openFolder: (folderPath: string) => Promise<void>;
  migrate: (newRoot: string, move?: boolean) => Promise<void>;
  saveSettings: (cfg: any) => Promise<void>;
  loadProfiles: () => Promise<void>;
  applyProfile: (id: string) => Promise<void>;
  toast: (msg: string, type?: Toast['type']) => void;
}

let tid = 0;

export const useStore = create<Store>((set, get) => ({
  page: 'dashboard',
  rootDir: '',
  configured: false,
  isDesktop: _isDesktopFn(),
  config: null,
  scanResults: [],
  scanning: false,
  profiles: {},
  dashboardTools: [],
  currentTools: [],
  toasts: [],

  setPage: (p) => set({ page: p }),

  init: async () => {
    const r = await api.initRoot();
    set({ rootDir: r.rootDir, configured: r.configured });
    if (r.configured) {
      await get().refreshConfig();
      await get().loadProfiles();
      // 启动时加载缓存的扫描结果；若无缓存则自动扫描一次，确保新装工具/新增扫描目录能被发现
      const cached = await api.getScanCache();
      if (cached.length > 0) {
        set({ scanResults: cached });
        await get().loadDashboardTools();
        await get().loadCurrentTools();
      } else {
        await get().doScan();
      }
    }
  },

  refreshConfig: async () => {
    const cfg = await api.getConfig();
    set({ config: cfg });
  },

  loadDashboardTools: async () => {
    try {
      console.log('[store:diag] loadDashboardTools calling api.getDashboardTools()...');
      const list = await api.getDashboardTools();
      console.log('[store:diag] getDashboardTools returned', list.length, 'items:', list.map((t: any) => `${t.source}:${t.tool}/${t.version}`));
      set({ dashboardTools: list });
    } catch (e: any) {
      console.error('[store:diag] loadDashboardTools 失败:', e?.message ?? e);
      // 降级：至少展示已纳管工具（config.tools），不因扫描失败而全部为空
      try {
        const cfg = await api.getConfig();
        const installed = (cfg?.tools ?? []) as any[];
        console.log('[store:diag] 降级: 从 config 取到', installed.length, '个已安装工具');
        set({
          dashboardTools: installed.map((t: any) => ({
            name: t.name, version: t.version, category: t.category,
            tool: t.tool, source: 'installed' as const, path: t.path,
            mode: t.mode, active: t.active,
          })),
        });
      } catch {
        // 连 config 都拿不到就保持空
      }
    }
  },

  loadCurrentTools: async () => {
    try {
      const list = await api.getCurrentTools();
      set({ currentTools: list });
    } catch {
      set({ currentTools: [] });
    }
  },

  doScan: async () => {
    set({ scanning: true });
    try {
      // 诊断：确认 API 路由（真实 IPC vs mock 降级）
      const isReal = typeof window !== 'undefined' && !!(window as any).devenv;
      console.log('[doScan] API route:', isReal ? 'REAL (window.devenv)' : 'MOCK FALLBACK');
      const r = await api.scan();
      console.log('[doScan] api.scan() returned', r?.length ?? 'null/undefined', 'items:', r);
      set({ scanResults: r });
      // 新扫描结果已持久化到缓存，同步刷新概览页
      await get().loadDashboardTools();
      await get().loadCurrentTools();
    } finally {
      set({ scanning: false });
    }
  },

  installOnline: async (tool, version, opts, onProgress) => {
    const unsub = onProgress ? api.onInstallProgress(onProgress) : undefined;
    try {
      const r = await api.installOnline(tool, version, opts);
      if (r.ok) get().toast(`在线安装成功：${tool} ${version}`, 'ok');
      else get().toast(`安装失败：${r.error}`, 'err');
    } finally {
      unsub?.();
    }
    await get().refreshConfig();
    await get().loadDashboardTools();
      await get().loadCurrentTools();
  },

  installOffline: async (tool, opts, onProgress) => {
    const unsub = onProgress ? api.onInstallProgress(onProgress) : undefined;
    try {
      const r = await api.installOffline(tool, opts);
      if (r.ok) get().toast(`离线安装成功：${tool} ${opts.majorVersion ?? opts.version ?? ''}`, 'ok');
      else get().toast(`安装失败：${r.error}`, 'err');
    } finally {
      unsub?.();
    }
    await get().refreshConfig();
    await get().loadDashboardTools();
      await get().loadCurrentTools();
  },

  planInstall: async (tool, version, opts) => {
    return api.planInstall(tool, version, opts);
  },

  switchVersion: async (category, version, toolPath?: string) => {
    // 前置校验：目标路径是否存在
    if (toolPath) {
      const v = await api.switchVerify(toolPath);
      if (!v.exists) {
        get().toast(`切换失败：${v.reason || '目标路径不存在'}`, 'err');
        return;
      }
    }
    const r = await api.switchVersion(category, version);
    if (r.ok) {
      const refInfo = r.activeVar ? `（${r.activeVar.name} → ${r.activeVar.value}）` : '';
      get().toast(`已切换默认版本：${version}${refInfo}`, 'ok');
    } else get().toast(`切换失败：${r.error}`, 'err');
    await get().refreshConfig();
    await get().loadDashboardTools();
      await get().loadCurrentTools();
  },
  /** 激活系统检测到的工具为默认版本（带路径校验） */
  activateDetected: async (tool) => {
    // 先校验路径存在
    const v = await api.switchVerify(tool.path);
    if (!v.exists) {
      get().toast(`激活失败：${v.reason || '工具路径不存在，可能已被卸载或移动'}`, 'err');
      return;
    }
    const r = await api.activateDetectedTool({
      tool: tool.tool, name: tool.name, category: tool.category,
      version: tool.version, path: tool.path, homeVar: lookupHomeVar(tool.tool),
    });
    if (r.ok) get().toast(`已激活 ${tool.name} ${tool.version} 为默认版本`, 'ok');
    else get().toast(`激活失败：${r.error}`, 'err');
    await get().refreshConfig();
    await get().loadDashboardTools();
      await get().loadCurrentTools();
  },

  addExisting: async (payload) => {
    const r = await api.addExistingTool(payload);
    if (r.ok) get().toast(`已纳管 ${payload.name} ${payload.version}`, 'ok');
    else get().toast(`纳管失败：${r.error}`, 'err');
    await get().refreshConfig();
    await get().loadDashboardTools();
    await get().loadCurrentTools();
  },

  removeExisting: async (payload) => {
    const r = await api.removeExistingTool(payload);
    if (r.ok) get().toast(`已移除纳管 ${payload.tool ?? ''} ${payload.version ?? ''}`.trim(), 'ok');
    else get().toast(`移除纳管失败：${r.error}`, 'err');
    await get().refreshConfig();
    await get().loadDashboardTools();
    await get().loadCurrentTools();
  },

  uninstallTool: async (id, opts) => {
    const r = await api.uninstallTool(id, opts);
    if (r.ok) {
      const del = r.deleted?.length ? `（已清理文件：${r.deleted.length} 项）` : '（仅移除记录与环境变量，文件未删）';
      get().toast(`卸载成功${del}`, 'ok');
    } else get().toast(`卸载失败：${r.error}`, 'err');
    await get().refreshConfig();
    await get().loadDashboardTools();
    await get().loadCurrentTools();
  },

  openFolder: async (folderPath) => {
    if (!folderPath) {
      get().toast('路径为空，无法定位文件夹', 'err');
      return;
    }
    const r = await api.openFolder(folderPath);
    if (r.ok) {
      if (r.note) get().toast(r.note, 'info');
    } else {
      get().toast(`打开文件夹失败：${r.error}`, 'err');
    }
  },

  migrate: async (newRoot, move) => {
    const r = await api.migrate(newRoot, move);
    if (r.ok) {
      set({ rootDir: newRoot });
      get().toast(`根目录已迁移至 ${newRoot}`, 'ok');
    } else get().toast(`迁移失败：${r.error}`, 'err');
    await get().refreshConfig();
    await get().loadDashboardTools();
      await get().loadCurrentTools();
  },

  loadProfiles: async () => {
    const p = await api.profiles();
    set({ profiles: p });
  },

  saveSettings: async (cfg) => {
    const r = await api.saveConfig(cfg);
    if (r.ok) {
      set({ config: cfg });
      get().toast('设置已保存', 'ok');
    } else {
      get().toast(`保存失败：${r.error ?? '未知错误'}`, 'err');
    }
    await get().refreshConfig();
  },

  applyProfile: async (id) => {
    const r = await api.applyProfile(id);
    if (r.ok) get().toast(`已应用方案：${id}（${r.switched?.join(', ')}）`, 'ok');
    else get().toast(`应用失败：${r.error}`, 'err');
    await get().refreshConfig();
    await get().loadDashboardTools();
      await get().loadCurrentTools();
  },

  toast: (msg, type = 'info') => {
    const id = ++tid;
    set({ toasts: [...get().toasts, { id, msg, type }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), 3200);
  },
}));
