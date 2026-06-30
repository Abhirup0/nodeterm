// Ambient declaration for Electron's `<webview>` tag so TSX recognizes it as an intrinsic
// element. Kept minimal (just `src`); the tag is deliberately used without `nodeintegration`
// so the embedded content stays sandboxed.
import type React from 'react'

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { src?: string },
        HTMLElement
      >
    }
  }
}
