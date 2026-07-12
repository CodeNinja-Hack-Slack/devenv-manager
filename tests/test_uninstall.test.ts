import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { uninstallTool } from '../src/core/uninstall.js';
import { defaultConfig } from '../src/config/store.js';
import { DryRunEnv } from '../src/platform/env.js';
import { Logger } from '../src/utils/logger.js';
import { planInstallBaseDir, planInstallDir } from '../src/utils/path.js';
import type { InstalledTool } from '../src/types.js';

function makeCtx(rootDir: string) {
  const cfg = defaultConfig(rootDir);
  const env = new DryRunEnv('win32', '');
  const logger = new Logger(rootDir);
  return { cfg, env, logger };
}

function makeTool(over: Partial<InstalledTool>): InstalledTool {
  return {
    id: 'java/jdk/17.0.9',
    category: 'java',
    tool: 'jdk',
    name: 'JDK',
    version: '17.0.9',
    path: '',
    binPath: '',
    homeVar: 'JAVA_HOME',
    mode: 'offline',
    active: true,
    addedToPath: true,
    installedAt: new Date().toISOString(),
    ...over,
  };
}

describe('uninstallTool — 空父目录清理（安全边界）', () => {
  it('内部工具卸载后清理空的类别目录，但保留安装基目录', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'uninst-'));
    const prevHome = process.env.USERPROFILE;
    process.env.USERPROFILE = 'X:\\__none__'; // 使 tmp 不被判定为个人目录
    try {
      const ctx = makeCtx(root);
      const toolPath = planInstallDir(planInstallBaseDir(ctx.cfg), 'java', 'jdk', '17.0.9');
      const categoryDir = path.dirname(toolPath); // <installDir>/java
      const installBase = planInstallBaseDir(ctx.cfg); // <root>/data/install
      await fsp.mkdir(toolPath, { recursive: true });
      await fsp.writeFile(path.join(toolPath, 'bin_java'), '');

      ctx.cfg.tools = [makeTool({ path: toolPath, binPath: path.join(toolPath, 'bin') })];

      const r = await uninstallTool(ctx, 'java/jdk/17.0.9', {});
      expect(r.ok).toBe(true);
      // 工具目录已删
      await expect(fsp.access(toolPath)).rejects.toBeTruthy();
      // 空类别目录被清理
      const catExists = await fsp.access(categoryDir).then(() => true).catch(() => false);
      expect(catExists).toBe(false);
      // 安装基目录保留
      const baseExists = await fsp.access(installBase).then(() => true).catch(() => false);
      expect(baseExists).toBe(true);
      // 返回值记录了被删目录（工具 + 类别）
      expect(r.deleted).toContain(toolPath);
      expect(r.deleted).toContain(categoryDir);
    } finally {
      if (prevHome !== undefined) process.env.USERPROFILE = prevHome;
      else delete process.env.USERPROFILE;
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('非空类别目录不被误删（同级还有其它工具）', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'uninst-sib-'));
    const prevHome = process.env.USERPROFILE;
    process.env.USERPROFILE = 'X:\\__none__';
    try {
      const ctx = makeCtx(root);
      const target = planInstallDir(planInstallBaseDir(ctx.cfg), 'java', 'jdk', '17.0.9');
      const sibling = planInstallDir(planInstallBaseDir(ctx.cfg), 'java', 'jdk', '11.0.21');
      const categoryDir = path.dirname(target);
      await fsp.mkdir(target, { recursive: true });
      await fsp.mkdir(sibling, { recursive: true });
      await fsp.writeFile(path.join(target, 'x'), '');
      await fsp.writeFile(path.join(sibling, 'x'), '');

      ctx.cfg.tools = [makeTool({ id: 'java/jdk/17.0.9', path: target, binPath: path.join(target, 'bin') })];

      const r = await uninstallTool(ctx, 'java/jdk/17.0.9', {});
      expect(r.ok).toBe(true);
      // 目标已删，同级保留
      await expect(fsp.access(target)).rejects.toBeTruthy();
      const sibExists = await fsp.access(sibling).then(() => true).catch(() => false);
      expect(sibExists).toBe(true);
      // 类别目录因非空保留
      const catExists = await fsp.access(categoryDir).then(() => true).catch(() => false);
      expect(catExists).toBe(true);
      expect(r.deleted).not.toContain(categoryDir);
    } finally {
      if (prevHome !== undefined) process.env.USERPROFILE = prevHome;
      else delete process.env.USERPROFILE;
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('受控根之外的外部软件：删文件但不向上清理父级（更保守）', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'uninst2-'));
    const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'uninst-out-'));
    const prevHome = process.env.USERPROFILE;
    process.env.USERPROFILE = 'X:\\__none__';
    try {
      const ctx = makeCtx(root);
      const toolPath = path.join(outside, 'app');
      await fsp.mkdir(toolPath, { recursive: true });
      await fsp.writeFile(path.join(toolPath, 'x'), '');
      ctx.cfg.tools = [
        makeTool({ id: 'java/jdk/ext', mode: 'external', path: toolPath, binPath: path.join(toolPath, 'bin'), active: false, addedToPath: false }),
      ];

      const r = await uninstallTool(ctx, 'java/jdk/ext', { deleteFiles: true });
      expect(r.ok).toBe(true);
      await expect(fsp.access(toolPath)).rejects.toBeTruthy();
      // 受控根之外的父目录不被清理
      const parentExists = await fsp.access(outside).then(() => true).catch(() => false);
      expect(parentExists).toBe(true);
      expect(r.deleted).not.toContain(outside);
    } finally {
      if (prevHome !== undefined) process.env.USERPROFILE = prevHome;
      else delete process.env.USERPROFILE;
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(outside, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('位于自定义 installDir 之下的外部软件：清理到 installDir 为止', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'uninst3-'));
    const prevHome = process.env.USERPROFILE;
    process.env.USERPROFILE = 'X:\\__none__';
    try {
      const ctx = makeCtx(root);
      const installDir = path.join(root, 'my-install'); // 模拟 E:\Software
      ctx.cfg.installDir = installDir;
      const toolPath = path.join(installDir, 'tools', 'jdk'); // 外部工具落在 installDir 之下
      await fsp.mkdir(toolPath, { recursive: true });
      await fsp.writeFile(path.join(toolPath, 'x'), '');
      ctx.cfg.tools = [
        makeTool({ id: 'java/jdk/ext2', mode: 'external', path: toolPath, binPath: path.join(toolPath, 'bin'), active: false, addedToPath: false }),
      ];

      const r = await uninstallTool(ctx, 'java/jdk/ext2', { deleteFiles: true });
      expect(r.ok).toBe(true);
      await expect(fsp.access(toolPath)).rejects.toBeTruthy();
      // tools/ 空了被清理
      const toolsDir = path.dirname(toolPath);
      const toolsExists = await fsp.access(toolsDir).then(() => true).catch(() => false);
      expect(toolsExists).toBe(false);
      // 但 installDir（共享根）本身保留
      const baseExists = await fsp.access(installDir).then(() => true).catch(() => false);
      expect(baseExists).toBe(true);
      expect(r.deleted).not.toContain(installDir);
    } finally {
      if (prevHome !== undefined) process.env.USERPROFILE = prevHome;
      else delete process.env.USERPROFILE;
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
