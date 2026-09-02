// @vitest-environment jsdom
//
// The web picker's "New folder" flow, end to end through the real `openDirectoryPicker` promise
// (which is what `ws-bridge` / `relay-api` call). What is pinned here is the FLOW — create, step
// in, Open — plus the two ways the button must be absent and the two ways a refusal must be
// visible. The path rules themselves live in `dialog-picker.test.ts`.
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../shared/types'
import { openDirectoryPicker, type PickerMkdirDeps } from './dialog-picker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** A tiny in-memory server fs: `dirs` is the set of absolute directories that exist. */
function fakeFs(dirs: string[] = ['/home']): {
  list: (p: string) => Promise<DirEntry[]>
  write: PickerMkdirDeps
  made: string[]
} {
  const set = new Set(dirs)
  const made: string[] = []
  return {
    list: async (p) => {
      const base = p.length > 1 ? p.replace(/\/+$/, '') : p
      return [...set]
        .filter((d) => d !== base && d.slice(0, base === '/' ? 1 : base.length + 1) === (base === '/' ? '/' : `${base}/`))
        .filter((d) => !d.slice(base === '/' ? 1 : base.length + 1).includes('/'))
        .map((d) => ({ name: d.slice(d.lastIndexOf('/') + 1), dir: true }))
    },
    write: {
      exists: async (p) => set.has(p),
      mkdir: async (p) => {
        made.push(p)
        set.add(p)
        return true
      }
    },
    made
  }
}

const $ = <T extends Element>(sel: string): T | null => document.body.querySelector<T>(sel)
const click = async (el: Element | null): Promise<void> => {
  await act(async () => {
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}
const type = async (el: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    // React tracks the value on the DOM node; bypass its dedupe so `onChange` fires.
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
/** Flush the picker's initial async listing (it lands after the first paint). */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

// The picker root is a module singleton (one container appended to <body>, reused for every
// call — exactly as in the app), so tests must NOT wipe <body>: a fresh `openDirectoryPicker`
// re-renders into it and unmounts whatever the previous test left open.

describe('web folder picker — New folder', () => {
  it('creates the folder, steps into it, and "Use this folder" returns it', async () => {
    const fs = fakeFs(['/home'])
    let resolved: string | null | undefined
    await act(async () => {
      void openDirectoryPicker({
        mode: 'folder',
        startDir: '/home',
        list: fs.list,
        write: fs.write
      }).then((r) => {
        resolved = r
      })
    })
    await settle()

    await click($('.dir-picker__new'))
    const input = $<HTMLInputElement>('.dir-picker__input')
    expect(input).not.toBeNull()
    await type(input as HTMLInputElement, 'newproj')
    await click($('.dir-picker__create .confirm__btn.primary'))
    await settle()

    expect(fs.made).toEqual(['/home/newproj'])
    // Stepped INTO it: the path line is the new folder, and the create form is gone.
    expect($('.dir-picker__path')?.textContent).toBe('/home/newproj')
    expect($('.dir-picker__input')).toBeNull()

    await click($('.confirm__actions .confirm__btn.primary'))
    expect(resolved).toBe('/home/newproj')
  })

  it('shows a readable error and keeps the form open when the name is taken', async () => {
    const fs = fakeFs(['/home', '/home/taken'])
    await act(async () => {
      void openDirectoryPicker({ mode: 'folder', startDir: '/home', list: fs.list, write: fs.write })
    })
    await settle()

    await click($('.dir-picker__new'))
    await type($<HTMLInputElement>('.dir-picker__input') as HTMLInputElement, 'taken')
    await click($('.dir-picker__create .confirm__btn.primary'))
    await settle()

    expect($('.dir-picker__error')?.textContent).toBe('Already exists: /home/taken')
    expect($('.dir-picker__input')).not.toBeNull() // still editable, nothing silently dropped
    expect(fs.made).toEqual([])
    expect($('.dir-picker__path')?.textContent).toBe('/home') // did not navigate
  })

  it('surfaces a rejected mkdir instead of doing nothing', async () => {
    const fs = fakeFs(['/home'])
    const write: PickerMkdirDeps = { exists: fs.write.exists, mkdir: vi.fn(async () => false) }
    await act(async () => {
      void openDirectoryPicker({ mode: 'folder', startDir: '/home', list: fs.list, write })
    })
    await settle()

    await click($('.dir-picker__new'))
    await type($<HTMLInputElement>('.dir-picker__input') as HTMLInputElement, 'nope')
    await click($('.dir-picker__create .confirm__btn.primary'))
    await settle()

    expect($('.dir-picker__error')?.textContent).toBe('Could not create /home/nope')
  })

  it('Escape backs out of the create form before it closes the picker', async () => {
    const fs = fakeFs(['/home'])
    let resolved: string | null | undefined
    let settled = false
    await act(async () => {
      void openDirectoryPicker({
        mode: 'folder',
        startDir: '/home',
        list: fs.list,
        write: fs.write
      }).then((r) => {
        resolved = r
        settled = true
      })
    })
    await settle()

    await click($('.dir-picker__new'))
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect($('.dir-picker__input')).toBeNull()
    expect(settled).toBe(false) // the picker itself is still open

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(settled).toBe(true)
    expect(resolved).toBeNull()
  })

  it('offers no button in file mode, or when the caller passes no write deps', async () => {
    const fs = fakeFs(['/home'])
    await act(async () => {
      void openDirectoryPicker({ mode: 'file', startDir: '/home', list: fs.list, write: fs.write })
    })
    await settle()
    expect($('.dir-picker__new')).toBeNull()

    // Re-rendering the shared root replaces the file-mode picker with this one.
    await act(async () => {
      void openDirectoryPicker({ mode: 'folder', startDir: '/home', list: fs.list })
    })
    await settle()
    expect($('.dir-picker__new')).toBeNull()
  })
})
