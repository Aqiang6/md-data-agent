import { createRoot } from 'react-dom/client'
import { App } from './App.tsx'
import { ErrorBoundary } from './ErrorBoundary.tsx'
import './style.css'

const root = document.getElementById('root')
if (root === null) throw new Error('dataagent-ui: #root is missing')
createRoot(root).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)
