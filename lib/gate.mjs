import { closeSync, existsSync, mkdirSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/

// A hook must never write outside .ccd/. Allowing only this charset already
// excludes '/' and '\\', but a bare '.' or '..' passes that charset test
// while still being a traversal segment once joined onto a directory, so
// those two are rejected explicitly.
function sanitizeSessionId (sessionId) {
  if (typeof sessionId !== 'string') return null
  const trimmed = sessionId.trim()
  if (trimmed.length === 0) return null
  if (trimmed === '.' || trimmed === '..') return null
  if (!SAFE_SEGMENT.test(trimmed)) return null
  return trimmed
}

export function isEnabled (paths) {
  try {
    return existsSync(paths.enabled)
  } catch {
    return false
  }
}

export function enable (paths) {
  try {
    mkdirSync(paths.base, { recursive: true })
    writeFileSync(paths.enabled, new Date().toISOString())
    return true
  } catch {
    return false
  }
}

export function disable (paths) {
  try {
    rmSync(paths.enabled, { force: true })
    return true
  } catch {
    return false
  }
}

// True exactly once per session id. The marker is created with the same
// exclusive-open primitive the baton lock uses, so two hooks racing on the
// first fire of a session cannot both win.
export function shouldAnnounce (paths, sessionId) {
  const id = sanitizeSessionId(sessionId)
  if (id === null) return false
  try {
    mkdirSync(paths.announced, { recursive: true })
    closeSync(openSync(join(paths.announced, id), 'wx'))
    return true
  } catch {
    return false
  }
}
