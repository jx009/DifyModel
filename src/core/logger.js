const fs = require('fs')
const path = require('path')
const { pickWritableDataRoot } = require('./storagePaths')

const DATA_ROOT = pickWritableDataRoot()
const LOG_DIR = path.join(DATA_ROOT, 'logs')
const LOG_FILE = path.join(LOG_DIR, 'app.log.jsonl')

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true })
  }
}

function redact(value) {
  if (!value || typeof value !== 'string') return value
  if (value.length <= 8) return '***'
  return `${value.slice(0, 2)}***${value.slice(-2)}`
}

function writeLog(level, message, fields) {
  ensureLogDir()
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...fields
  }
  fs.appendFileSync(LOG_FILE, `${JSON.stringify(payload)}\n`, 'utf8')

  if (level === 'error') {
    console.error(payload)
    return
  }
  if (level === 'warn') {
    console.warn(payload)
    return
  }
  console.log(payload)
}

module.exports = {
  writeLog,
  redact,
  LOG_FILE,
  DATA_ROOT
}
