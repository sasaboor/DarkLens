import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@/assets/shared.css';

console.log('[DarkLens] sidepanel loaded');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
