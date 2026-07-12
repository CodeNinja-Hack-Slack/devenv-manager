// 预加载脚本：把 IPC 桥暴露为 window.devenv（安全、contextIsolated）
import { contextBridge, ipcRenderer } from 'electron';

const api = {
  // 配置
  initRoot: () => ipcRenderer.invoke('config:init'),
  setRoot: (root: string) => ipcRenderer.invoke('config:setRoot', root),
  getConfig: () => ipcRenderer.invoke('config:get'),
  saveConfig: (cfg: any) => ipcRenderer.invoke('config:save', cfg),
  // 扫描
  scan: () => ipcRenderer.invoke('scan'),
  /** 读取缓存的扫描结果（不重新扫描，用于启动时快速展示） */
  getScanCache: () => ipcRenderer.invoke('scan:cached'),
  exportReport: (format: 'json' | 'md') => ipcRenderer.invoke('scan:export', format),
  // 概览「已安装工具」：合并已纳管 + 系统已检测
  // 注意：方法名必须与 DevEnvApi 接口一致（getDashboardTools），
  // 否则 src-ui/api.ts 的 Proxy 会因 `prop in real` 失败而永久降级到 mockApi。
  getDashboardTools: () => ipcRenderer.invoke('dashboard:tools'),
  /** 概览「当前使用中的工具」：每个工具仅挑出正在用的那一版 */
  getCurrentTools: () => ipcRenderer.invoke('dashboard:current'),
  // 安装
  listRemote: (tool: string) => ipcRenderer.invoke('listRemote', tool),
  // 注意：第 3 个参数为可选 opts（含 downloadDir/installDir 单次路径覆盖），
  // 必须透传给主进程，否则路径询问功能（记住默认 / 本次指定）在真实桌面端会失效。
  installOnline: (tool: string, version: string, opts?: { downloadDir?: string; installDir?: string }) =>
    ipcRenderer.invoke('install:online', tool, version, opts),
  installOffline: (tool: string, opts: { version?: string; majorVersion?: string; localPath: string; downloadDir?: string; installDir?: string }) =>
    ipcRenderer.invoke('install:offline', tool, opts),
  /** 安装规划（先规划后执行）：返回完整步骤计划（参数 + 预览），不触碰系统 */
  planInstall: (tool: string, version: string, opts?: { mode?: string; downloadDir?: string; installDir?: string; targetDir?: string; useMirror?: boolean; majorVersion?: string; localPath?: string }) =>
    ipcRenderer.invoke('install:plan', tool, version, opts),
  recognize: (localPath: string) => ipcRenderer.invoke('recognize', localPath),
  pickFile: () => ipcRenderer.invoke('dialog:pickFile'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  // 切换 / 迁移
  switchVersion: (category: string, version: string) =>
    ipcRenderer.invoke('switch', category, version),
  /** 切换前校验：检查工具路径是否存在 */
  switchVerify: (toolPath: string, binPath?: string) =>
    ipcRenderer.invoke('switch:verify', toolPath, binPath),
  /** 激活系统检测到的工具为默认版本（设置 HOME + PATH 优先级） */
  activateDetectedTool: (payload: { tool: string; name: string; category: string; version: string; path: string; homeVar?: string }) =>
    ipcRenderer.invoke('switch:detected', payload),
  /** 列出某工具的所有版本固定变量（引用式切换的变量体系） */
  listVersionVars: (tool: string) => ipcRenderer.invoke('version-vars:list', tool),
  migrate: (newRoot: string, move?: boolean) => ipcRenderer.invoke('migrate', newRoot, move),
  // 环境变量（只读检视：仅返回 devenv 管理的开发工具相关变量，不修改任何系统状态）
  envInspect: () => ipcRenderer.invoke('env:inspect'),
  // 方案
  profiles: () => ipcRenderer.invoke('profiles:list'),
  applyProfile: (id: string) => ipcRenderer.invoke('profile:apply', id),
  /** 纳管「电脑上已存在的开发软件」：登记到统一配置（不激活）。注意：此前漏接此桥，导致桌面端纳管实际走 mock 静默失败 */
  addExistingTool: (payload: { tool: string; name: string; category: string; version: string; path: string; homeVar?: string }) =>
    ipcRenderer.invoke('tool:add', payload),
  /** 移除纳管：仅从配置删除「外部纳管」记录，不删文件、不改环境变量 */
  removeExistingTool: (payload: { id?: string; tool?: string; version?: string; path?: string }) =>
    ipcRenderer.invoke('tool:remove', payload),
  /** 卸载工具（本软件安装的 + 已纳管的外部软件）；deleteFiles 控制是否删除安装目录文件 */
  uninstallTool: (id: string, opts?: { deleteFiles?: boolean }) =>
    ipcRenderer.invoke('tool:uninstall', id, opts),
  /** 在文件资源管理器中定位「安装目录所在文件夹」位置（每个软件工具行通用） */
  openFolder: (folderPath: string) =>
    ipcRenderer.invoke('tool:openFolder', folderPath),
  /** 订阅安装真实进度事件（引擎 installTool 通过 onProgress 透传步骤级进度）；返回取消订阅函数 */
  onInstallProgress: (cb: (p: any) => void) => {
    const listener = (_e: any, p: any) => cb(p);
    ipcRenderer.on('install:progress', listener);
    return () => ipcRenderer.removeListener('install:progress', listener);
  },
};

contextBridge.exposeInMainWorld('devenv', api);

export type DevEnvApi = typeof api;
