/*
 * THE FACES, LOADED (prd-32 ruling 1). `theme.css` has named Inter and
 * JetBrains Mono since prd3 and nothing ever shipped them, so every session
 * until now ran in Segoe UI and Consolas — the identity was a comment.
 *
 * Self-hosted, and that is the ruling rather than a preference: the instrument
 * is localhost-only, so a CDN link is a request that fails on the one machine
 * the app is for. These packages carry the woff2 files themselves; Vite bundles
 * them as assets and a cold start on a fresh profile makes no network request
 * for type.
 *
 * Imported here rather than from `index.css` so the dependency is visible at
 * the entry point — the faces are part of what the app *is*, not a detail of
 * how it is painted. Both are variable fonts: one file per subset covers every
 * weight the instrument uses.
 */
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('missing #root element')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
