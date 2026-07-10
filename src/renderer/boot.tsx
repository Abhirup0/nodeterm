import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import './tailwind.css'

// Note: StrictMode is intentionally not used — its double mount in dev would open
// two PTY sessions per terminal node.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(<App />)
