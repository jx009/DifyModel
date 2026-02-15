const http = require('http')
const { URL } = require('url')

const { ScenarioRegistry } = require('./config/scenarioRegistry')
const { verifyAuth } = require('./core/auth')
const { InMemoryRateLimiter } = require('./core/rateLimiter')
const { derivePolicy } = require('./core/policyEngine')
const { validateInfer, validateFeedbackPayload } = require('./core/schemaValidator')
const { StreamManager } = require('./core/streamManager')
const { runInferencePipeline } = require('./core/inferenceEngine')
const { getDifyConfig } = require('./core/difyConnector')
const { sendJson, successEnvelope, errorEnvelope } = require('./core/response')
const { generateTraceId, normalizeTraceId } = require('./utils/trace')
const { writeLog, redact } = require('./core/logger')
const { MetricsStore } = require('./core/metrics')
const { AuditStore } = require('./core/auditStore')
const { getRuntimeResources, initializeRuntimeResources } = require('./core/runtimeResources')

const port = Number(process.env.PORT || 8080)
const appEnv = process.env.APP_ENV || 'dev'
const host = process.env.HOST || (appEnv === 'prod' ? '0.0.0.0' : '127.0.0.1')
const rateWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000)
const rateMaxRequests = Number(process.env.RATE_LIMIT_MAX_REQUESTS || 120)
const rateMaxTenantRequests = Number(process.env.RATE_LIMIT_TENANT_MAX_REQUESTS || 300)
const rateLimitKeyStrategy = process.env.RATE_LIMIT_KEY_STRATEGY || 'hybrid'
const enableMetrics = String(process.env.ENABLE_METRICS || (appEnv === 'prod' ? 'false' : 'true')).toLowerCase() === 'true'

const scenarioRegistry = new ScenarioRegistry()
scenarioRegistry.load()
initializeRuntimeResources()

const streamManager = new StreamManager({
  heartbeatMs: Number(process.env.SSE_HEARTBEAT_MS || 15_000),
  clientTtlMs: Number(process.env.SSE_CLIENT_TTL_MS || 120_000),
  maxConnections: Number(process.env.SSE_MAX_CONNECTIONS || 2000)
})

const rateLimiter = new InMemoryRateLimiter({
  windowMs: rateWindowMs,
  maxRequests: rateMaxRequests,
  tenantMaxRequests: rateMaxTenantRequests
})

const metrics = new MetricsStore()
const auditStore = new AuditStore()
const { knowledgeManager, kbMappingStore } = getRuntimeResources()

const requestStore = new Map()
const difyConfig = getDifyConfig()

function getClientIp(req) {
  const xff = req.headers['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) {
    return xff.split(',')[0].trim()
  }
  return req.socket.remoteAddress || 'unknown'
}

function getRateLimitIdentity(req, tenantId) {
  const ip = getClientIp(req)
  if (rateLimitKeyStrategy === 'tenant' && tenantId) {
    return { key: `tenant:${tenantId}`, scope: 'tenant' }
  }

  if (rateLimitKeyStrategy === 'ip') {
    return { key: `ip:${ip}`, scope: 'ip' }
  }

  if (tenantId) {
    return { key: `tenant:${tenantId}:ip:${ip}`, scope: 'tenant' }
  }

  return { key: `ip:${ip}`, scope: 'ip' }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    const maxBytes = Number(process.env.MAX_REQUEST_BYTES || 2 * 1024 * 1024)

    req.on('data', (chunk) => {
      body += chunk
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error('payload too large'))
      }
    })

    req.on('end', () => {
      if (!body) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(body))
      } catch (_error) {
        reject(new Error('invalid json body'))
      }
    })

    req.on('error', (error) => {
      reject(error)
    })
  })
}

function auditUpsert(record) {
  const prev = requestStore.get(record.trace_id) || auditStore.get(record.trace_id) || {}
  const merged = {
    ...prev,
    ...record
  }

  if (record.feedback) {
    const existingFeedback = Array.isArray(prev.feedback_events) ? prev.feedback_events : []
    merged.feedback_events = [
      ...existingFeedback,
      {
        feedback: record.feedback,
        operator: record.operator || null,
        at: record.feedback_at || new Date().toISOString()
      }
    ]
  }

  requestStore.set(record.trace_id, merged)
  auditStore.save(merged)
}

