import React from 'react';

export function GlassCard({ title, children, className = '', style }: {
  title?: string;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div className={`glass card ${className}`} style={style}>
      {title && <h3 className="card-title">{title}</h3>}
      {children}
    </div>
  );
}
