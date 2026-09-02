import {
  filterSpeechLanguages,
  hasSpeechModel,
  modelKnowsV3Languages,
  SPEECH_LANGUAGE_AUTO,
  speechLanguage,
  type SpeechLanguage
} from '@shared/speech'

/** One row of the speech-language picker. `hint` is the muted right-hand text. */
export interface SpeechLanguageRow {
  code: string
  label: string
  hint?: string
}

/**
 * Auto-detect matches only a prefix of its own name (or the whole word "detect"), never a bare
 * substring. `'auto-detect'.includes(q)` would have put it above German for the query "de" — the
 * pinned row must not compete with what the user is obviously typing.
 */
function autoMatches(q: string): boolean {
  return q === '' || 'auto-detect'.startsWith(q) || 'automatic'.startsWith(q) || q === 'detect'
}

/**
 * The rows to show for `query`, with the current value always reachable.
 *
 * Two rows are pinned above the catalogue, and both exist for a reason:
 * - **Auto-detect** is not one of whisper's languages (it means "no hint"), so it is not in the
 *   table and has to be added here.
 * - **A stored code this build does not know** gets its own row. `SpeechSettings.language` is a
 *   free string nothing validates, so a hand-edited settings.json can hold one; without the row
 *   the picker would have no way to show what is selected, which is how the old `<select>` came
 *   to render blank and then overwrite the user's value.
 */
export function speechLanguageRows(query: string, current: string): SpeechLanguageRow[] {
  const q = query.trim().toLowerCase()
  const rows: SpeechLanguageRow[] = []
  if (autoMatches(q)) {
    rows.push({ code: SPEECH_LANGUAGE_AUTO, label: 'Auto-detect', hint: 'Whisper guesses' })
  }
  const unknown =
    current !== SPEECH_LANGUAGE_AUTO && current !== '' && !speechLanguage(current) ? current : null
  if (unknown && (q === '' || unknown.toLowerCase().includes(q))) {
    rows.push({ code: unknown, label: unknown, hint: 'not in this list' })
  }
  for (const l of filterSpeechLanguages(query)) rows.push({ code: l.code, label: l.label, hint: hintFor(l) })
  return rows
}

/** The endonym plus the code — minus the endonym when it only repeats the English name (Latin,
 *  Afrikaans, Filipino and a handful more), where printing it twice reads as a rendering bug. */
function hintFor(l: SpeechLanguage): string {
  return l.endonym.toLowerCase() === l.label.toLowerCase() ? l.code : `${l.endonym} · ${l.code}`
}

/** Wrapping cursor movement over the rows — `Math.max(1, …)` so an empty list can't divide by 0. */
export function moveRow(active: number, delta: number, count: number): number {
  const n = Math.max(1, count)
  return (((active + delta) % n) + n) % n
}

/**
 * The sentence under the Language field naming what is actually selected. The old row said only
 * "A hint for transcription; auto-detect works well for mixed speech" — true of the 7-entry list,
 * and useless once the control is a searchable menu whose trigger you have to look at twice.
 */
export function speechLanguageSummary(code: string): string {
  if (code === SPEECH_LANGUAGE_AUTO) {
    return 'Auto-detect: Whisper guesses from the first seconds of audio. Dictation clips are short, so it does misjudge them — name your language if it gets yours wrong.'
  }
  const lang = speechLanguage(code)
  if (!lang) return `Transcribing as “${code}”.`
  const native = lang.endonym.toLowerCase() === lang.label.toLowerCase() ? '' : ` (${lang.endonym})`
  return `Transcribing as ${lang.label}${native}.`
}

/**
 * The warn-coloured caveat, or nothing. Two cases, and both are states the picker can reach:
 * a code this build cannot name (say so rather than silently keep it), and Cantonese under a
 * model whose vocabulary predates it.
 */
export function speechLanguageWarning(code: string, model: string): string | undefined {
  if (code !== SPEECH_LANGUAGE_AUTO && code !== '' && !speechLanguage(code)) {
    return `“${code}” isn’t a language this build recognises. It is kept exactly as set and passed to the engine unchanged — pick from the list to replace it.`
  }
  const lang = speechLanguage(code)
  if (lang?.sinceV3 && hasSpeechModel(model) && !modelKnowsV3Languages(model)) {
    return `${lang.label} was added in Whisper large-v3 — the model selected above has no token for it. Choose Large V3 Turbo, or use Chinese.`
  }
  return undefined
}
