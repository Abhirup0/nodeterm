// The ONE environment handed to a `git` (or `gh`) subprocess.
//
// Two facts it exists to keep in one place:
//
// 1. GUI apps on macOS don't inherit the shell PATH, so a git credential helper installed by
//    Homebrew (e.g. `gh auth git-credential`, or an osxkeychain shim) wouldn't be found by our
//    subprocess — making push/pull fail even when the user is authed. Prepend the common bin
//    dirs.
//
//    That prepend is POSIX-ONLY, and it used not to be (issue #583). The list was joined and
//    appended with a HARDCODED ':', so on Windows — where PATH is split on ';' and every entry
//    carries a drive-letter colon — the four Unix directories fused with the first real entry
//    into one unusable token:
//
//        /opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:C:\Windows\System32
//
//    Windows then split that on ';', got one malformed directory, and the user's first PATH entry
//    was unreachable for every git child process — including `git-credential-manager.exe`, which
//    fails in a way that reads as an auth problem rather than a PATH problem. There is nothing
//    useful to prepend on Windows (these are Unix paths, and a GUI process there inherits the real
//    PATH anyway), so the key is OMITTED entirely and `...base` carries the untouched PATH through.
//    `path.delimiter` would only make the join produce `;`-separated Unix directories, which is a
//    tidier way of prepending nothing.
//
// 2. GIT_TERMINAL_PROMPT=0 makes auth failures error out fast instead of hanging on a username
//    prompt (there's no TTY here). That one is platform-INDEPENDENT and load-bearing, so it is
//    outside the conditional — easy to lose inside a spread that is now platform-gated.
//
// Both git-service.ts and github/credentials.ts had a character-for-character copy of the PATH
// construction. A duplicated rule drifts (CLAUDE.md), and the copy in the GitHub-credentials path
// is precisely the credential-helper case above, so the two import this instead.

/** Bin dirs a GUI-launched process on macOS/Linux routinely can't see. POSIX-only by construction. */
export const GIT_POSIX_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']

/**
 * Pure: base environment + platform → the environment for a git/gh subprocess.
 *
 * `base` and `platform` are parameters rather than reads of the ambient process so the mapping is
 * unit-testable from any OS — the same shape as `tmuxInstall(platform, hasCommand)` and
 * `executableCandidates(bin, platform, pathext)`.
 */
export function gitEnvFrom(
  base: NodeJS.ProcessEnv,
  platform: NodeJS.Platform | string
): NodeJS.ProcessEnv {
  if (platform === 'win32') {
    // No PATH key of our own: adding one would ALSO risk a duplicate, since Windows env vars are
    // case-insensitive and `process.env` there usually spells it `Path`.
    return { ...base, GIT_TERMINAL_PROMPT: '0' }
  }
  const prefix = GIT_POSIX_BIN_DIRS.join(':')
  return {
    ...base,
    PATH: base.PATH ? `${prefix}:${base.PATH}` : prefix,
    GIT_TERMINAL_PROMPT: '0'
  }
}

/** The environment for a git/gh subprocess on THIS machine. */
export function gitEnv(): NodeJS.ProcessEnv {
  return gitEnvFrom(process.env, process.platform)
}
