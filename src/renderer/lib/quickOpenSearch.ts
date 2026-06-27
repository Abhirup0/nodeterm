/** Pure fuzzy ranking for Quick Open (⌘K file search). */
export const QUICK_OPEN_RESULT_LIMIT = 50

export type QuickOpenIndexedFile = {
  path: string
  lowerPath: string
  lowerFilename: string
  inputIndex: number
}

export type QuickOpenSearchResult = {
  path: string
  score: number
}

export function prepareQuickOpenFiles(files: readonly string[]): QuickOpenIndexedFile[] {
  return files.map((path, inputIndex) => {
    const searchPath = path.replace(/\\/g, '/')
    const lastSlash = searchPath.lastIndexOf('/')
    return {
      path,
      lowerPath: searchPath.toLowerCase(),
      lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
      inputIndex
    }
  })
}

type QuickOpenRankedResult = QuickOpenSearchResult & { inputIndex: number }

export function rankQuickOpenFiles(
  query: string,
  files: readonly QuickOpenIndexedFile[],
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenSearchResult[] {
  if (limit <= 0) return []
  const normalizedQuery = query.trim().replace(/\\/g, '/').toLowerCase()
  if (!normalizedQuery) {
    return files.slice(0, limit).map((file) => ({ path: file.path, score: 0 }))
  }
  const results: QuickOpenRankedResult[] = []
  for (const file of files) {
    const score = fuzzyMatchIndexedFile(normalizedQuery, file)
    if (score === -1) continue
    insertTopResult(results, { path: file.path, score, inputIndex: file.inputIndex }, limit)
  }
  return results.map(({ path, score }) => ({ path, score }))
}

// Lower score = better. Gaps between matched chars add; matching right after a /.- boundary
// subtracts 5; a filename substring hit subtracts 100. -1 means "no subsequence match".
function fuzzyMatchIndexedFile(query: string, file: QuickOpenIndexedFile): number {
  let qi = 0
  let score = 0
  let lastMatchIdx = -1
  for (let ti = 0; ti < file.lowerPath.length && qi < query.length; ti++) {
    if (file.lowerPath[ti] === query[qi]) {
      score += lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
      const prev = file.lowerPath[ti - 1]
      if (ti > 0 && (prev === '/' || prev === '.' || prev === '-')) score -= 5
      lastMatchIdx = ti
      qi++
    }
  }
  if (qi < query.length) return -1
  if (file.lowerFilename.includes(query)) score -= 100
  return score
}

function compareRankedResult(a: QuickOpenRankedResult, b: QuickOpenRankedResult): number {
  return a.score - b.score || a.inputIndex - b.inputIndex
}

function insertTopResult(
  results: QuickOpenRankedResult[],
  candidate: QuickOpenRankedResult,
  limit: number
): void {
  const worst = results.at(-1)
  if (results.length === limit && worst && compareRankedResult(candidate, worst) >= 0) return
  let low = 0
  let high = results.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (compareRankedResult(candidate, results[mid]) < 0) high = mid
    else low = mid + 1
  }
  results.splice(low, 0, candidate)
  if (results.length > limit) results.pop()
}
