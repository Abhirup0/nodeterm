import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountIdentityPills } from './AccountIdentityPills'

describe('AccountIdentityPills', () => {
  it('renders identity and provenance from the same presentation object', () => {
    const html = renderToStaticMarkup(
      <AccountIdentityPills
        account={{
          identity: 'Work',
          provenance: 'SSH · Ubuntu WSL',
          tooltip: 'Work (me@example.com) · SSH corvin@devbox'
        }}
        selected
      />
    )
    expect(html).toContain('Work')
    expect(html).toContain('SSH · Ubuntu WSL')
    expect(html).toContain('Selected')
    // The credential-storage kind must never reach the DOM.
    expect(html).not.toContain('system')
    expect(html).not.toContain('managed')
  })

  it('omits the selected check unless the account is chosen', () => {
    const html = renderToStaticMarkup(
      <AccountIdentityPills
        account={{ identity: 'Home', provenance: 'Local', tooltip: 'Home · This Mac' }}
      />
    )
    expect(html).not.toContain('Selected')
  })
})
