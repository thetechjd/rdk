import React from 'react';
import { createRoot } from 'react-dom/client';
import './theme.css';
import { App } from './App';
import { applyTheme, loadTheme } from './theme';

applyTheme(loadTheme());

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
