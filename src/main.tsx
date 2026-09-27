import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { LiveProvider } from './app/live';
import { SessionProvider } from './app/session';
import { LookProvider } from './app/look';
import { ThemeProvider } from './app/theme';
import { ZoomProvider } from './app/zoom';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ThemeProvider>
        <LookProvider>
        <ZoomProvider>
          <SessionProvider>
            <LiveProvider>
              <App />
            </LiveProvider>
          </SessionProvider>
        </ZoomProvider>
        </LookProvider>
      </ThemeProvider>
    </BrowserRouter>
  </StrictMode>,
);
