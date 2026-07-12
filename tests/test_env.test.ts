import { describe, it, expect } from 'vitest';
import {
  splitPath,
  addToPath,
  removeFromPath,
  prioritizePath,
  joinPath,
  DryRunEnv,
} from '../src/platform/env.js';

describe('env path pure functions', () => {
  it('splitPath handles win/uni separators', () => {
    expect(splitPath('A\\B;C\\D')).toEqual(['A\\B', 'C\\D']);
    expect(splitPath('/a:/b')).toEqual(['/a', '/b']);
    expect(splitPath('')).toEqual([]);
    expect(splitPath(undefined)).toEqual([]);
  });
  it('addToPath is idempotent', () => {
    const a = addToPath(['/x', '/y'], '/z');
    expect(a).toEqual(['/x', '/y', '/z']);
    expect(addToPath(a, '/z')).toEqual(a); // 已存在不重复
  });
  it('removeFromPath case-insensitive match', () => {
    expect(removeFromPath(['/X/bin', '/Y'], '/x/bin')).toEqual(['/Y']);
  });
  it('prioritizePath moves to front', () => {
    expect(prioritizePath(['/a', '/b', '/c'], '/c')).toEqual(['/c', '/a', '/b']);
  });
  it('joinPath picks separator by platform', () => {
    expect(joinPath(['C:\\a', 'C:\\b'])).toBe('C:\\a;C:\\b');
    // Windows 一律用 ';'（即便条目是 %VAR% 引用或 unix 风格路径，也不再用 ':')；
    // 这正是修复“%JAVA_HOME%\bin:%JAVA_HOME17%\bin 非法 Path”的关键。
    expect(joinPath(['/a', '/b'])).toBe(process.platform === 'win32' ? '/a;/b' : '/a:/b');
    expect(joinPath(['%JAVA_HOME%\\bin', '%JAVA_HOME17%\\bin'])).toBe(
      process.platform === 'win32' ? '%JAVA_HOME%\\bin;%JAVA_HOME17%\\bin' : '%JAVA_HOME%\\bin:%JAVA_HOME17%\\bin',
    );
  });
});

describe('DryRunEnv records ops without touching system', () => {
  it('set/appendPath/prioritize produce preview ops', async () => {
    const env = new DryRunEnv('win32', 'C:\\old\\bin');
    await env.set('JAVA_HOME', 'E:\\a\\java\\jdk17');
    await env.appendPath('E:\\a\\java\\jdk17\\bin');
    await env.prioritizePathVar('E:\\a\\java\\jdk17\\bin');
    const ops = env.preview();
    expect(ops).toContainEqual({ kind: 'set', name: 'JAVA_HOME', value: 'E:\\a\\java\\jdk17' });
    const pathGet = await env.get('PATH');
    expect(pathGet).toContain('E:\\a\\java\\jdk17\\bin');
  });
});
