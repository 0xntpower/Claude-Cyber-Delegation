import { execFileSync } from 'node:child_process'

export const MAX_PATHSPEC = 500

function git (root, args) {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024
    })
  } catch {
    return ''
  }
}

export function gitState (root, files) {
  const list = Array.isArray(files) ? files : []
  if (list.length === 0) {
    return { files: [], status: '', diffstat: '', truncated: false }
  }
  const truncated = list.length > MAX_PATHSPEC
  const scoped = truncated ? list.slice(0, MAX_PATHSPEC) : list
  const status = git(root, ['status', '--porcelain', '--', ...scoped]).trim()
  const diffstat = git(root, ['diff', '--stat', '--', ...scoped]).trim()
  return { files: scoped, status, diffstat, truncated }
}
