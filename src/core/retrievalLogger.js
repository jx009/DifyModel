const fs = require('fs')
const path = require('path')
const { pickWritableDataRoot } = require('./storagePaths')

const DATA_ROOT = pickWritableDataRoot()
const RETRIEVAL_DIR = path.join(DATA_ROOT, 'retrieval')
const RETRIEVAL_FILE = path.join(RETRIEVAL_DIR, 'retrieval.jsonl')

let stream = null
let bytesWritten = 0
let rotating = false

function ensureDir() {
  if (!fs.existsSync(RETRIEVAL_DIR)) {
    fs.mkdirSync(RETRIEVAL_DIR, { recursive: true })
  }
}

function openStream() {
  ensureDir()
  if (stream) return

  try {
    const stat = fs.existsSync(RETRIEVAL_FILE) ? fs.statSync(RETRIEVAL_FILE) : null
    bytesWritten = stat ? Number(stat.size || 0) : 0
  } catch (_error) {
    bytesWritten = 0
  }

  stream = fs.createWriteStream(RETRIEVAL_FILE, { flags: 'a' })
  stream.on('error', () => {
    try {
      stream && stream.end()
    } catch (_error) {
      // ignore
    }
    stream = null
  })
}

function closeStream() {
  if (!stream) return
  try {
    stream.end()
  } catch (_error) {
    // ignore
  }
  stream = null
}

function rotateIfNeeded(nextBytes) {
  const maxBytes = Number(process.env.RETRIEVAL_LOG_MAX_BYTES || 20 * 1024 * 1024)
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return
  if (rotating) return
  if (bytesWritten + nextBytes < maxBytes) return

  rotating = true
  try {
    closeStream()
    ensureDir()
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const rotated = path.join(RETRIEVAL_DIR, `retrieval.${ts}.jsonl`)
    if (fs.existsSync(RETRIEVAL_FILE)) {
      fs.renameSync(RETRIEVAL_FILE, rotated)
    }
  } catch (_error) {
    // ignore
  } finally {
    bytesWritten = 0
    rotating = false
  }
}

function logRetrievalPlan(event) {
  openStream()
  const payload = {
    ...event,
    timestamp: new Date().toISOString()
  }
  const line = `${JSON.stringify(payload)}\n`
  rotateIfNeeded(Buffer.byteLength(line))

  if (!stream) {
    // Best effort fallback (should be rare).
    try {
      fs.appendFileSync(RETRIEVAL_FILE, line, 'utf8')
    } catch (_error) {
      // ignore
    }
    return
  }

  try {
    stream.write(line)
    bytesWritten += Buffer.byteLength(line)
  } catch (_error) {
    // ignore
  }
}

module.exports = {
  logRetrievalPlan,
  RETRIEVAL_FILE,
  DATA_ROOT
}

