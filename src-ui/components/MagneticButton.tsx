import React from 'react';
import { motion, useMotionValue, useSpring } from 'framer-motion';

/** 磁吸按钮：光标靠近时轻微吸附，提升“高级感”微交互 */
export function MagneticButton({
  children,
  className = 'btn',
  onClick,
  disabled,
  type = 'button',
}: {
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 220, damping: 16 });
  const sy = useSpring(y, { stiffness: 220, damping: 16 });

  const onMove = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled) return;
    const r = e.currentTarget.getBoundingClientRect();
    x.set((e.clientX - r.left - r.width / 2) / 7);
    y.set((e.clientY - r.top - r.height / 2) / 7);
  };
  const reset = () => {
    x.set(0);
    y.set(0);
  };

  return (
    <motion.button
      type={type}
      className={className}
      style={{ x: sx, y: sy }}
      onMouseMove={onMove}
      onMouseLeave={reset}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </motion.button>
  );
}
