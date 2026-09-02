/** Downloadable whisper.cpp models (ggml files on HuggingFace). `pro` marks
 * the paid tier — tiny stays free (the desktop mirror of mobile's split). */
export interface WhisperModelInfo {
  id: string
  file: string
  approxMB: number
  pro: boolean
}

export const WHISPER_MODELS: WhisperModelInfo[] = [
  { id: 'tiny', file: 'ggml-tiny.bin', approxMB: 75, pro: false },
  { id: 'base', file: 'ggml-base.bin', approxMB: 142, pro: true },
  { id: 'small', file: 'ggml-small.bin', approxMB: 466, pro: true },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', approxMB: 1600, pro: true },
]

export const WHISPER_DOWNLOAD_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

/**
 * A language whisper can be pinned to. `code` is whisper's OWN code and is what goes on the wire
 * unchanged — for local whisper.cpp and for the cloud `locale` alike.
 *
 * `label` is CLDR's English name and `endonym` the language's name in itself, because the person
 * who needs Polish types "polski" at least as often as "Polish"; `aliases` carries the spellings
 * neither covers — whisper's own English name where it differs from CLDR's ("Myanmar" for Burmese),
 * plus whisper's documented alias table ("Valencian", "Castilian", "Mandarin", …). All three are
 * searched, so no entry is reachable only by knowing the code.
 *
 * The set is whisper's `LANGUAGES` table (tokenizer.py) verbatim, so it is exactly what the
 * engine accepts — no more (an unknown code makes whisper.cpp fail the transcription) and no
 * less (the 7-entry hand-written list this replaced was the ONLY thing standing between a Polish
 * speaker and working dictation; nothing below the dropdown ever validated the code).
 */
export interface SpeechLanguage {
  code: string
  label: string
  endonym: string
  aliases?: string[]
  /** Cantonese exists only from large-v3 on — the earlier models have no token for it. */
  sinceV3?: true
}

/** Let whisper guess the language from the audio. Not one of whisper's codes — the engines take
 *  it as "no hint", which is why it is spelled here rather than living in the table. */
export const SPEECH_LANGUAGE_AUTO = 'auto'

/** Whisper's 100 languages, ordered by English name (this is read top-to-bottom in a picker;
 *  whisper's own order is by training-data volume and looks arbitrary on screen). */