function gatewayGuard(req, traceId, res) {
  const auth = verifyAuth(req)
  if (!auth.ok) {
    metrics.inc('auth_fail_total')
    sendJson(res, auth.code === 'FORBIDDEN' ? 403 : 401, errorEnvelope(traceId, auth.code, auth.message))
    return { ok: false }
  }

  const rateIdentity = getRateLimitIdentity(req, auth.tenantId)
  const rate = rateLimiter.isAllowed(rateIdentity.key, rateIdentity.scope)
  if (!rate.allowed) {
    metrics.inc('rate_limited_total')
    sendJson(
      res,
      429,
      errorEnvelope(traceId, 'RATE_LIMITED', 'too many requests', {
        retry_after_ms: rate.retryAfterMs || 1000,
        key_scope: rateIdentity.scope,
        limit: rate.limit
      })
    )
    return { ok: false }
  }

  return {
    ok: true,
    tenantId: auth.tenantId || null,
    ip: getClientIp(req)
  }
}

function normalizeErrorForClient(error) {
  if (!error) return { code: 'INTERNAL_ERROR', message: 'unknown error', details: {} }
  if (typeof error === 'string') return { code: 'INTERNAL_ERROR', message: error, details: {} }

  const code = typeof error.code === 'string' && error.code ? error.code : 'INTERNAL_ERROR'
  const message = typeof error.message === 'string' && error.message ? error.message : 'internal error'
  const details = error.details && typeof error.details === 'object' ? error.details : {}
  return { code, message, details }
}

