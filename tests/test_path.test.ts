import { describe, it, expect } from 'vitest';
import { planInstallDir, planCacheDir, planInstallBaseDir, planDownloadDir, join, normalizeSep, CATEGORY_DIR } from '../src/utils/path.js';
import type { DevEnvConfig, ToolCategory } from '../src/types.js';

function cfg(partial: Partial<DevEnvConfig>): DevEnvConfig {
  return { version: 1, rootDir: 'E:\\a', download: { source: 'mirror', mirrors: {}, default: '', threads: 4 }, tools: [], profiles: {}, language: 'zh', ...partial };
}

describe('path planning', () => {
  const root = 'E:\\a';
  it('planInstallDir builds category/tool+version', () => {
    expect(planInstallDir(root, 'java' as ToolCategory, 'jdk', '17.0.9')).toBe('E:\\a\\java\\jdk17.0.9');
    expect(planInstallDir(root, 'database' as ToolCategory, 'mysql', '8.0.35')).toBe('E:\\a\\database\\mysql8.0.35');
  });
  it('planCacheDir points to config/cache', () => {
    expect(planCacheDir(root)).toBe('E:\\a\\config\\cache');
  });
  it('planInstallBaseDir defaults to <rootDir>/data/install and honors custom installDir', () => {
    expect(planInstallBaseDir(cfg({ rootDir: root }))).toBe('E:\\a\\data\\install');
    expect(planInstallBaseDir(cfg({ rootDir: root, installDir: 'D:\\myinstall' }))).toBe(normalizeSep('D:\\myinstall'));
    expect(planInstallBaseDir(cfg({ rootDir: root, installDir: '  ' }))).toBe('E:\\a\\data\\install'); // 空白视为未设置
  });
  it('planDownloadDir defaults to <rootDir>/data/download and honors custom downloadDir', () => {
    expect(planDownloadDir(cfg({ rootDir: root }))).toBe('E:\\a\\data\\download');
    expect(planDownloadDir(cfg({ rootDir: root, downloadDir: '/data/dl' }))).toBe(normalizeSep('/data/dl'));
    expect(planDownloadDir(cfg({ rootDir: root, downloadDir: '' }))).toBe('E:\\a\\data\\download');
  });
  it('planInstallDir under custom install base', () => {
    const base = planInstallBaseDir(cfg({ rootDir: root, installDir: 'D:\\myinstall' }));
    expect(planInstallDir(base, 'java' as ToolCategory, 'jdk', '17.0.9')).toBe(normalizeSep('D:\\myinstall\\java\\jdk17.0.9'));
  });
  it('CATEGORY_DIR matches spec', () => {
    expect(CATEGORY_DIR.java).toBe('java');
    expect(CATEGORY_DIR['build-tool']).toBe('build-tool');
    expect(CATEGORY_DIR.node).toBe('node');
    expect(CATEGORY_DIR.ide).toBe('ide');
    expect(CATEGORY_DIR.database).toBe('database');
    expect(CATEGORY_DIR.container).toBe('container');
    expect(CATEGORY_DIR.tool).toBe('tool');
  });
  it('join + normalizeSep', () => {
    expect(join('E:\\a', 'java', 'jdk17')).toBe('E:\\a\\java\\jdk17');
    expect(normalizeSep('E:/a//java')).toBe('E:/a/java');
  });
});
