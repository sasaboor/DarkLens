import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@/assets/shared.css';

console.log('[DarkLens] popup loaded');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
