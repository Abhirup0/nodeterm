import { create } from 'zustand'

/**
 * Per-repo Source Control draft state — the commit message and the in-flight "generate"
 * status, keyed by the repo's cwd. Lives OUTSIDE the SourceControlPanel component so closing
 * the panel doesn't discard a typed message or abandon a running AI generation: the generate
 * action completes in the store and stashes its result, so reopening the panel shows it.
 */
interface ScmDraftState {
  messages: Record<string, string>
  generating: Record<string, boolean>
  errors: Record<string, string>
  setMessage(cwd: string, message: string): void
  clearError(cwd: string): void
  /** Generate a commit message from the staged diff (survives panel close). */
  generate(cwd: string): Promise<void>
}

export const useScmDraft = create<ScmDraftState>((set, get) => ({
  messages: {},
  generating: {},
  errors: {},

  setMessage: (cwd, message) => set((s) => ({ messages: { ...s.messages, [cwd]: message } })),
  clearError: (cwd) => set((s) => ({ errors: { ...s.errors, [cwd]: '' } })),

  generate: async (cwd) => {
    if (!cwd || get().generating[cwd]) return
    set((s) => ({
      generating: { ...s.generating, [cwd]: true },
      errors: { ...s.errors, [cwd]: '' }
    }))
    try {
      const r = await window.nodeTerminal.git.generateMessage(cwd)
      set((s) => ({
        generating: { ...s.generating, [cwd]: false },
        ...(r.ok
          ? { messages: { ...s.messages, [cwd]: r.message } }
          : { errors: { ...s.errors, [cwd]: r.message } })
      }))
    } catch (e) {
      set((s) => ({
        generating: { ...s.generating, [cwd]: false },
        errors: { ...s.errors, [cwd]: e instanceof Error ? e.message : 'Generate failed' }
      }))
    }
  }
}))