async function handleInfer(req, res, traceId) {
  const guard = gatewayGuard(req, traceId, res)
  if (!guard.ok) return

  const started = Date.now()
  metrics.inc('infer_total')

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    metrics.inc('infer_failed_total')
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const scenarioId = typeof payload.scenario_id === 'string' ? payload.scenario_id : ''
  const scenario = scenarioRegistry.get(scenarioId)
  if (!scenario) {
    metrics.inc('infer_failed_total')
    sendJson(res, 404, errorEnvelope(traceId, 'SCENARIO_NOT_FOUND', `scenario not found: ${scenarioId}`))
    return
  }

  if (!scenario.enabled) {
    metrics.inc('infer_failed_total')
    sendJson(res, 403, errorEnvelope(traceId, 'FORBIDDEN', `scenario disabled: ${scenarioId}`))
    return
  }

  const validation = validateInfer(payload, scenario)
  if (!validation.ok) {
    metrics.inc('infer_failed_total')
    sendJson(res, 400, errorEnvelope(traceId, validation.code, validation.message, { errors: validation.details }))
    return
  }

  const policy = derivePolicy(payload, scenario)
  auditUpsert({
    trace_id: traceId,
    scenario_id: scenarioId,
    tenant_id: guard.tenantId,
    ip: guard.ip,
    status: 'processing',
    request_meta: {
      stream: Boolean(payload.options && payload.options.stream),
      quality_tier: policy.quality_tier,
      latency_budget_ms: policy.total_latency_budget_ms,
      has_images: Array.isArray(payload.input && payload.input.images),
      has_text: typeof payload.input?.text === 'string'
    },
    policy,
    created_at: new Date().toISOString()
  })

  const stream = Boolean(payload.options && payload.options.stream)

  if (stream) {
    runInferencePipeline({ traceId, payload, scenario, policy, streamManager, tenantId: guard.tenantId })
      .then((result) => {
        metrics.inc('infer_success_total')
        metrics.observeLatency('infer_ms', Date.now() - started)
        auditUpsert({
          trace_id: traceId,
          scenario_id: scenarioId,
          tenant_id: guard.tenantId,
          status: 'completed',
          result,
          policy,
          completed_at: new Date().toISOString(),
          latency_ms: Date.now() - started
        })
      })
      .catch((error) => {
        const normalized = normalizeErrorForClient(error)
        metrics.inc('infer_failed_total')
        streamManager.publish(traceId, 'error', {
          trace_id: traceId,
          code: normalized.code,
          message: normalized.message,
          details: normalized.details
        })
        auditUpsert({
          trace_id: traceId,
          scenario_id: scenarioId,
          tenant_id: guard.tenantId,
          status: 'error',
          error: { code: normalized.code, message: normalized.message, details: normalized.details },
          policy,
          completed_at: new Date().toISOString(),
          latency_ms: Date.now() - started
        })
      })

    sendJson(
      res,
      200,
      successEnvelope(traceId, {
        trace_id: traceId,
        status: 'processing',
        stream_url: `/v1/infer/stream/${traceId}`,
        scenario_id: scenarioId,
        policy
      })
    )

    writeLog('info', 'infer accepted (stream)', {
      trace_id: traceId,
      scenario_id: scenarioId,
      tenant_id: guard.tenantId,
      client_ip: redact(guard.ip)
    })
    return
  }

  try {
    const result = await runInferencePipeline({ traceId, payload, scenario, policy, streamManager, tenantId: guard.tenantId })
    metrics.inc('infer_success_total')
    metrics.observeLatency('infer_ms', Date.now() - started)

    auditUpsert({
      trace_id: traceId,
      scenario_id: scenarioId,
      tenant_id: guard.tenantId,
      status: 'completed',
      result,
      policy,
      completed_at: new Date().toISOString(),
      latency_ms: Date.now() - started
    })

    sendJson(res, 200, successEnvelope(traceId, result))

    writeLog('info', 'infer completed', {
      trace_id: traceId,
      scenario_id: scenarioId,
      tenant_id: guard.tenantId,
      latency_ms: Date.now() - started
    })
  } catch (error) {
    const normalized = normalizeErrorForClient(error)
    metrics.inc('infer_failed_total')
    auditUpsert({
      trace_id: traceId,
      scenario_id: scenarioId,
      tenant_id: guard.tenantId,
      status: 'error',
      error: { code: normalized.code, message: normalized.message, details: normalized.details },
      policy,
      completed_at: new Date().toISOString(),
      latency_ms: Date.now() - started
    })
    const httpCode = normalized.code === 'UPSTREAM_TIMEOUT' ? 504 : 502
    sendJson(res, httpCode, errorEnvelope(traceId, normalized.code, normalized.message, normalized.details))
  }
}

function handleStream(req, res, traceId, pathname) {
  const guard = gatewayGuard(req, traceId, res)
  if (!guard.ok) return

  const parts = pathname.split('/')
  const streamTraceId = parts[parts.length - 1]
  if (!streamTraceId) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'trace id is required'))
    return
  }

  if (!streamManager.canAcceptConnection()) {
    sendJson(res, 503, errorEnvelope(traceId, 'RATE_LIMITED', 'stream capacity reached'))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write('retry: 3000\n\n')

  const added = streamManager.addClient(streamTraceId, req, res)
  if (!added.ok) {
    streamManager.sendEvent(res, 'error', {
      trace_id: streamTraceId,
      code: 'RATE_LIMITED',
      message: 'stream capacity reached'
    })
    try {
      res.end()
    } catch (_error) {
      // ignore
    }
    return
  }

  metrics.inc('stream_connections_total')
  metrics.inc('stream_active_connections', 1)

  streamManager.sendEvent(res, 'connected', {
    trace_id: streamTraceId,
    status: 'connected'
  })

  const record = requestStore.get(streamTraceId) || auditStore.get(streamTraceId)
  if (record && record.status === 'completed' && record.result) {
    streamManager.sendEvent(res, 'completed', {
      trace_id: streamTraceId,
      result: record.result
    })
  }

  req.on('close', () => {
    const group = streamManager.clients.get(streamTraceId)
    if (group) {
      for (const client of group) {
        if (client.res === res) {
          streamManager.removeClient(streamTraceId, client)
          metrics.inc('stream_active_connections', -1)
          break
        }
      }
    }
  })
}

