function generateTraceId() {
  const now = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `trc_${now}_${rand}`
}

function normalizeTraceId(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed) return null
  if (trimmed.length > 128) return null
  return trimmed
}

module.exports = {
  generateTraceId,
  normalizeTraceId
}
