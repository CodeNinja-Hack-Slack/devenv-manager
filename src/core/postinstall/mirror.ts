import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import type { InstallStep } from '../../types.js';

// ============================================================================
// Maven / Gradle 国内镜像步骤（可选安装项）
// ----------------------------------------------------------------------------
// 用户可在安装页勾选「使用国内镜像（阿里云）」；勾选时 installer 把对应步骤追加到管线末尾。
// - Maven：写入 ~/.m2/settings.xml，配置阿里云 public 镜像（mirrorOf=* 覆盖所有仓库）
// - Gradle：写入 ~/.gradle/init.gradle，把所有 mavenCentral/jcenter 仓库替换为阿里云
// 仅在 applyEnv（真实模式）下写文件；dryRun 下跳过，绝不触碰用户目录。
// ============================================================================

/** 生成 Maven 的 settings.xml（国内镜像，覆盖所有仓库） */
export function buildMavenSettingsXml(mirrorUrl = 'https://maven.aliyun.com/repository/public'): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 http://maven.apache.org/xsd/settings-1.0.0.xsd">
  <mirrors>
    <mirror>
      <id>custom-mirror</id>
      <mirrorOf>*</mirrorOf>
      <name>Custom Mirror Repository</name>
      <url>${mirrorUrl}</url>
    </mirror>
  </mirrors>
</settings>
`;
}

/** 生成 Gradle 的 init.gradle（全局替换中央仓库为国内镜像） */
export function buildGradleInitScript(mirrorUrl = 'https://maven.aliyun.com/repository/public'): string {
  return `allprojects {
    repositories {
        def ALIYUN_REPOSITORY_URL = '${mirrorUrl}'
        all { ArtifactRepository repo ->
            if (repo instanceof MavenArtifactRepository) {
                def url = repo.url.toString()
                if (url.startsWith('https://repo1.maven.org/maven2') ||
                    url.startsWith('https://repo.maven.apache.org/maven2') ||
                    url.startsWith('https://jcenter.bintray.com')) {
                    remove repo
                }
            }
        }
        maven { url ALIYUN_REPOSITORY_URL }
    }
}
`;
}

const DEFAULT_MIRROR = 'https://maven.aliyun.com/repository/public';

/** Maven：写入 ~/.m2/settings.xml（可选，仅当用户勾选国内镜像） */
export const mavenMirrorStep: InstallStep = {
  id: 'maven:mirror',
  title: '配置国内镜像（阿里云）',
  description: '写入 ~/.m2/settings.xml 国内镜像，加速依赖下载',
  optional: true,
  computeParams: () => [
    { key: 'mirrorUrl', label: '镜像仓库地址', type: 'text', value: DEFAULT_MIRROR, hint: '可改为其它镜像源' },
  ],
  preview: (ctx, v) => ({
    files: [{ path: path.join(os.homedir(), '.m2', 'settings.xml'), note: `写入镜像（${v.mirrorUrl}）` }],
  }),
  run: async (ctx: any): Promise<any> => {
    if (!ctx.applyEnv) return { ok: true, message: '[dryRun] 跳过写入 ~/.m2/settings.xml' };
    const url = (ctx.params?.mirrorUrl as string) || DEFAULT_MIRROR;
    const settingsPath = path.join(os.homedir(), '.m2', 'settings.xml');
    await fsp.mkdir(path.dirname(settingsPath), { recursive: true });
    await fsp.writeFile(settingsPath, buildMavenSettingsXml(url), 'utf8');
    return { ok: true, message: `已写入 ${settingsPath}` };
  },
};

/** Gradle：写入 ~/.gradle/init.gradle（可选，仅当用户勾选国内镜像） */
export const gradleMirrorStep: InstallStep = {
  id: 'gradle:mirror',
  title: '配置国内镜像（阿里云）',
  description: '写入 ~/.gradle/init.gradle 国内镜像，加速依赖下载',
  optional: true,
  computeParams: () => [
    { key: 'mirrorUrl', label: '镜像仓库地址', type: 'text', value: DEFAULT_MIRROR, hint: '可改为其它镜像源' },
  ],
  preview: (ctx, v) => ({
    files: [{ path: path.join(os.homedir(), '.gradle', 'init.gradle'), note: `写入镜像（${v.mirrorUrl}）` }],
  }),
  run: async (ctx: any): Promise<any> => {
    if (!ctx.applyEnv) return { ok: true, message: '[dryRun] 跳过写入 ~/.gradle/init.gradle' };
    const url = (ctx.params?.mirrorUrl as string) || DEFAULT_MIRROR;
    const initPath = path.join(os.homedir(), '.gradle', 'init.gradle');
    await fsp.mkdir(path.dirname(initPath), { recursive: true });
    await fsp.writeFile(initPath, buildGradleInitScript(url), 'utf8');
    return { ok: true, message: `已写入 ${initPath}` };
  },
};
