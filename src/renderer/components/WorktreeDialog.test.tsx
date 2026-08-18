// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDialogStack } from './dialog-stack'
import { WorktreeDialog } from './WorktreeDialog'
import type { WorktreeEntry } from '@shared/worktree'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const existing: WorktreeEntry[] = [
  { path: '/repo.wt/feature-login', branch: 'feature/login', head: 'a', isBare: false },
  { path: '/repo.wt/fix-api', branch: 'fix/api', head: 'b', isBare: false }
]

describe('WorktreeDialog existing-worktree search', () => {
  let root: Root | undefined
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => {
    act(() => root?.unmount())
    root = undefined
    host.remove()
    resetDialogStack()
  })

  it('filters the scrollable picker by branch or path', () => {
    root = createRoot(host)
    act(() => {
      root!.render(
        <WorktreeDialog
          intent="create"
          repoPath="/repo"
          existing={existing}
          defaultBaseRef="main"
          branches={[]}
          defaultPath={() => '/repo.wt/feature'}
          busy={false}
          error={null}
          onCreate={vi.fn()}
          onBindExisting={vi.fn()}
          onCancel={vi.fn()}
        />
      )
    })

    const search = document.querySelector<HTMLInputElement>(
      '[aria-label="Search existing worktrees"]'
    )!
    expect(document.querySelectorAll('.bind-existing__row')).toHaveLength(2)
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'LOGIN')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const rows = [...document.querySelectorAll('.bind-existing__row')]
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('feature/login')
  })
})