export const SPEECH_LANGUAGES: readonly SpeechLanguage[] = [
  { code: 'af', label: 'Afrikaans', endonym: 'Afrikaans' },
  { code: 'sq', label: 'Albanian', endonym: 'shqip' },
  { code: 'am', label: 'Amharic', endonym: 'አማርኛ' },
  { code: 'ar', label: 'Arabic', endonym: 'العربية' },
  { code: 'hy', label: 'Armenian', endonym: 'հայերեն' },
  { code: 'as', label: 'Assamese', endonym: 'অসমীয়া' },
  { code: 'az', label: 'Azerbaijani', endonym: 'azərbaycan' },
  { code: 'bn', label: 'Bangla', endonym: 'বাংলা', aliases: ['Bengali'] },
  { code: 'ba', label: 'Bashkir', endonym: 'башҡорт' },
  { code: 'eu', label: 'Basque', endonym: 'euskara' },
  { code: 'be', label: 'Belarusian', endonym: 'беларуская' },
  { code: 'bs', label: 'Bosnian', endonym: 'bosanski' },
  { code: 'br', label: 'Breton', endonym: 'brezhoneg' },
  { code: 'bg', label: 'Bulgarian', endonym: 'български' },
  { code: 'my', label: 'Burmese', endonym: 'မြန်မာ', aliases: ['Myanmar'] },
  { code: 'yue', label: 'Cantonese', endonym: '粵語', sinceV3: true },
  { code: 'ca', label: 'Catalan', endonym: 'català', aliases: ['Valencian'] },
  { code: 'zh', label: 'Chinese', endonym: '中文', aliases: ['Mandarin'] },
  { code: 'hr', label: 'Croatian', endonym: 'hrvatski' },
  { code: 'cs', label: 'Czech', endonym: 'čeština' },
  { code: 'da', label: 'Danish', endonym: 'dansk' },
  { code: 'nl', label: 'Dutch', endonym: 'Nederlands', aliases: ['Flemish'] },
  { code: 'en', label: 'English', endonym: 'English' },
  { code: 'et', label: 'Estonian', endonym: 'eesti' },
  { code: 'fo', label: 'Faroese', endonym: 'føroyskt' },
  { code: 'tl', label: 'Filipino', endonym: 'Filipino', aliases: ['Tagalog'] },
  { code: 'fi', label: 'Finnish', endonym: 'suomi' },
  { code: 'fr', label: 'French', endonym: 'français' },
  { code: 'gl', label: 'Galician', endonym: 'galego' },
  { code: 'ka', label: 'Georgian', endonym: 'ქართული' },
  { code: 'de', label: 'German', endonym: 'Deutsch' },
  { code: 'el', label: 'Greek', endonym: 'Ελληνικά' },
  { code: 'gu', label: 'Gujarati', endonym: 'ગુજરાતી' },
  { code: 'ht', label: 'Haitian Creole', endonym: 'Haitian Creole', aliases: ['Haitian'] },
  { code: 'ha', label: 'Hausa', endonym: 'Hausa' },
  { code: 'haw', label: 'Hawaiian', endonym: 'ʻŌlelo Hawaiʻi' },
  { code: 'he', label: 'Hebrew', endonym: 'עברית' },
  { code: 'hi', label: 'Hindi', endonym: 'हिन्दी' },
  { code: 'hu', label: 'Hungarian', endonym: 'magyar' },
  { code: 'is', label: 'Icelandic', endonym: 'íslenska' },
  { code: 'id', label: 'Indonesian', endonym: 'Indonesia' },
  { code: 'it', label: 'Italian', endonym: 'italiano' },
  { code: 'ja', label: 'Japanese', endonym: '日本語' },
  { code: 'jw', label: 'Javanese', endonym: 'Jawa' },
  { code: 'kn', label: 'Kannada', endonym: 'ಕನ್ನಡ' },
  { code: 'kk', label: 'Kazakh', endonym: 'қазақ тілі' },
  { code: 'km', label: 'Khmer', endonym: 'ខ្មែរ' },
  { code: 'ko', label: 'Korean', endonym: '한국어' },
  { code: 'lo', label: 'Lao', endonym: 'ລາວ' },
  { code: 'la', label: 'Latin', endonym: 'Latin' },
  { code: 'lv', label: 'Latvian', endonym: 'latviešu' },
  { code: 'ln', label: 'Lingala', endonym: 'lingála' },
  { code: 'lt', label: 'Lithuanian', endonym: 'lietuvių' },
  { code: 'lb', label: 'Luxembourgish', endonym: 'Lëtzebuergesch', aliases: ['Letzeburgesch'] },
  { code: 'mk', label: 'Macedonian', endonym: 'македонски' },
  { code: 'mg', label: 'Malagasy', endonym: 'Malagasy' },
  { code: 'ms', label: 'Malay', endonym: 'Melayu' },
  { code: 'ml', label: 'Malayalam', endonym: 'മലയാളം' },
  { code: 'mt', label: 'Maltese', endonym: 'Malti' },
  { code: 'mi', label: 'Māori', endonym: 'Māori', aliases: ['Maori'] },
  { code: 'mr', label: 'Marathi', endonym: 'मराठी' },
  { code: 'mn', label: 'Mongolian', endonym: 'монгол' },
  { code: 'ne', label: 'Nepali', endonym: 'नेपाली' },
  { code: 'no', label: 'Norwegian', endonym: 'norsk' },
  { code: 'nn', label: 'Norwegian Nynorsk', endonym: 'norsk nynorsk', aliases: ['Nynorsk'] },
  { code: 'oc', label: 'Occitan', endonym: 'occitan' },
  { code: 'ps', label: 'Pashto', endonym: 'پښتو', aliases: ['Pushto'] },
  { code: 'fa', label: 'Persian', endonym: 'فارسی', aliases: ['Farsi'] },
  { code: 'pl', label: 'Polish', endonym: 'polski' },
  { code: 'pt', label: 'Portuguese', endonym: 'português' },
  { code: 'pa', label: 'Punjabi', endonym: 'ਪੰਜਾਬੀ', aliases: ['Panjabi'] },
  { code: 'ro', label: 'Romanian', endonym: 'română', aliases: ['Moldavian', 'Moldovan'] },
  { code: 'ru', label: 'Russian', endonym: 'русский' },
  { code: 'sa', label: 'Sanskrit', endonym: 'संस्कृत भाषा' },
  { code: 'sr', label: 'Serbian', endonym: 'српски' },
  { code: 'sn', label: 'Shona', endonym: 'chiShona' },
  { code: 'sd', label: 'Sindhi', endonym: 'سنڌي' },
  { code: 'si', label: 'Sinhala', endonym: 'සිංහල', aliases: ['Sinhalese'] },
  { code: 'sk', label: 'Slovak', endonym: 'slovenčina' },
  { code: 'sl', label: 'Slovenian', endonym: 'slovenščina' },
  { code: 'so', label: 'Somali', endonym: 'Soomaali' },
  { code: 'es', label: 'Spanish', endonym: 'español', aliases: ['Castilian'] },
  { code: 'su', label: 'Sundanese', endonym: 'Basa Sunda' },
  { code: 'sw', label: 'Swahili', endonym: 'Kiswahili' },
  { code: 'sv', label: 'Swedish', endonym: 'svenska' },
  { code: 'tg', label: 'Tajik', endonym: 'тоҷикӣ' },
  { code: 'ta', label: 'Tamil', endonym: 'தமிழ்' },
  { code: 'tt', label: 'Tatar', endonym: 'татар' },
  { code: 'te', label: 'Telugu', endonym: 'తెలుగు' },
  { code: 'th', label: 'Thai', endonym: 'ไทย' },
  { code: 'bo', label: 'Tibetan', endonym: 'བོད་སྐད་' },
  { code: 'tr', label: 'Turkish', endonym: 'Türkçe' },
  { code: 'tk', label: 'Turkmen', endonym: 'türkmen dili' },
  { code: 'uk', label: 'Ukrainian', endonym: 'українська' },
  { code: 'ur', label: 'Urdu', endonym: 'اردو' },
  { code: 'uz', label: 'Uzbek', endonym: 'o‘zbek' },
  { code: 'vi', label: 'Vietnamese', endonym: 'Tiếng Việt' },
  { code: 'cy', label: 'Welsh', endonym: 'Cymraeg' },
  { code: 'yi', label: 'Yiddish', endonym: 'ייִדיש' },
  { code: 'yo', label: 'Yoruba', endonym: 'Èdè Yorùbá' },
]

