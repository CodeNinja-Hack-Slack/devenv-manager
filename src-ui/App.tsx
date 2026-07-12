import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from './store/useStore';
import { Sidebar } from './components/Sidebar';
import { AmbientBackground } from './components/AmbientBackground';
import { Toast } from './components/Toast';
import { Dashboard } from './pages/Dashboard';
import { Scanner } from './pages/Scanner';
import { Install } from './pages/Install';
import { SwitchPage } from './pages/Switch';
import { EnvManager } from './pages/EnvManager';
import { Profiles } from './pages/Profiles';
import { Settings } from './pages/Settings';
import { SetupWizard } from './components/SetupWizard';
import type { PageKey } from './store/useStore';

const PAGES: Record<PageKey, React.FC> = {
  dashboard: Dashboard,
  scanner: Scanner,
  install: Install,
  switch: SwitchPage,
  env: EnvManager,
  profiles: Profiles,
  settings: Settings,
};

export default function App() {
  const page = useStore((s) => s.page);
  const configured = useStore((s) => s.configured);
  const Page = PAGES[page];

  // 未配置根目录：先引导用户指定安装根目录，再进入主界面
  if (!configured) {
    return (
      <>
        <AmbientBackground />
        <SetupWizard />
      </>
    );
  }

  return (
    <>
      <AmbientBackground />
      <div className="app">
        <Sidebar />
        <main className="main">
          <AnimatePresence mode="wait">
            <motion.div
              key={page}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            >
              <Page />
            </motion.div>
          </AnimatePresence>
        </main>
      </div>
      <Toast />
    </>
  );
}
