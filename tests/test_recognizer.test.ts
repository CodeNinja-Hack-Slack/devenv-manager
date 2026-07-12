import { describe, it, expect } from 'vitest';
import { recognizePackage, detectFormat } from '../src/core/recognizer.js';

describe('offline package recognizer', () => {
  it('recognizes JDK from filename', () => {
    const r = recognizePackage('jdk-17.0.9_windows-x64_bin.zip');
    expect(r).not.toBeNull();
    expect(r!.tool).toBe('jdk');
    expect(r!.category).toBe('java');
    expect(r!.version).toBe('17.0.9');
    expect(r!.format).toBe('zip');
  });
  it('recognizes Maven', () => {
    const r = recognizePackage('apache-maven-3.9.6-bin.zip');
    expect(r!.tool).toBe('maven');
    expect(r!.version).toBe('3.9.6');
  });
  it('recognizes MySQL (winx64)', () => {
    const r = recognizePackage('mysql-8.0.35-winx64.zip');
    expect(r!.tool).toBe('mysql');
    expect(r!.version).toBe('8.0.35');
  });
  it('recognizes Node and strips v', () => {
    const r = recognizePackage('node-v20.11.1-win-x64.zip');
    expect(r!.tool).toBe('node');
    expect(r!.version).toBe('20.11.1');
  });
  it('detects format from extension', () => {
    expect(detectFormat('a.tar.gz')).toBe('tar.gz');
    expect(detectFormat('a.tgz')).toBe('tar.gz');
    expect(detectFormat('a.msi')).toBe('msi');
    expect(detectFormat('a.exe')).toBe('exe');
    expect(detectFormat('a.dmg')).toBe('dmg');
    expect(detectFormat('a.xyz')).toBe('unknown');
  });
  it('returns null for unknown tool', () => {
    expect(recognizePackage('randomfile.zip')).toBeNull();
  });
});