export function speechLanguage(code: string): SpeechLanguage | undefined {
  return SPEECH_LANGUAGES.find((l) => l.code === code)
}

/**
 * What to CALL the stored value. `auto` is the auto-detect row; a known code is its English name;
 * anything else is returned as-is.
 *
 * That last branch is the point: `SpeechSettings.language` is a free string with no validation
 * anywhere on the way to disk, so a hand-edited settings.json (or a build that drops an entry)
 * can hold a code this table does not know. Rendering it as the empty string is what let the old
 * `<select>` show blank and then overwrite the user's value on the next click — a display gap
 * must never become a data loss.
 */
export function speechLanguageLabel(code: string): string {
  if (code === SPEECH_LANGUAGE_AUTO) return 'Auto-detect'
  return speechLanguage(code)?.label ?? code
}

/** Whether this model's vocabulary knows every language in the table. Only the large-v3 family
 *  does; see `sinceV3`. */
export function modelKnowsV3Languages(modelId: string): boolean {
  return modelId.startsWith('large-v3')
}

/** Case- and diacritic-insensitive: "turkce" finds Türkçe, "cestina" finds čeština. Non-Latin
 *  scripts pass through unchanged, which is what we want — Cyrillic has nothing to strip. */
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * The languages matching a picker query, best first: exact code, then names that START with the
 * query, then names that merely contain it. Ties keep the table's alphabetical order.
 *
 * The ranking is the whole reason this is not a bare `.filter()`: "pl" is a substring of "Nepali"
 * and "Napoletano"-shaped endonyms, and a Polish speaker typing their own code should not have to
 * hunt for it.
 */
