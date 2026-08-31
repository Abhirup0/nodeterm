import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'

// Whether the kanban card modal opens with its comments & activity panel expanded — PERSONAL,
// per machine: persisted in localStorage, deliberately never in the git-shared
// .nodeterm/project.json (same rule as the view mode).
//
// Open is the default, so a fresh install still shows the feed the first time. Only an explicit
// close/open is remembered: once the user collapses the panel, every card they open afterwards
// (this session and after a restart) comes up collapsed until they expand it again.

export const CARD_PANEL_KEY = 'nodeterm.cardCommentsOpen'

/** Parses the persisted flag. Anything missing or unparseable means open (the default). */
export function parseCardPanelOpen(raw: string | null): boolean {
  return raw !== 'false'
}

function save(open: boolean): void {
  try {
    writeLocal(CARD_PANEL_KEY, open ? 'true' : 'false')
  } catch {
    /* quota/private-mode: the panel state is a nicety, never fail the UI */
  }
}

interface CardPanelState {
  open: boolean
  setOpen(open: boolean): void
  toggle(): void
}

export const useCardPanel = create<CardPanelState>((set, get) => ({
  open: parseCardPanelOpen(readLocal(CARD_PANEL_KEY)),
  setOpen: (open) => {
    save(open)
    set({ open })
  },
  toggle: () => get().setOpen(!get().open)
}))
