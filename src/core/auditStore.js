const fs = require('fs')
const path = require('path')
const { pickWritableDataRoot } = require('./storagePaths')

const DATA_ROOT = pickWritableDataRoot()
const AUDIT_DIR = path.join(DATA_ROOT, 'audit')
const AUDIT_FILE = path.join(AUDIT_DIR, 'traces.jsonl')

class AuditStore {
  constructor() {
    this.index = new Map()
    this.ensureDir()
    this.loadIndex()
  }

  ensureDir() {
    if (!fs.existsSync(AUDIT_DIR)) {
      fs.mkdirSync(AUDIT_DIR, { recursive: true })
    }
    if (!fs.existsSync(AUDIT_FILE)) {
      fs.writeFileSync(AUDIT_FILE, '', 'utf8')
    }
  }

  loadIndex() {
    const content = fs.readFileSync(AUDIT_FILE, 'utf8')
    if (!content.trim()) return
    const lines = content.split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (entry.trace_id) {
          this.index.set(entry.trace_id, entry)
        }
      } catch (_error) {
        // ignore bad line
      }
    }
  }

  save(entry) {
    const normalized = {
      ...entry,
      updated_at: new Date().toISOString()
    }
    this.index.set(normalized.trace_id, normalized)
    fs.appendFileSync(AUDIT_FILE, `${JSON.stringify(normalized)}\n`, 'utf8')
  }

  get(traceId) {
    return this.index.get(traceId) || null
  }
}

module.exports = {
  AuditStore,
  AUDIT_FILE,
  DATA_ROOT
}
