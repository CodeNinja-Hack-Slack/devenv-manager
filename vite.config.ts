import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

// 把 `import './x.js'` 映射到 `./x.ts`（NodeNext 风格导入，兼容 Vite/Vitest）
function tsExtensionPlugin() {
  return {
    name: 'ts-ext-resolver',
    resolveId(source: string, importer?: string) {
      if (importer && source.startsWith('.') && source.endsWith('.js')) {
        const tsPath = path.resolve(path.dirname(importer), source.replace(/\.js$/, '.ts'));
        if (fs.existsSync(tsPath)) return tsPath;
      }
      return null;
    },
  };
}

// 渲染层（React UI）构建配置。
// base 设为 './' 以便 Electron 用 file:// 协议加载；
// 引擎层 src/ 同时被主进程(Node) 与测试(Vitest) 复用。
export default defineConfig({
  root: 'src-ui',
  base: './',
  plugins: [react(), tsExtensionPlugin()],
  build: {
    outDir: '../dist-ui',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
    open: true,
    host: true,
  },
  test: {
    environment: 'node',
    root: process.cwd(),
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
});
