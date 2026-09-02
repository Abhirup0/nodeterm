import { describe, it, expect } from 'vitest'
import {
  CONTENT_ADD_ITEMS,
  contentAddItemsToMenuItems,
  contentAddItemsToDockRows,
  NEW_FILE_NO_CWD_HINT,
  WORKTREE_NO_CWD_HINT,
  WORKTREE_SSH_HINT,
  type AddItem,
  type AddHandlers
} from './addMenuSpec'

const noop = () => {}
const handlers = (overrides: Partial<AddHandlers> = {}): AddHandlers => ({
  terminal: noop,
  remote: noop,
  browser: noop,
  web: noop,
  sticky: noop,
  dino: noop,
  trigger: noop,
  openFile: noop,
  newFile: noop,
  spawnTeam: noop,
  worktree: noop,
  ...overrides
})

const allKinds: AddItem['kind'][] = [
  'terminal',
  'remote',
  'browser',
  'web',
  'sticky',
  'dino',
  'trigger',
  'open-file',
  'new-file',
  'spawn-team',
  'worktree'
]

describe('CONTENT_ADD_ITEMS', () => {
  it('lists every content kind in the canonical order', () => {
    expect(CONTENT_ADD_ITEMS.map((i) => i.kind)).toEqual(allKinds)
  })
})

describe('contentAddItemsToMenuItems', () => {
  it('emits a MenuItem for every kind that should show (cwd + non-ssh)', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: false
    })
    const labels = items.map((i) => ('label' in i ? i.label : null))
    // "New file…" shows because hasCwd; worktree is enabled (not ssh).
    expect(labels).toEqual([
      'New terminal',
      'New remote…',
      'New browser',
      'New web view…',
      'New sticky note',
      'New dino game',
      'New trigger…',
      'Open file…',
      'New file…',
      'Spawn a team…',
      'New worktree…'
    ])
  })

  // A cwd-less project is a supported, persisted canvas — the folder-shaped rows must degrade
  // EXPLICITLY (the SSH worktree row's rule), not vanish. Hiding them left the user with no row and
  // no reason, and the fix ("Set folder…") one menu away with nothing pointing at it.
  it('DISABLES "New file…" with its reason when the project has no cwd — never hides it', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const newFile = items.find((i) => 'label' in i && i.label === 'New file…')
    expect(newFile).toBeDefined()
    expect(newFile && 'disabled' in newFile && newFile.disabled).toBe(true)
    expect(newFile && 'hint' in newFile && newFile.hint).toBe(NEW_FILE_NO_CWD_HINT)
  })

  it('disables "New worktree…" with its own reason on a cwd-less project', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const worktree = items.find((i) => 'label' in i && i.label === 'New worktree…')
    expect(worktree && 'disabled' in worktree && worktree.disabled).toBe(true)
    expect(worktree && 'hint' in worktree && worktree.hint).toBe(WORKTREE_NO_CWD_HINT)
  })

  it('keeps the SSH reason on an SSH project that also has no cwd — the stronger one wins', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: true
    })
    const worktree = items.find((i) => 'label' in i && i.label === 'New worktree…')
    expect(worktree && 'hint' in worktree && worktree.hint).toBe(WORKTREE_SSH_HINT)
  })

  it('disables "New worktree…" on an SSH project and surfaces the hint', () => {
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: true
    })
    const worktree = items.find((i) => 'label' in i && i.label === 'New worktree…')
    expect(worktree).toBeDefined()
    expect(worktree && 'disabled' in worktree && worktree.disabled).toBe(true)
    expect(worktree && 'hint' in worktree && worktree.hint).toBeTruthy()
  })

  it('wires each handler to its item', () => {
    const calls: string[] = []
    const h = handlers({
      terminal: () => calls.push('terminal'),
      browser: () => calls.push('browser'),
      web: () => calls.push('web'),
      sticky: () => calls.push('sticky'),
      dino: () => calls.push('dino'),
      spawnTeam: () => calls.push('spawnTeam'),
      worktree: () => calls.push('worktree')
    })
    const items = contentAddItemsToMenuItems(CONTENT_ADD_ITEMS, h, {
      hasCwd: true,
      isSshProject: false
    })
    for (const item of items) {
      if ('onClick' in item) item.onClick()
    }
    expect(calls.sort()).toEqual(['browser', 'dino', 'spawnTeam', 'sticky', 'terminal', 'web', 'worktree'])
  })
})

describe('contentAddItemsToDockRows', () => {
  it('omits the Dock-local terminal + remote rows (the Dock renders those itself) and keeps the rest', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: true,
      isSshProject: false
    })
    // NO 'terminal' and NO 'remote': the Dock draws its own Terminal button and its own
    // "New Remote Connection" flow. Emitting a terminal row here duplicated the Terminal entry.
    expect(rows.map((r) => r.kind)).toEqual([
      'browser',
      'web',
      'sticky',
      'dino',
      'trigger',
      'open-file',
      'new-file',
      'spawn-team',
      'worktree'
    ])
    expect(rows.some((r) => r.kind === 'terminal')).toBe(false)
    expect(rows.some((r) => r.kind === 'remote')).toBe(false)
  })

  it('DISABLES "new-file" with its reason when there is no cwd — the Dock keeps the row too', () => {
    const rows = contentAddItemsToDockRows(CONTENT_ADD_ITEMS, handlers(), {
      hasCwd: false,
      isSshProject: false
    })
    const newFile = rows.find((r) => r.kind === 'new-file')
    expect(newFile).toBeDefined()
    expect(newFile?.disabled).toBe(true)
    expect(newFile?.hint).toBe(NEW_FILE_NO_CWD_HINT)
    expect(rows.find((r) => r.kind === 'worktree')?.hint).toBe(WORKTREE_NO_CWD_HINT)
  })
})
