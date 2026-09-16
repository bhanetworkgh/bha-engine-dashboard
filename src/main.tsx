import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { SessionProvider } from './app/session';
import { ThemeProvider } from './app/theme';
import { ZoomProvider } from './app/zoom';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <ZoomProvider>
          <SessionProvider>
            <App />
          </SessionProvider>
        </ZoomProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
