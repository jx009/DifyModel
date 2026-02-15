const fs = require('fs')
const path = require('path')

function pickWritableDataRoot() {
  const candidates = []
  if (process.env.DATA_DIR) {
    candidates.push(process.env.DATA_DIR)
  }
  candidates.push(path.join(process.cwd(), 'data'))
  candidates.push(path.join('/tmp', 'difymodel-data'))

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.accessSync(dir, fs.constants.W_OK)
      return dir
    } catch (_error) {
      // try next
    }
  }

  throw new Error('no writable data directory available')
}

module.exports = {
  pickWritableDataRoot
}