export function filterSpeechLanguages(query: string): readonly SpeechLanguage[] {
  const q = fold(query.trim())
  if (q === '') return SPEECH_LANGUAGES
  const scored: { lang: SpeechLanguage; rank: number }[] = []
  for (const lang of SPEECH_LANGUAGES) {
    const names = [lang.label, lang.endonym, ...(lang.aliases ?? [])].map(fold)
    const code = lang.code.toLowerCase()
    const rank =
      code === q ? 0
        : code.startsWith(q) ? 1
          : names.some((n) => n.startsWith(q)) ? 2
            : names.some((n) => n.includes(q)) ? 3
              : -1
    if (rank >= 0) scored.push({ lang, rank })
  }
  return scored.sort((a, b) => a.rank - b.rank).map((s) => s.lang)
}

/**
 * The "no dictation" selection: an EMPTY model id (issue #143). A legitimate, user-chosen state —
 * the settings default, the onboarding "skip" choice, and the Settings → Speech "None" row all
 * write it — never a dangling pointer for the heal helpers below to fix behind the user's back.
 * Spelled '' so a hand-read settings.json says what it means.
 */
export const SPEECH_MODEL_NONE = ''

/** Is dictation actually configured (a model chosen)? `false` = the explicit None/off state. */
export function hasSpeechModel(model: string): boolean {
  return model !== SPEECH_MODEL_NONE
}

export function whisperModel(id: string): WhisperModelInfo | undefined {
  return WHISPER_MODELS.find((m) => m.id === id)
}

/** The download/selection state a surface needs to keep the two in step. Deliberately narrower
 *  than `SpeechModelInfo` so the mobile-shaped lists fit it too. */
export interface ModelDownloadState {
  id: string
  downloaded: boolean
}

/**
 * The model to select after `justDownloaded` finished, or null to leave the choice alone.
 *
 * Downloading is not selecting — but a settings default (`tiny`) means there is ALWAYS a
 * selection, so a user who downloads `base` first ends up pointed at a model that is not on disk
 * and dictation fails with "model not downloaded". They downloaded a model and reasonably believe
 * they are done. So: adopt the fresh download whenever the current selection has nothing behind
 * it, and never when it does — a working setup is not hijacked by trying a second model out.
 */
export function modelAfterDownload(
  models: readonly ModelDownloadState[],
  current: string,
  justDownloaded: string
): string | null {
  if (current === justDownloaded) return null
  // An id that is not in the list at all (a renamed/removed model) has nothing behind it either.
  // That deliberately includes SPEECH_MODEL_NONE: starting a download IS asking for dictation, so
  // the fresh model is adopted and the off state ends — the one heal None does not opt out of.
  return models.find((m) => m.id === current)?.downloaded ? null : justDownloaded
}

/**
 * The model to select after a delete, or null to leave it alone. Deleting the selected model
 * leaves the same dangling pointer a first download does — so fall back to whatever else is on
 * disk. Null when nothing is: there is nothing truthful to select, and the row list already says
 * so louder than a silent switch would.
 */
export function modelAfterDelete(
  models: readonly ModelDownloadState[],
  current: string
): string | null {
  // An explicit None is not a dangling pointer (issue #143): deleting a leftover model file while
  // dictation is OFF must leave it off, never silently re-adopt whatever else is on disk.
  if (!hasSpeechModel(current)) return null
  if (models.find((m) => m.id === current)?.downloaded) return null
  return models.find((m) => m.downloaded)?.id ?? null
}
