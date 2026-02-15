function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(payload))
}

function successEnvelope(traceId, data) {
  return {
    success: true,
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    data
  }
}

function errorEnvelope(traceId, code, message, details) {
  return {
    success: false,
    trace_id: traceId,
    timestamp: new Date().toISOString(),
    error: {
      code,
      message,
      details: details || {}
    }
  }
}

module.exports = {
  sendJson,
  successEnvelope,
  errorEnvelope
}
