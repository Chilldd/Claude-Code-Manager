import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { ThemeProvider } from './contexts/ThemeContext'
import { SessionProvider } from './contexts/SessionContext'
import { ErrorBoundary } from './components/shared/ErrorBoundary'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <SessionProvider>
        <ErrorBoundary name="App">
          <App />
        </ErrorBoundary>
      </SessionProvider>
    </ThemeProvider>
  </StrictMode>,
)
