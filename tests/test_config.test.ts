import { describe, it, expect } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, saveConfig, loadConfig } from '../src/config/store.js';

describe('config store roundtrip', () => {
  it('saves and loads devenv.yaml', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfg-'));
    const cfg = defaultConfig(root);
    cfg.download.threads = 8;
    cfg.tools = [
      {
        id: 'java/jdk/17.0.9', category: 'java', tool: 'jdk', name: 'JDK', version: '17.0.9',
        path: path.join(root, 'java', 'jdk17.0.9'), binPath: path.join(root, 'java', 'jdk17.0.9', 'bin'),
        homeVar: 'JAVA_HOME', mode: 'online', active: true, addedToPath: true, installedAt: new Date().toISOString(),
      },
    ];
    await saveConfig(cfg);
    const loaded = await loadConfig(root);
    expect(loaded).not.toBeNull();
    expect(loaded!.rootDir).toBe(root);
    expect(loaded!.download.threads).toBe(8);
    expect(loaded!.tools).toHaveLength(1);
    expect(loaded!.tools[0].version).toBe('17.0.9');
  });

  it('loadConfig returns null when missing', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'cfg2-'));
    expect(await loadConfig(root)).toBeNull();
  });
});