async function handleFeedback(req, res, traceId) {
  const guard = gatewayGuard(req, traceId, res)
  if (!guard.ok) return

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const validation = validateFeedbackPayload(payload)
  if (!validation.ok) {
    sendJson(res, 400, errorEnvelope(traceId, validation.code, validation.message, { errors: validation.details }))
    return
  }

  metrics.inc('feedback_total')
  auditUpsert({
    trace_id: payload.trace_id,
    scenario_id: payload.scenario_id || null,
    tenant_id: guard.tenantId,
    status: 'feedback_received',
    feedback: payload.feedback,
    operator: payload.operator || null,
    feedback_at: new Date().toISOString()
  })

  sendJson(res, 200, successEnvelope(traceId, { accepted: true }))
}

function handleTraceQuery(req, res, traceId, queryTraceId) {
  const guard = gatewayGuard(req, traceId, res)
  if (!guard.ok) return

  const record = requestStore.get(queryTraceId) || auditStore.get(queryTraceId)
  if (!record) {
    sendJson(res, 404, errorEnvelope(traceId, 'NOT_FOUND', `trace not found: ${queryTraceId}`))
    return
  }

  if (guard.tenantId && record.tenant_id && guard.tenantId !== record.tenant_id) {
    sendJson(res, 403, errorEnvelope(traceId, 'FORBIDDEN', 'trace is not accessible for this tenant'))
    return
  }

  sendJson(res, 200, successEnvelope(traceId, { trace: record }))
}

function handleMetrics(req, res, traceId) {
  if (!enableMetrics) {
    sendJson(res, 404, errorEnvelope(traceId, 'NOT_FOUND', 'route not found'))
    return
  }

  const guard = gatewayGuard(req, traceId, res)
  if (!guard.ok) return

  sendJson(res, 200, successEnvelope(traceId, metrics.snapshot()))
}

const server = http.createServer(async (req, res) => {
  metrics.inc('requests_total')

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = url.pathname
  const traceId = normalizeTraceId(req.headers['x-trace-id']) || generateTraceId()

  if (pathname === '/health' && req.method === 'GET') {
    sendJson(
      res,
      200,
      successEnvelope(traceId, {
        status: 'ok',
        stage: 'phase-4-scenario-routing',
        env: appEnv,
        scenario_count: scenarioRegistry.count(),
        scenarios: scenarioRegistry.listIds(),
        stream: streamManager.getStats(),
        dify: {
          enabled: difyConfig.enabled,
          base_url_configured: Boolean(difyConfig.baseUrl),
          fallback_to_mock: difyConfig.fallbackToMock
        },
        knowledge: {
          kb_registry: knowledgeManager.getRegistryInfo(),
          kb_mappings: {
            scenarios: kbMappingStore.listScenarioIds()
          }
        }
      })
    )
    return
  }

  if (pathname === '/metrics' && req.method === 'GET') {
    handleMetrics(req, res, traceId)
    return
  }

  if (pathname === '/v1/infer' && req.method === 'POST') {
    await handleInfer(req, res, traceId)
    return
  }

  if (pathname.startsWith('/v1/infer/stream/') && req.method === 'GET') {
    handleStream(req, res, traceId, pathname)
    return
  }

  if (pathname === '/v1/feedback' && req.method === 'POST') {
    await handleFeedback(req, res, traceId)
    return
  }

  if (pathname.startsWith('/v1/traces/') && req.method === 'GET') {
    const parts = pathname.split('/')
    const queryTraceId = parts[parts.length - 1]
    handleTraceQuery(req, res, traceId, queryTraceId)
    return
  }

  sendJson(res, 404, errorEnvelope(traceId, 'NOT_FOUND', 'route not found'))
})

server.listen(port, host, () => {
  writeLog('info', 'server started', {
    trace_id: 'bootstrap',
    env: appEnv,
    host,
    port,
    scenario_count: scenarioRegistry.count()
  })
  console.log(`[DifyModel] server listening on http://${host}:${port}`)
})
