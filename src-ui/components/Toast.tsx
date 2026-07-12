import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../store/useStore';

export function Toast() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toast-wrap">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            className={`toast ${t.type}`}
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
          >
            {t.msg}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}
