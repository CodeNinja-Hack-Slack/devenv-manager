// ============================================================================
// IPC 处理器：把 UI 请求桥接到引擎层
// 真实系统操作在此执行（使用非 dryRun 的 EnvBackend，会真正写环境变量）。
// ============================================================================

import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { shell } from 'electron';
import { defaultConfig, loadConfig, saveConfig, ensureCustomDirs, toolId } from '../../src/config/store.js';
import { scanSystem, toJson, toMarkdown, mergeDashboardTools, pickCurrentTools } from '../../src/core/scanner.js';
import { installTool, planInstall } from '../../src/core/installer.js';
import { uninstallTool } from '../../src/core/uninstall.js';
import { switchVersionRef, applyMigrate, versionEnvName, getEffectiveHomeVar, type VersionVarInfo } from '../../src/core/switch.js';
import { applyProfile } from '../../src/core/profiles.js';
import { listRemote, REGISTRY, getSpec } from '../../src/tools/registry.js';
import { recognizePackage } from '../../src/core/recognizer.js';
import { createEnvBackend, isElevated, broadcastEnvChange, resolveWinExe } from '../../src/platform/env.js';
import { Logger } from '../../src/utils/logger.js';
import { normalizePath, planBinRef, planBinPath } from '../../src/utils/path.js';
import { normPathForActive, expandEnv } from './handlers-helpers.js';
import type { DevEnvConfig, ToolCategory } from '../../src/types.js';

// 诊断日志开关：设置环境变量 DEVENV_DEBUG=1 才输出详细扫描/版本日志，避免生产环境刷屏。
// 新增软件的诊断日志请统一用此开关包裹。
const DEBUG = process.env.DEVENV_DEBUG === '1' || process.env.DEVENV_DEBUG === 'true';

// ---- 模块级工具函数 ----

// 遗留根目录哨兵：旧版曾把安装根目录硬编码为 E:\a（测试残留），绝不应当被当作有效配置使用。
const LEGACY_ROOT_DIRS = new Set(['e:\\a', 'e:/a']);
const isLegacyRoot = (r: string) => LEGACY_ROOT_DIRS.has(r.replace(/\\/g, '/').toLowerCase());

// 把旧版落在安装目录内的 devenv-data 迁移到 Electron 用户数据目录（best-effort，仅一次）。
// 旧版因把运行时数据放在安装目录内，导致：① 生产环境 app.getAppPath() 指向 app.asar 文件，
// 在其内 mkdir 抛 ENOTDIR；② 重装/升级时数据被 NSIS 清空。迁移到 userData 后两者皆解。
// 注意：若旧配置指向遗留测试根目录 E:\a，则「不迁移」（避免把无效根带入新配置；loadRoot 也会重置为未配置）。
async function migrateRuntimeHomeIfNeeded(installDir: string, newHome: string): Promise<void> {
  try {
    const oldHome = path.join(installDir, 'devenv-data');
    if (oldHome === newHome) return;
    const oldRoot = path.join(oldHome, 'devenv-root.txt');
    const newRoot = path.join(newHome, 'devenv-root.txt');
    const [oldExists, newExists] = await Promise.all([
      fs.access(oldRoot).then(() => true).catch(() => false),
      fs.access(newRoot).then(() => true).catch(() => false),
    ]);
    if (!oldExists || newExists) return; // 无旧配置 / 已迁移过 → 跳过
    // 旧配置指向遗留测试根目录 E:\a 时，直接忽略，不迁移
    const oldContent = (await fs.readFile(oldRoot, 'utf8')).trim();
    if (isLegacyRoot(oldContent)) {
      console.log('[migrate] 旧配置指向遗留根目录 E:\\a，已忽略，不迁移');
      return;
    }
    // 仅当旧位置有配置、且新位置还没有时才迁移（避免覆盖/重复）
    await fs.mkdir(newHome, { recursive: true });
    try {
      await fs.rename(oldRoot, newRoot);
    } catch {
      // 跨盘 rename 失败时退化为复制
      await fs.writeFile(newRoot, oldContent, 'utf8');
    }
    const oldCache = path.join(oldHome, 'scan-cache.json');
    const newCache = path.join(newHome, 'scan-cache.json');
    if (await fs.access(oldCache).then(() => true).catch(() => false)) {
      await fs.writeFile(newCache, await fs.readFile(oldCache, 'utf8'), 'utf8');
    }
    console.log('[migrate] 已迁移运行时配置到用户数据目录:', oldHome, '→', newHome);
  } catch (e) {
    console.warn('[migrate] 运行时数据迁移失败（可忽略）:', e?.message ?? e);
  }
}

