import { existsSync, openSync, fstatSync, readSync, closeSync } from 'node:fs'

// A rate limit has no structural marker of its own the way a refusal does, so
// it stays a text match over the tail. The blast radius is small and one-way:
// a false positive returns early, records nothing in the ledger, and tells the
// user to wait.
const RATE_LIMIT = /rate_limit_error|"status"\s*:\s*429|rate limit exceeded/i

// Only consulted when not one line of the tail parsed as JSON, which a real
// transcript tail never does. It exists so that a genuinely refused run whose
// final frame is larger than the tail window is still caught, and it is the
// only path on which a bare text match can still decide the outcome.
const REFUSAL_TEXT = /"stop_reason"\s*:\s*"refusal"|safeguards flagged/i

export function readTail (path, maxBytes) {
  if (!path || !existsSync(path)) return ''
  let fd
  try {
    fd = openSync(path, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(size, maxBytes)
    if (len <= 0) return ''
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* already closed */ }
    }
  }
}

// A tail begins mid-line, so its first fragment never parses. That is exactly
// how it gets dropped: every unparseable line is skipped, the leading fragment
// included, with no need to know whether this text is a tail or a whole file.
export function parseFrames (text) {
  const frames = []
  for (const line of String(text ?? '').split('\n')) {
    if (line.trim().length === 0) continue
    try {
      frames.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  return frames
}

// The authoritative marker, verified against real refused transcripts on
// disk: an assistant frame whose message carries `stop_reason: "refusal"` and
// a `stop_details` object naming the category. Reading the field rather than
// grepping the line is what separates a real kill from an agent that merely
// read those characters out of a file: that text arrives inside a tool_result,
// where `message.stop_reason` is `end_turn` or absent. On a sampled transcript
// the text match fired ten times against four real refusals.
function isRefusalFrame (frame) {
  if (frame === null || typeof frame !== 'object') return false
  if (frame.type !== 'assistant') return false
  const message = frame.message
  if (message === null || typeof message !== 'object') return false
  return message.stop_reason === 'refusal' || message.stop_details?.type === 'refusal'
}

// The platform retries a refused turn on a fallback model of its own and
// announces which way it went in a system frame: `model_refusal_fallback`
// means the retry ran and the turn recovered, `model_refusal_no_fallback`
// means nothing caught it. A recovered turn leaves its refusal marker in the
// transcript forever, so without this check every platform-recovered turn
// would be scored as a kill and handed a baton for work that finished.
function refusalMarker (frame) {
  if (frame === null || typeof frame !== 'object' || frame.type !== 'system') return null
  if (frame.subtype === 'model_refusal_fallback') return 'recovered'
  if (frame.subtype === 'model_refusal_no_fallback') return 'kill'
  return null
}

// That system frame does not reliably follow the refusal it describes. Over 94
// refusals in sampled transcripts it sat immediately *before* the synthetic
// refusal frame in 26 of the 32 cases where it appeared at all, so a scan of
// the frames after the refusal read a recovered turn as a kill and handed out
// a baton for work that had already landed. The frame directly before is
// therefore read too. The forward scan stops at the next refusal so that one
// turn's marker is never attributed to another's, and only a marker directly
// before counts backwards, for the same reason.
const MARKER_LOOKAHEAD = 3

function wasRecovered (list, refusalAt) {
  if (refusalMarker(list[refusalAt - 1]) === 'recovered') return true
  const limit = Math.min(refusalAt + MARKER_LOOKAHEAD, list.length - 1)
  for (let i = refusalAt + 1; i <= limit; i += 1) {
    if (isRefusalFrame(list[i])) break
    const marker = refusalMarker(list[i])
    if (marker !== null) return marker === 'recovered'
  }
  return false
}

function refusalCategory (frame) {
  const category = frame?.message?.stop_details?.category
  return typeof category === 'string' && category.length > 0 ? category : null
}

export function inspectFrames (frames, tailText = '') {
  const list = Array.isArray(frames) ? frames : []
  let refusalAt = -1
  for (let i = 0; i < list.length; i += 1) {
    if (isRefusalFrame(list[i])) refusalAt = i
  }
  if (refusalAt !== -1 && !wasRecovered(list, refusalAt)) {
    return { outcome: 'refusal', category: refusalCategory(list[refusalAt]) }
  }
  const text = String(tailText ?? '')
  // A refusal outranks a rate limit when both appear, the same order the
  // structural check above establishes: a refused turn that also happened to
  // mention a 429 is still a refusal.
  if (list.length === 0 && REFUSAL_TEXT.test(text)) {
    return { outcome: 'refusal', category: null }
  }
  if (RATE_LIMIT.test(text)) return { outcome: 'rate_limit', category: null }
  return { outcome: 'normal', category: null }
}

export function inspectTail (text) {
  return inspectFrames(parseFrames(text), text)
}

export function classifyTail (text) {
  return inspectTail(text).outcome
}

export function classify ({ transcriptPath, tailBytes = 262144, readTailFn = readTail }) {
  return classifyTail(transcriptPath ? readTailFn(transcriptPath, tailBytes) : '')
}

// The refusal frame itself reports `model: "<synthetic>"`, so the model that
// actually refused is the last real one named before it. Requiring the
// `claude-` prefix skips the synthetic frame without special-casing it.
export function modelFromFrames (frames) {
  const list = Array.isArray(frames) ? frames : []
  let last = null
  for (const frame of list) {
    const model = frame?.message?.model
    if (typeof model === 'string' && model.startsWith('claude-')) last = model
  }
  return last === null ? 'unknown' : last
}
