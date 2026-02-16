const fs = require('fs')
const path = require('path')

const { pickWritableDataRoot } = require('./storagePaths')

const DATA_ROOT = pickWritableDataRoot()
const AUDIT_DIR = path.join(DATA_ROOT, 'audit')
const ADMIN_AUDIT_FILE = path.join(AUDIT_DIR, 'admin-actions.jsonl')

function ensureDir() {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true })
  }
}

function writeAdminAction(event) {
  ensureDir()
  const payload = {
    timestamp: new Date().toISOString(),
    ...event
  }
  fs.appendFileSync(ADMIN_AUDIT_FILE, `${JSON.stringify(payload)}\n`, 'utf8')
}

module.exports = {
  writeAdminAction,
  ADMIN_AUDIT_FILE
}
