import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/premium.css';
import { useStore } from './store/useStore';
import { initTheme } from './theme';

initTheme();
useStore.getState().init();

createRoot(document.getElementById('root')!).render(<App />);
