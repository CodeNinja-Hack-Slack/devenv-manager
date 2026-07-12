import type { ArchiveFormat, RecognizedPackage, ToolCategory } from '../types.js';

// ============================================================================
// 离线安装包识别（纯函数，可单测）
// 优先级：文件名正则 → 包内版本文件（这里仅做文件名解析，包内提取在 extractor 阶段）
// ============================================================================

interface ToolMatcher {
  tool: string;
  name: string;
  category: ToolCategory;
  homeVar?: string;
  keywords: RegExp; // 命中文件名即可识别工具
  version: RegExp; // 从文件名提取版本
}

const MATCHERS: ToolMatcher[] = [
  { tool: 'jdk', name: 'JDK', category: 'java', homeVar: 'JAVA_HOME', keywords: /jdk|openjdk|adoptium|java/i, version: /(\d+\.\d+\.\d+(?:_\d+)?|\d+u\d+)/ },
  { tool: 'maven', name: 'Maven', category: 'build-tool', homeVar: 'MAVEN_HOME', keywords: /maven/i, version: /(\d+\.\d+\.\d+)/ },
  { tool: 'gradle', name: 'Gradle', category: 'build-tool', homeVar: 'GRADLE_HOME', keywords: /gradle/i, version: /(\d+\.\d+(?:\.\d+)?)/ },
  { tool: 'node', name: 'Node.js', category: 'node', keywords: /node/i, version: /(v?\d+\.\d+\.\d+)/ },
  { tool: 'idea', name: 'IntelliJ IDEA', category: 'ide', keywords: /idea|intellij/i, version: /(\d{4}\.\d+|\d+\.\d+)/ },
  { tool: 'vscode', name: 'VS Code', category: 'ide', keywords: /vscode|visual[- ]?studio[- ]?code|code/i, version: /(\d+\.\d+\.\d+)/ },
  { tool: 'eclipse', name: 'Eclipse', category: 'ide', keywords: /eclipse/i, version: /(\d+\.\d+(?:\.\d+)?)/ },
  { tool: 'mysql', name: 'MySQL', category: 'database', keywords: /mysql/i, version: /(\d+\.\d+\.\d+)/ },
  { tool: 'postgres', name: 'PostgreSQL', category: 'database', homeVar: 'PGHOME', keywords: /postgre/i, version: /(\d+\.\d+)/ },
  { tool: 'redis', name: 'Redis', category: 'database', keywords: /redis/i, version: /(\d+\.\d+\.\d+)/ },
  { tool: 'docker', name: 'Docker', category: 'container', keywords: /docker/i, version: /(\d+\.\d+\.\d+)/ },
  { tool: 'git', name: 'Git', category: 'tool', keywords: /git/i, version: /(\d+\.\d+\.\d+)/ },
  { tool: 'curl', name: 'curl', category: 'tool', keywords: /curl/i, version: /(\d+\.\d+\.\d+)/ },
  { tool: 'wget', name: 'wget', category: 'tool', keywords: /wget/i, version: /(\d+\.\d+\.\d+)/ },
];

export function detectFormat(fileName: string): ArchiveFormat {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.tar.xz') || lower.endsWith('.txz')) return 'tar.xz';
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tar.gz';
  if (lower.endsWith('.zip')) return 'zip';
  if (lower.endsWith('.msi')) return 'msi';
  if (lower.endsWith('.exe')) return 'exe';
  if (lower.endsWith('.dmg')) return 'dmg';
  return 'unknown';
}

/**
 * 从文件名识别安装包信息。识别失败返回 null（由调用方触发手动选择）。
 */
export function recognizePackage(fileName: string): RecognizedPackage | null {
  const format = detectFormat(fileName);
  const matched = MATCHERS.find((m) => m.keywords.test(fileName));
  if (!matched) return null;

  const vm = fileName.match(matched.version);
  if (!vm) return null;

  let version = vm[1];
  if (matched.tool === 'node' && version.startsWith('v')) version = version.slice(1);

  return {
    tool: matched.tool,
    name: matched.name,
    category: matched.category,
    version,
    format,
    source: 'filename',
    confidence: 0.9,
  };
}

/** 供调用方在“包内识别”后修正/补全时复用 */
export function makeRecognized(
  tool: string,
  name: string,
  category: ToolCategory,
  version: string,
  format: ArchiveFormat,
): RecognizedPackage {
  return { tool, name, category, version, format, source: 'manual', confidence: 1 };
}
