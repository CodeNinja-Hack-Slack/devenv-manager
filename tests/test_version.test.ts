import { describe, it, expect } from 'vitest';
import { normalizeJdkVersion, parseVersion, compareVersions, majorVersion } from '../src/utils/version.js';

describe('version utils', () => {
  it('normalizeJdkVersion: 1.8 -> 8', () => {
    expect(normalizeJdkVersion('1.8.0_392')).toBe('8.0');
    expect(normalizeJdkVersion('1.8.0_202')).toBe('8.0');
  });
  it('normalizeJdkVersion: 11/17 不变', () => {
    expect(normalizeJdkVersion('17.0.9')).toBe('17.0.9');
    expect(normalizeJdkVersion('11.0.21')).toBe('11.0.21');
  });
  it('parseVersion splits into numbers', () => {
    expect(parseVersion('17.0.9')).toEqual([17, 0, 9]);
  });
  it('compareVersions orders correctly', () => {
    expect(compareVersions('8.0', '17.0.9')).toBe(-1);
    expect(compareVersions('17.0.13', '17.0.9')).toBe(1);
    expect(compareVersions('17.0.9', '17.0.9')).toBe(0);
    expect(compareVersions('1.8.0_392', '8.0')).toBe(0); // 归一化后相等
  });
  it('majorVersion', () => {
    expect(majorVersion('17.0.9')).toBe(17);
    expect(majorVersion('1.8.0_392')).toBe(8);
  });
});
