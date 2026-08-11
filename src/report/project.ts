/**
 * Readable name for a project bucket.
 *
 * Claude Code encodes the working directory by replacing every separator with a hyphen, so the raw
 * key is both unreadable and carries the account name (`-Users-me-code-my-app`). The
 * encoding is lossy: a hyphen in the key may be a separator or part of a directory name, and
 * nothing distinguishes them. So the reverse cannot be exact, and this deliberately does not try.
 *
 * What it does instead is drop the home prefix - the root segment and the account name after it -
 * and rejoin the rest with hyphens. `-Users-me-code-my-app` becomes `my-app`, which
 * is both what the directory is called and free of the user's name. Decoding to a path would give
 * `my/app`, splitting a real directory name in half, which is why that approach is not used.
 *
 * Display only. The stored key stays the encoded path, so attribution is unchanged and no migration
 * is needed.
 */

/** Segments that introduce a home directory. The next segment is the account name. */
const HOME_ROOTS = new Set(['Users', 'users', 'home'])

/**
 * Directories people keep their checkouts in.
 *
 * Dropping one of these too is what turns `code-my-app` into `my-app`. It is a
 * named list rather than "drop one more segment", which is the shortcut the field takes: that
 * shortcut also eats a meaningful parent, so `clients-acme-api` would silently become `acme-api`
 * and two different clients' projects could collapse to the same label.
 */
const CODE_ROOTS = new Set(['code', 'src', 'dev', 'projects', 'repos', 'work', 'git', 'workspace'])

function segments(encoded: string): string[] {
  // Windows paths arrive with backslashes intact; every other form is already hyphen-encoded.
  const parts = encoded.includes('\\') ? encoded.split(/[\\/]/) : encoded.split('-')
  return parts.filter((part) => part.length > 0)
}

export function prettyProject(encoded: string, aliases: Record<string, string> = {}): string {
  const alias = aliases[encoded]
  if (alias !== undefined) return alias
  if (encoded === '' || encoded === 'unknown') return 'unknown project'

  const parts = segments(encoded)
  const home = parts.findIndex((part) => HOME_ROOTS.has(part))
  // A path that stops at the account name has nothing left to name, so it keeps the account
  // segment rather than collapsing to an empty label.
  let kept = home === -1 ? parts : parts.slice(home + 2)
  if (kept.length === 0) kept = parts.slice(home + 1)
  if (kept.length > 1 && CODE_ROOTS.has(kept[0]!)) kept = kept.slice(1)
  const name = kept.join('-')
  if (name === '') return encoded
  return aliases[name] ?? name
}