export async function registerIpc(ctx: any) {
  const { ipcMain, dialog, app } = ctx;
  // 运行时数据目录：移到 Electron 用户数据目录（默认 AppData/Roaming/DevEnv Manager）。
  // 旧设计把 devenv-data 放在安装目录内，导致两个致命问题：
  //   ① 生产环境 app.getAppPath() 指向 app.asar 文件，在其内 mkdir 会抛 ENOTDIR
  //      （即「开始配置」报错的根因）；
  //   ② 安装目录内的数据在重装/升级时会被 NSIS 清空，用户数据丢失。
  // 移到 userData 后：既是真实可写目录，又位于安装目录之外，重装后配置自动保留。
  const installDir = path.dirname(app.getPath('exe'));
  const runtimeHome = path.join(app.getPath('userData'), 'devenv-data');
  const rootFile = path.join(runtimeHome, 'devenv-root.txt');
  let rootDir = '';

  // 首次启动：把旧版落在安装目录内的 devenv-data 迁移到 userData（best-effort，仅一次）
  // 注：遗留根目录哨兵 LEGACY_ROOT_DIRS / isLegacyRoot 已提升为模块级（见上方），供迁移与 setRoot/migrate 共用。
  await migrateRuntimeHomeIfNeeded(installDir, runtimeHome);

  async function loadRoot(): Promise<string> {
    if (rootDir) return rootDir;
    try {
      rootDir = (await fs.readFile(rootFile, 'utf8')).trim();
    } catch {
      rootDir = '';
    }
    // 防御：若 devenv-root.txt 残留了旧版硬编码的 E:\a，直接忽略（视为未配置），
    // 让用户在“设置”中重新指定真实根目录，而不是去重建 E:\a。
    if (rootDir && isLegacyRoot(rootDir)) {
      console.warn(`[root] 检测到遗留根目录 "${rootDir}"，已忽略；请重新在“设置中心”指定安装根目录。`);
      rootDir = '';
    }
    return rootDir;
  }
  async function getCfg(): Promise<DevEnvConfig | null> {
    const r = await loadRoot();
    if (!r) return null;
    return (await loadConfig(r)) ?? defaultConfig(r);
  }

  // ── 扫描结果持久化缓存 ──────────────────────────────────────────
  const SCAN_CACHE_FILE = path.join(runtimeHome, 'scan-cache.json');

  interface ScanCacheData {
    results: any[];       // ScanResult[]
    timestamp: string;    // ISO 8601
  }

  async function loadScanCache(): Promise<any[]> {
    try {
      const raw = await fs.readFile(SCAN_CACHE_FILE, 'utf-8');
      const data: ScanCacheData = JSON.parse(raw);
      return data.results ?? [];
    } catch {
      return [];
    }
  }

  async function saveScanCache(results: any[]): Promise<void> {
    const data: ScanCacheData = { results, timestamp: new Date().toISOString() };
    await fs.writeFile(SCAN_CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8');
  }

  ipcMain.handle('config:init', async () => {
    const r = await loadRoot();
    return { rootDir: r, configured: !!r };
  });

  ipcMain.handle('config:setRoot', async (_e: any, root: string) => {
    const normalized = (root || '').trim().replace(/\\/g, '/');
    if (!normalized) return { ok: false, error: '根目录不能为空' };
    // 拒绝旧版硬编码的遗留测试根目录，避免 E:\a 被反复重建
    if (isLegacyRoot(normalized)) {
      return { ok: false, error: '不允许使用遗留的测试根目录 E:\\a，请指定其它目录' };
    }
    rootDir = root.trim();
    await fs.mkdir(runtimeHome, { recursive: true });
    await fs.writeFile(rootFile, rootDir, 'utf8');
    await saveConfig(defaultConfig(rootDir));
    return { ok: true };
  });

  ipcMain.handle('config:get', async () => await getCfg());

  ipcMain.handle('config:save', async (_e: any, cfg: any) => {
    try {
      if (!cfg || !cfg.rootDir) return { ok: false, error: '配置无效：缺少 rootDir' };
      await saveConfig(cfg);
      // 仅当用户显式自定义了下载/安装目录时才创建对应文件夹（默认目录按需懒创建）
      await ensureCustomDirs(cfg);
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('scan', async () => {
    const t0 = Date.now();
    let results: any[] = [];
    try {
      results = await scanSystem();
    } catch (e: any) {
      console.error('[scan] scanSystem() threw:', e?.message ?? e, e?.stack?.slice(0, 300));
      // 即使抛异常也尝试返回已有结果（部分工具可能已在异常前检测到）
    }
    const dt = Date.now() - t0;
    if (DEBUG) console.log(`[scan] completed in ${dt}ms, found ${results.length} tools:`,
      results.map((r: any) => `${r.tool}@${r.version}`).join(', ') || '(none)');
    await saveScanCache(results);
    return results;
  });

  // 读取缓存的扫描结果（不重新扫描）
  ipcMain.handle('scan:cached', async () => loadScanCache());

  // 概览页「已安装工具」：合并已纳管(config.tools) + 系统已检测(扫描缓存)
  // 优先从磁盘缓存读取扫描结果，避免每次打开都重新执行 scanSystem()
  ipcMain.handle('dashboard:tools', async () => {
    let installed: any[] = [];
    try {
      const cfg = await getCfg();
      installed = cfg?.tools ?? [];
    } catch { /* 继续用缓存 */ }
    const detected = await loadScanCache();
    return mergeDashboardTools(installed, detected);
  });

  // 概览页「当前使用中的工具」：在合并列表基础上挑出每个工具正在用的那一版
  // 重要：active 判定必须基于注册表实时数据，不可依赖 config 中过期的 t.active 缓存！
  ipcMain.handle('dashboard:current', async () => {
    let installed: any[] = [];
    try {
      const cfg = await getCfg();
      installed = cfg?.tools ?? [];
    } catch { /* 继续用缓存 */ }
    const detected = await loadScanCache();
    let merged = mergeDashboardTools(installed, detected);

    // ---- 用注册表实时数据校正 active 状态 ----
    // 读取系统环境变量，确定每个 homeVar 实际引用的是哪个版本
    try {
      const [userEnv, sysEnv] = await Promise.all([readRegEnv('HKCU'), readRegEnv('HKLM')]);
      const liveEnv = { ...sysEnv, ...userEnv }; // 用户级优先

      // 收集所有涉及的 homeVar（从 config 和 REGISTRY 常量）
      const homeVars = new Set<string>();
      for (const t of installed) {
        const hv = getEffectiveHomeVar(t.tool, t.homeVar);
        if (hv) homeVars.add(hv);
      }
      for (const spec of REGISTRY) homeVars.add(spec.homeVar);

      // 对每个 homeVar，解析其「当前激活版本的绝对路径」：
      //   - 引用模式（旧/兼容）：JAVA_HOME=%JAVA_HOME8% → 展开为 JAVA_HOME8 指向的绝对路径
      //   - 字面量模式（Plan B）：JAVA_HOME=E:\Software\Java\Java17\JDK → 直接是绝对路径
      const liveActivePaths = new Map<string, string>(); // homeVar → 激活版绝对路径
      for (const hv of homeVars) {
        const val = liveEnv[hv];
        if (!val) continue;
        const refMatch = val.match(/^%([^%]+)%$/);
        if (refMatch) {
          const refVal = liveEnv[refMatch[1]] ?? process.env[refMatch[1]] ?? '';
          if (refVal) liveActivePaths.set(hv, refVal);
        } else {
          liveActivePaths.set(hv, val);
        }
      }

      // 用实时数据覆盖 config 中的过期 active 标记：路径匹配即视为激活。
      // 注意：detected（系统已存在未纳管）工具没有 config 记录，也要能按注册表实时路径标 active，
      // 否则「系统里正被 JAVA_HOME 指向、但还没纳管」的 JDK 拿不到 active:true（修复 #5）。
      merged = merged.map((t: any) => {
        const hv = t.homeVar ?? getSpec(t.tool)?.homeVar ?? getEffectiveHomeVar(t.tool, undefined);
        if (!hv || !liveActivePaths.has(hv)) return t;
        const activePath = liveActivePaths.get(hv)!;
        const isRealActive = normPathForActive(t.path) === normPathForActive(activePath);
        return { ...t, active: isRealActive };
      });
    } catch {
      // 注册表读取失败时降级使用原始数据（config 缓存的 active），总比没有好
    }

    return pickCurrentTools(merged);
  });

  ipcMain.handle('scan:export', async (_e: any, fmt: 'json' | 'md') => {
    const r = (await loadScanCache()).length > 0
      ? await loadScanCache()
      : await scanSystem();
    return fmt === 'md' ? toMarkdown(r) : toJson(r);
  });

  ipcMain.handle('listRemote', async (_e: any, tool: string) => listRemote(tool));

  ipcMain.handle('install:online', async (event: any, tool: string, version: string, opts?: any) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录，请先在设置中指定' };
    // applyEnv=false（测试模式）时 dryRun=true：仅收集 env 操作、不写系统
    const env = createEnvBackend(!(cfg?.applyEnv ?? true), 'system');
    const logger = new Logger(cfg.rootDir);
    return installTool(
      { cfg, env, logger, platform: process.platform as any, onProgress: (p: any) => event.sender.send('install:progress', p) },
      { tool, version, mode: 'online', downloadDir: opts?.downloadDir, installDir: opts?.installDir, targetDir: opts?.targetDir, useMirror: opts?.useMirror },
    );
  });

  ipcMain.handle('install:offline', async (event: any, tool: string, opts: any) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录，请先在设置中指定' };
    const env = createEnvBackend(!(cfg?.applyEnv ?? true), 'system');
    const logger = new Logger(cfg.rootDir);
    return installTool(
      { cfg, env, logger, platform: process.platform as any, onProgress: (p: any) => event.sender.send('install:progress', p) },
      {
        tool,
        version: opts?.version,
        majorVersion: opts?.majorVersion,
        mode: 'offline',
        localPath: opts?.localPath,
        downloadDir: opts?.downloadDir,
        installDir: opts?.installDir,
        targetDir: opts?.targetDir,
        useMirror: opts?.useMirror,
      },
    );
  });

  // 安装「规划模式」：返回完整步骤计划（每步可编辑参数 + 环境/文件变更预览），不触碰系统。
  // 前端据此先渲染规划视图，用户确认后调用 install:online/offline 真实执行。
  ipcMain.handle('install:plan', async (_e: any, tool: string, version: string, opts?: any) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录，请先在设置中指定' };
    const env = createEnvBackend(!(cfg?.applyEnv ?? true), 'system');
    const logger = new Logger(cfg.rootDir);
    try {
      const plan = planInstall(
        { cfg, env, logger, platform: process.platform as any },
        {
          tool,
          version,
          mode: (opts?.mode as any) ?? 'online',
          downloadDir: opts?.downloadDir,
          installDir: opts?.installDir,
          targetDir: opts?.targetDir,
          useMirror: opts?.useMirror,
          majorVersion: opts?.majorVersion,
          localPath: opts?.localPath,
          stepParams: opts?.stepParams,
        },
      );
      return { ok: true, plan };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  ipcMain.handle('recognize', async (_e: any, localPath: string) => {
    if (!localPath) return null;
    const name = localPath.split(/[\\/]/).pop() ?? '';
    return recognizePackage(name);
  });

  ipcMain.handle('switch', async (_e: any, category: string, version: string) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录' };
    // 系统变量(HKLM)写入需要管理员权限：非测试模式(applyEnv)下预检提权
    if (cfg.applyEnv !== false) {
      const elevated = await isElevated();
      if (!elevated) {
        return { ok: false, error: '写入系统变量(HKLM)需要管理员权限。\n请右键本程序 →「以管理员身份运行」后重试。' };
      }
    }
    // 前置校验：目标版本是否存在于配置中
    const target = cfg.tools.find((t: any) => t.category === category && t.version === version);
    if (!target) return { ok: false, error: `未找到类别「${category}」的版本 ${version}，请先安装该版本。` };
    // 校验路径是否存在（防止用户切换到已删除的版本）
    const fsp = await import('node:fs/promises');
    try {
      await fsp.access(target.path);
      // 同时校验 binPath 是否存在（如果有）
      if (target.binPath) {
        try { await fsp.access(target.binPath); } catch {
          return { ok: false, error: `可执行文件不存在：${target.binPath}\n该版本可能已损坏或被移动，请重新安装。` };
        }
      }
    } catch {
      return { ok: false, error: `安装路径不存在：${target.path}\n该版本可能已被删除，请重新安装或选择其他版本。` };
    }
    // 使用引用式版本切换：为每个版本创建固定变量，活跃变量用 %REF% 引用
    // 写入系统变量（HKLM），与用户多版本共存体系对齐
    try {
      const result = await switchVersionRef(cfg, category as ToolCategory, version, createEnvBackend(!(cfg?.applyEnv ?? true), 'system'));
      // 广播 WM_SETTINGCHANGE 使其它进程感知环境变量变更（setx/reg add 不自动广播）
      if (cfg.applyEnv !== false) await broadcastEnvChange();
      return result;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/denied|access|740|12288/i.test(msg)) {
        return { ok: false, error: '写入系统变量失败：权限不足。\n请右键本程序 →「以管理员身份运行」后重试。' };
      }
      return { ok: false, error: `切换失败：${msg}` };
    }
  });

  // 切换前校验：检查工具路径/二进制文件是否存在
  ipcMain.handle('switch:verify', async (_e: any, toolPath: string, binPath?: string) => {
    const fsp = await import('node:fs/promises');
    try {
      await fsp.access(toolPath);
      if (binPath) {
        try { await fsp.access(binPath); } catch {
          return { exists: false, reason: `可执行文件不存在：${binPath}` };
        }
      }
      return { exists: true };
    } catch {
      return { exists: false, reason: `路径不存在：${toolPath}` };
    }
  });

  // 激活系统检测到的工具为默认版本（使用引用式切换：创建版本固定变量 + 活跃变量引用）
  ipcMain.handle('switch:detected', async (_e: any, payload: { tool: string; name: string; category: string; version: string; path: string; homeVar?: string }) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录' };
    // 系统变量(HKLM)写入需要管理员权限：非测试模式(applyEnv)下预检提权
    if (cfg.applyEnv !== false) {
      const elevated = await isElevated();
      if (!elevated) {
        return { ok: false, error: '写入系统变量(HKLM)需要管理员权限。\n请右键本程序 →「以管理员身份运行」后重试。' };
      }
    }
    const fsp = await import('node:fs/promises');
    // 校验路径存在性
    try { await fsp.access(payload.path); } catch {
      return { ok: false, error: `工具路径不存在：${payload.path}，请确认该工具仍安装在系统中。` };
    }

    const env = createEnvBackend(!(cfg?.applyEnv ?? true), 'system');
    const homeVar = getEffectiveHomeVar(payload.tool, payload.homeVar);
    const vName = versionEnvName(homeVar, payload.version);

    // ---- 阶段 1：核心环境变量写入（最关键的操作，必须成功）----
    // Plan B：激活变量直接写绝对路径（不再写版本固定变量 JAVA_HOME8 等）。
    try {
      await env.set(homeVar, payload.path);
    } catch (e: any) {
      return { ok: false, error: `写入环境变量失败：${String(e?.message ?? e)}` };
    }

    // ---- 阶段 2：立即持久化 config（即使后续 PATH 操作失败也不丢失激活状态）----
    try {
      // 更新/添加到 config.tools
      const existing = cfg.tools.findIndex((t: any) => t.tool === payload.tool && t.version === payload.version);
      if (existing >= 0) {
        for (const t of cfg.tools) if (t.category === payload.category) t.active = false;
        cfg.tools[existing].active = true;
        cfg.tools[existing].versionVar = vName;
      } else {
        for (const t of cfg.tools) if (t.category === payload.category) t.active = false;
        const spec = REGISTRY.find((s) => s.tool === payload.tool);
        const binDir = spec ? `${path.normalize(payload.path)}${path.sep}${spec.binSubdir}`.replace(/\\/g, '/') : payload.path;
        cfg.tools.push({
          id: `${payload.tool}@${payload.version}@detected`,
          tool: payload.tool, name: payload.name, category: payload.category as ToolCategory,
          version: payload.version, mode: 'offline' as const,
          path: payload.path, binPath: binDir, homeVar, active: true,
          addedToPath: true,
          installedAt: new Date().toISOString(),
          versionVar: vName,
        });
      }
      await saveConfig(cfg);
    } catch (e: any) {
      // config 保存失败不回滚环境变量（阶段 1 已成功），但记录警告
      console.warn('[switch:detected] config 持久化失败（环境变量已写入成功）：', e?.message ?? e);
    }

    // ---- 阶段 3：PATH 收敛为固定引用 %JAVA_HOME%\bin（非阻塞，失败不影响切换结果）----
    try {
      const spec = REGISTRY.find((s) => s.tool === payload.tool);
      if (spec) {
        const refBin = planBinRef(homeVar, spec?.binSubdir ?? 'bin');
        // 清理同类其它版本的遗留 PATH 条目（绝对 binPath 与 %JAVA_HOME<ver>%\bin 引用）
        for (const t of cfg.tools.filter((t: any) => t.category === payload.category)) {
          if (t.binPath) try { await env.removePath(t.binPath); } catch { /* ignore */ }
          const legacyRef = planBinRef(versionEnvName(t.homeVar ?? homeVar, t.version), getSpec(t.tool)?.binSubdir ?? 'bin');
          try { await env.removePath(legacyRef); } catch { /* ignore */ }
        }
        await env.appendPath(refBin);
      }
    } catch (e: any) {
      // PATH 操作失败仅记录日志，不影响切换结果（核心切换已完成）
      console.warn('[switch:detected] PATH 更新失败（切换本身已成功）：', e?.message ?? e);
    }

    // ---- 阶段 4：广播（best-effort）----
    if (cfg.applyEnv !== false) {
      try { await broadcastEnvChange(); } catch { /* best-effort */ }
    }

    return {
      ok: true,
      activated: {
        ...payload,
        binPath: planBinPath(payload.path, getSpec(payload.tool)?.binSubdir ?? ''),
        active: true,
        versionVar: vName,
      },
    };
  });

  // ── 纳管「电脑上已存在的开发软件」：将其加入统一配置，成为受管记录 ──
  // 与 switch:detected 的区别：本处理器只「登记」不「激活」（不写环境变量），
  // 用户随后可在管理界面点「设为默认」通过 switch:detected 激活并写入环境变量。
  ipcMain.handle('tool:add', async (_e: any, payload: {
    tool: string; name: string; category: string; version: string; path: string; homeVar?: string;
  }) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录' };
    if (!payload?.tool || !payload?.path || !payload?.version) {
      return { ok: false, error: '纳管参数不完整（缺少 tool/path/version）' };
    }
    // 校验路径存在性（避免纳管一个已删除的目录）
    const fsp = await import('node:fs/promises');
    try {
      await fsp.access(payload.path);
    } catch {
      return { ok: false, error: `工具路径不存在：${payload.path}，请确认该软件仍安装在系统中。` };
    }
    const id = `${payload.tool}@${payload.version}@external`;
    // 已存在同名记录则更新路径，否则新增（mode=external 表示该软件非本软件安装）
    const existing = cfg.tools.findIndex((t: any) => t.id === id);
    if (existing >= 0) {
      cfg.tools[existing].path = payload.path;
      cfg.tools[existing].active = false;
    } else {
      cfg.tools.push({
        id,
        tool: payload.tool,
        name: payload.name || payload.tool.toUpperCase(),
        category: payload.category as any,
        version: payload.version,
        mode: 'external' as const,
        path: payload.path,
        binPath: planBinPath(payload.path, getSpec(payload.tool)?.binSubdir ?? ''),
        homeVar: payload.homeVar,
        active: false,
        addedToPath: false,
        installedAt: new Date().toISOString(),
      });
    }
    try {
      await saveConfig(cfg);
    } catch (e: any) {
      return { ok: false, error: `保存配置失败：${e?.message ?? e}` };
    }
    return { ok: true, id, added: cfg.tools.find((t: any) => t.id === id) };
  });

  // ── 移除纳管：仅从统一配置删除「外部纳管」记录，不删文件、不改环境变量 ──
  // 与 tool:uninstall 的区别：uninstall 面向「本软件安装的」、可选删文件；
  // 移除纳管面向用户自己装的软件，只取消登记，保留其真实安装目录与现有环境变量（更安全）。
  ipcMain.handle('tool:remove', async (_e: any, payload: { id?: string; tool?: string; version?: string; path?: string }) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录' };
    if (!payload?.id && !(payload?.tool && payload?.version)) {
      return { ok: false, error: '移除纳管参数不完整（缺少 id 或 tool/version）' };
    }
    const idx = cfg.tools.findIndex((t: any) => {
      if (payload.id) return t.id === payload.id;
      const pathOk = !payload.path || normalizePath(t.path) === normalizePath(payload.path);
      return t.tool === payload.tool && t.version === payload.version && pathOk;
    });
    if (idx < 0) return { ok: false, error: '未找到该纳管记录' };
    const rec = cfg.tools[idx];
    if (rec.mode !== 'external') {
      return { ok: false, error: '该记录非「外部纳管」，请用卸载功能移除（卸载可选择是否删除文件）' };
    }
    cfg.tools.splice(idx, 1);
    try {
      await saveConfig(cfg);
    } catch (e: any) {
      return { ok: false, error: `保存配置失败：${e?.message ?? e}` };
    }
    return { ok: true, removed: rec.id };
  });

  // ── 卸载工具（需求 #3）：支持本软件安装的 + 电脑上已存在被纳管的 ──
  // 两步：(a) 更新 devenv.yaml 移除记录；(b) 清理文件/目录残留（受安全闸门约束）。
  ipcMain.handle('tool:uninstall', async (_e: any, id: string, opts?: { deleteFiles?: boolean }) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录' };
    const target = cfg.tools.find((t: any) => t.id === id);
    if (!target) return { ok: false, error: '未找到该工具的纳管记录，可能已被卸载' };

    // 环境变量写入需要管理员权限（卸载可能改写 homeVar/PATH，尤其卸载的是活跃版本时）
    if (cfg.applyEnv !== false) {
      const elevated = await isElevated();
      if (!elevated) {
        return { ok: false, error: '写入系统变量(HKLM)需要管理员权限。\n请右键本程序 →「以管理员身份运行」后重试。' };
      }
    }
    try {
      const result = await uninstallTool(
        { cfg, env: createEnvBackend(!(cfg?.applyEnv ?? true), 'system'), logger: new Logger(cfg.rootDir) },
        id,
        { deleteFiles: opts?.deleteFiles },
      );
      if (cfg.applyEnv !== false) {
        try { await broadcastEnvChange(); } catch { /* best-effort */ }
      }
      return result;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (/denied|access|740|12288/i.test(msg)) {
        return { ok: false, error: '写入系统变量失败：权限不足。\n请右键本程序 →「以管理员身份运行」后重试。' };
      }
      return { ok: false, error: `卸载失败：${msg}` };
    }
  });

  // 列出某工具的所有版本（供 Switch 页展示）
  // 数据源：仅 config.tools（Plan B 单一真相源）。
  // Plan B 已不再写「版本固定变量」(JAVA_HOME17 等)，故不再扫描注册表；
  // 从旧版升级的机器上残留的版本变量不应再出现（避免幽灵版本）。
  // 活跃状态完全基于注册表实时数据（JAVA_HOME 当前指向的绝对路径）判定，不依赖 config 缓存。
  ipcMain.handle('version-vars:list', async (_e: any, tool: string) => {
    const cfg = await getCfg();
    const homeVar = getEffectiveHomeVar(tool, cfg?.tools?.find((t: any) => t.tool === tool)?.homeVar);

    // ---- 数据源：config.tools 已纳管版本 ----
    const fromConfig: VersionVarInfo[] = [];
    if (cfg) {
      for (const t of cfg.tools.filter((t: any) => t.tool === tool)) {
        fromConfig.push({
          version: t.version,
          path: t.path,
          varName: t.versionVar ?? versionEnvName(homeVar, t.version),
          active: false,
          source: 'config' as const,
        });
      }
    }
    if (fromConfig.length === 0) return [];

    // 路径归一化（Windows 大小写不敏感 + 反斜杠归一）—— 供 active 判定共用
    const normPath = (p?: string) =>
      (p ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

    // 读取活跃变量的实时值（Plan B 下为绝对路径，如 E:\Software\Java\Java17\JDK），
    // 据此判定哪个版本当前激活（不依赖 config 中过期的 active 缓存）。
    let activeLiteral = '';
    try {
      const [userEnv, sysEnv] = await Promise.all([readRegEnv('HKCU'), readRegEnv('HKLM')]);
      const currentVal = userEnv[homeVar] ?? sysEnv[homeVar] ?? '';
      const refMatch = currentVal.match(/^%([^%]+)%$/);
      if (!refMatch) activeLiteral = currentVal; // 字面路径（Plan B 绝对路径激活的情形）
    } catch { /* ignore */ }

    // 用注册表实时数据覆盖 active：路径匹配字面值即视为激活
    return fromConfig.map((v) => ({
      ...v,
      active: normPath(v.path) === normPath(activeLiteral),
    }));
  });

  ipcMain.handle('migrate', async (_e: any, newRoot: string, move?: boolean) => {
    const normalized = (newRoot || '').trim().replace(/\\/g, '/');
    if (!normalized) return { ok: false, error: '目标根目录不能为空' };
    if (isLegacyRoot(normalized)) {
      return { ok: false, error: '不允许迁移到遗留的测试根目录 E:\\a' };
    }
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录' };
    return applyMigrate(cfg, newRoot, createEnvBackend(!(cfg?.applyEnv ?? true), 'system'), move);
  });

  // ── 环境变量实时读取辅助 ──────────────────────────────────────────
  /** 读取某注册表 hive 的 Environment 键下所有变量（用户级 / 系统级） */
  async function readRegEnv(hive: 'HKCU' | 'HKLM'): Promise<Record<string, string>> {
    const key = hive === 'HKCU'
      ? 'HKCU\\Environment'
      : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
    try {
      const { execFile } = await import('node:child_process');
      const util = await import('node:util');
      const execFileP = util.promisify(execFile);
      const { stdout } = await execFileP(resolveWinExe('reg.exe'), ['query', key], { windowsHide: true });
      const out: Record<string, string> = {};
      // reg query 输出为 CRLF；split('\n') 会残留行尾 \r，而 JS 的 . 不匹配 \r，
      // 会导致 (.*)$ 匹配失败（\r 卡在 $ 前）。故按 /\r?\n/ 切分并兜底去掉残余 \r。
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.replace(/\r$/, '');
        const m = line.match(/^\s*([A-Za-z_][\w]*)\s+REG_(?:SZ|EXPAND_SZ|MULTI_SZ)\s+([\s\S]*)$/);
        if (m) out[m[1]] = m[2].trim();
      }
      return out;
    } catch {
      return {};
    }
  }

  ipcMain.handle('profiles:list', async () => (await getCfg())?.profiles ?? {});
  ipcMain.handle('profile:apply', async (_e: any, id: string) => {
    const cfg = await getCfg();
    if (!cfg) return { ok: false, error: '未配置根目录' };
    return applyProfile(cfg, id, createEnvBackend(!(cfg?.applyEnv ?? true), 'system'));
  });

  ipcMain.handle('dialog:pickFile', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openFile'] });
    return res.canceled ? null : res.filePaths[0];
  });

  ipcMain.handle('dialog:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
    return res.canceled ? null : res.filePaths[0];
  });

  // 在文件资源管理器中定位「安装目录所在文件夹」：
  // 用 showItemInFolder 会选中并定位到该路径（若本身是文件夹则打开并选中内部）；
  // 若路径不存在则退化为 openPath 尝试打开其父目录。
  ipcMain.handle('tool:openFolder', async (_e: any, folderPath: string) => {
    try {
      if (!folderPath) return { ok: false, error: '路径为空' };
      const p = normalizePath(folderPath);
      // showItemInFolder 需要真实存在的条目，存在则直接定位
      try {
        await fs.access(p);
        await shell.showItemInFolder(p);
        return { ok: true };
      } catch {
        // 不存在：定位其父目录（若存在）
        const parent = path.dirname(p);
        await shell.showItemInFolder(parent);
        return { ok: true, note: `目标不存在，已定位父目录：${parent}` };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });

  // 聚焦版「环境变量检视」：仅返回 devenv 管理的开发工具牵扯的变量
  // （每款工具的 HOME 变量 + 遗留版本固定变量 + PATH 中由本软件注入的段），
  // 其余系统变量（USERPROFILE / TEMP / ComSpec 等）一律不返回。只读，不修改任何环境变量。
  ipcMain.handle('env:inspect', async () => {
    const userEnv = await readRegEnv('HKCU');
    const systemEnv = await readRegEnv('HKLM');
    const base: Record<string, string | undefined> = { ...systemEnv, ...userEnv, ...process.env };

    // 每款工具的 HOME 变量（含无显式 homeVar 的工具经 getEffectiveHomeVar 派生，如 git→GIT_HOME / node→NODE_HOME）
    const homeVarSet = new Set<string>();
    const homeVarTool = new Map<string, string>(); // homeVar -> tool key
    const toolList: { tool: string; name: string; homeVar: string }[] = [];
    for (const spec of REGISTRY) {
      const hv = getEffectiveHomeVar(spec.tool, spec.homeVar);
      if (!homeVarSet.has(hv)) {
        homeVarSet.add(hv);
        homeVarTool.set(hv, spec.tool);
        toolList.push({ tool: spec.tool, name: spec.name, homeVar: hv });
      }
    }

    // 发现遗留版本固定变量（仅限本软件 HOME 变量派生的，如 JAVA_HOME17），归属到对应工具
    const versionVarPattern = /^(.+_HOME)(\d+)$/;
    const versionByTool = new Map<string, EnvVarEntryLocal[]>();
    for (const k of [...Object.keys(userEnv), ...Object.keys(systemEnv)]) {
      const m = k.match(versionVarPattern);
      if (m && homeVarSet.has(m[1])) {
        const tool = homeVarTool.get(m[1])!;
        const entry = buildEnvEntry(k, userEnv, systemEnv, base);
        entry.isVersionVar = true;
        entry.tool = tool;
        if (!versionByTool.has(tool)) versionByTool.set(tool, []);
        versionByTool.get(tool)!.push(entry);
      }
    }

    const tools = toolList.map(({ tool, name, homeVar }) => {
      const entry = buildEnvEntry(homeVar, userEnv, systemEnv, base);
      entry.tool = tool;
      return { tool, name, homeVar, entry, versionEntries: versionByTool.get(tool) ?? [] };
    });

    // PATH：仅保留由 devenv 注入的段（引用本软件 HOME 变量，如 %JAVA_HOME%\bin / %REDIS_HOME%）
    const pathRaw = systemEnv['PATH'] ?? userEnv['PATH'] ?? process.env.PATH ?? '';
    const allSegs = (pathRaw ? pathRaw.split(';') : []).map((s) => s.trim()).filter(Boolean);
    const segments: EnvPathSegmentLocal[] = [];
    for (const seg of allSegs) {
      const norm = seg.replace(/\\/g, '/').toLowerCase();
      let ours = false;
      let homeVar: string | undefined;
      for (const hv of homeVarSet) {
        const ref = `%${hv}%`.toLowerCase();
        if (norm === ref || norm.startsWith(ref + '/') || norm.startsWith(ref + '\\')) {
          ours = true;
          homeVar = hv;
          break;
        }
      }
      if (ours) segments.push({ raw: seg, ours: true, homeVar, expanded: expandEnv(seg, base) });
    }

    return {
      tools,
      path: {
        effective: pathRaw,
        expanded: expandEnv(pathRaw, base),
        total: allSegs.length,
        oursCount: segments.length,
        segments,
      },
    };
  });
}

// ============================================================================
// 只读环境变量检视辅助（供 env:inspect 使用，不修改任何系统状态）
// ============================================================================

/** 单个环境变量的检视条目 */
interface EnvVarEntryLocal {
  key: string;
  effective?: string;
  user?: string;
  system?: string;
  source: 'user' | 'system' | 'process' | 'none';
  expanded?: string;
  isVersionVar?: boolean;
  tool?: string;
}

/** PATH 中由本软件注入的段 */
interface EnvPathSegmentLocal {
  raw: string;
  ours: boolean;
  homeVar?: string;
  expanded?: string;
}

/** 读取某个注册表键下的所有值（名称 → 数据），失败返回空对象（非 Windows / 无权限时静默降级） */
function regQueryValues(key: string): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key], (err, stdout) => {
      if (err) {
        resolve({});
        return;
      }
      const map: Record<string, string> = {};
      for (const line of stdout.split(/\r?\n/)) {
        // 值行形如：`    Name    REG_SZ    Data` 或 `    Name    REG_EXPAND_SZ    Data`
        const m = line.match(/^\s+([A-Za-z_][\w]*)\s+REG_(?:EXPAND_)?SZ\s+(.*\S)\s*$/);
        if (m) map[m[1]] = m[2].trim();
      }
      resolve(map);
    });
  });
}

/** 读取用户级(HKCU)或系统级(HKLM)环境变量注册表 */
async function readRegEnv(scope: 'HKCU' | 'HKLM'): Promise<Record<string, string>> {
  const key =
    scope === 'HKCU'
      ? 'HKCU\\Environment'
      : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
  return regQueryValues(key);
}

/** 计算单个变量的生效值、来源层级、展开值 */
function buildEnvEntry(
  key: string,
  userEnv: Record<string, string>,
  systemEnv: Record<string, string>,
  base: Record<string, string | undefined>,
): EnvVarEntryLocal {
  const u = userEnv[key];
  const s = systemEnv[key];
  const p = process.env[key];
  let effective: string | undefined;
  let source: EnvVarEntryLocal['source'];
  if (u !== undefined) {
    effective = u;
    source = 'user';
  } else if (s !== undefined) {
    effective = s;
    source = 'system';
  } else if (p !== undefined) {
    effective = p;
    source = 'process';
  } else {
    effective = undefined;
    source = 'none';
  }
  return {
    key,
    effective,
    user: u,
    system: s,
    source,
    expanded: effective ? expandEnv(effective, base) : undefined,
  };
}
