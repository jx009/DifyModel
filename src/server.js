const http = require('http')
const { URL } = require('url')
const fs = require('fs')
const path = require('path')

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
const { AdminConfigStore } = require('./core/adminConfigStore')
const { resolveScenarioWithAdminOverrides, getAdminEffectiveConfigView, maskSecret } = require('./core/adminConfigResolver')
const { verifyAdminAuth, isAdminConsoleEnabled } = require('./core/adminAuth')
const { uploadImageToDify, runWorkflowTest } = require('./core/adminTestService')
const { encryptSecret } = require('./core/adminSecrets')
const { writeAdminAction } = require('./core/adminActionAudit')

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
const adminConfigStore = new AdminConfigStore()
const { knowledgeManager, kbMappingStore } = getRuntimeResources()

const requestStore = new Map()
const difyConfig = getDifyConfig()
const adminWebDir = path.join(process.cwd(), 'admin-web')

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
  const baseScenario = scenarioRegistry.get(scenarioId)
  if (!baseScenario) {
    metrics.inc('infer_failed_total')
    sendJson(res, 404, errorEnvelope(traceId, 'SCENARIO_NOT_FOUND', `scenario not found: ${scenarioId}`))
    return
  }

  const scenario = resolveScenarioWithAdminOverrides(baseScenario, adminConfigStore.getConfig()) || baseScenario

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

function getMimeType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8'
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8'
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function serveAdminStatic(req, res, pathname) {
  if (!isAdminConsoleEnabled()) {
    return false
  }
  if (req.method !== 'GET') return false
  if (!pathname.startsWith('/admin')) return false
  if (pathname.startsWith('/admin/api/')) return false

  const relative = pathname === '/admin' || pathname === '/admin/' ? 'index.html' : pathname.replace(/^\/admin\//, '')
  const normalized = path.normalize(relative).replace(/^(\.\.[/\\])+/, '')
  const fullPath = path.join(adminWebDir, normalized)

  if (!fullPath.startsWith(adminWebDir)) {
    sendJson(res, 403, errorEnvelope('admin_static', 'FORBIDDEN', 'forbidden'))
    return true
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    sendJson(res, 404, errorEnvelope('admin_static', 'NOT_FOUND', 'resource not found'))
    return true
  }

  try {
    const content = fs.readFileSync(fullPath)
    res.writeHead(200, { 'Content-Type': getMimeType(fullPath) })
    res.end(content)
  } catch (_error) {
    sendJson(res, 500, errorEnvelope('admin_static', 'INTERNAL_ERROR', 'failed to read resource'))
  }
  return true
}

function parseAdminPath(pathname) {
  return pathname.split('/').filter(Boolean)
}

function adminGuard(req, res, traceId) {
  const expectedToken = String(process.env.ADMIN_TOKEN || '').trim()
  if (expectedToken) {
    try {
      const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
      const tokenFromQuery = (parsedUrl.searchParams.get('admin_token') || '').trim()
      if (tokenFromQuery && tokenFromQuery === expectedToken) {
        return { ok: true }
      }
    } catch (_error) {
      // ignore
    }
  }

  const auth = verifyAdminAuth(req)
  if (auth.ok) return { ok: true }

  if (auth.code === 'NOT_FOUND') {
    sendJson(res, 404, errorEnvelope(traceId, auth.code, auth.message))
    return { ok: false }
  }

  const status = auth.code === 'UNAUTHORIZED' ? 401 : 403
  sendJson(res, status, errorEnvelope(traceId, auth.code, auth.message))
  return { ok: false }
}

function getAdminActor(req) {
  const actor = req.headers['x-admin-user']
  if (typeof actor === 'string' && actor.trim()) return actor.trim()
  return 'admin'
}

function logAdminAction({ traceId, actor, action, target, beforeSummary, afterSummary, status, error }) {
  writeAdminAction({
    trace_id: traceId,
    actor: actor || 'admin',
    action,
    target: target || null,
    status: status || 'success',
    before: beforeSummary || null,
    after: afterSummary || null,
    error: error || null
  })
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function sanitizeRoutesPayload(payload) {
  if (!isObject(payload)) return null

  const routes = isObject(payload.routes) ? payload.routes : payload
  const subTypeRoutes = {}
  const rawMap = isObject(routes.sub_type_routes) ? routes.sub_type_routes : {}
  const maxRoutes = Number(process.env.ADMIN_MAX_SUB_TYPE_ROUTES || 64)
  if (Object.keys(rawMap).length > maxRoutes) return null
  for (const [subType, workflowId] of Object.entries(rawMap)) {
    if (typeof subType !== 'string' || !subType.trim()) continue
    if (typeof workflowId !== 'string' || !workflowId.trim()) continue
    if (subType.trim().length > 128 || workflowId.trim().length > 256) continue
    subTypeRoutes[subType.trim()] = workflowId.trim()
  }

  return {
    main_workflow_id: typeof routes.main_workflow_id === 'string' && routes.main_workflow_id.trim() ? routes.main_workflow_id.trim() : null,
    fallback_workflow_id:
      typeof routes.fallback_workflow_id === 'string' && routes.fallback_workflow_id.trim() ? routes.fallback_workflow_id.trim() : null,
    sub_type_routes: subTypeRoutes
  }
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  const maxItems = Number(process.env.ADMIN_MAX_ARRAY_ITEMS || 50)
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean)
    .slice(0, maxItems)
}

function sanitizeSubTypeProfilePayload(payload) {
  if (!isObject(payload)) return null
  const hints = isObject(payload.classifier_hints) ? payload.classifier_hints : {}
  const guidance = isObject(payload.workflow_guidance) ? payload.workflow_guidance : {}
  const displayName = typeof payload.display_name === 'string' ? payload.display_name.trim() : ''
  const workflowId = typeof payload.workflow_id === 'string' ? payload.workflow_id.trim() : ''

  return {
    ...(displayName ? { display_name: displayName.slice(0, 120) } : {}),
    ...(workflowId ? { workflow_id: workflowId.slice(0, 256) } : {}),
    classifier_hints: {
      keywords: asStringArray(hints.keywords),
      ...(hints.require_images !== undefined ? { require_images: Boolean(hints.require_images) } : {}),
      ...(hints.prefer_images !== undefined ? { prefer_images: Boolean(hints.prefer_images) } : {}),
      ...(hints.image_only_default !== undefined ? { image_only_default: Boolean(hints.image_only_default) } : {})
    },
    workflow_guidance: {
      solving_steps: asStringArray(guidance.solving_steps),
      prompt_focus: asStringArray(guidance.prompt_focus),
      answer_constraints: asStringArray(guidance.answer_constraints)
    }
  }
}

async function handleAdminGetConfig(req, res, traceId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  const scenarioIdRaw = req.url.includes('?')
    ? new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams.get('scenario_id')
    : null
  const scenarioId = typeof scenarioIdRaw === 'string' && scenarioIdRaw.trim() ? scenarioIdRaw.trim() : 'exam_qa'

  sendJson(
    res,
    200,
    successEnvelope(traceId, {
      admin_config: getAdminEffectiveConfigView({ adminStore: adminConfigStore, registry: scenarioRegistry, scenarioId }),
      scenario_ids: scenarioRegistry.listIds()
    })
  )
}

async function handleAdminUpdateRoutes(req, res, traceId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const nextRoutes = sanitizeRoutesPayload(payload)
  if (!nextRoutes) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'routes payload is invalid'))
    return
  }

  try {
    const actor = getAdminActor(req)
    const prev = adminConfigStore.getConfig()
    const updated = adminConfigStore.updateConfig((current) => {
      current.routes = nextRoutes
      return current
    }, { reason: 'update_routes', updated_by: actor })

    writeLog('info', 'admin routes updated', {
      trace_id: traceId,
      actor,
      route_count: Object.keys(nextRoutes.sub_type_routes || {}).length
    })
    logAdminAction({
      traceId,
      actor,
      action: 'update_routes',
      target: 'routes',
      beforeSummary: { route_count: Object.keys(prev.routes?.sub_type_routes || {}).length },
      afterSummary: { route_count: Object.keys(updated.routes?.sub_type_routes || {}).length },
      status: 'success'
    })

    sendJson(res, 200, successEnvelope(traceId, { routes: updated.routes }))
  } catch (error) {
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'update_routes',
      target: 'routes',
      status: 'failed',
      error: { code: error.code || 'INVALID_INPUT', message: error.message }
    })
    sendJson(res, 400, errorEnvelope(traceId, error.code || 'INVALID_INPUT', error.message, { details: error.details || [] }))
  }
}

async function handleAdminUpdateSubTypeProfile(req, res, traceId, subType) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  if (!subType) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'sub type is required'))
    return
  }

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const nextProfile = sanitizeSubTypeProfilePayload(payload)
  if (!nextProfile) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'sub type profile payload is invalid'))
    return
  }

  try {
    const actor = getAdminActor(req)
    const prev = adminConfigStore.getConfig()
    const updated = adminConfigStore.updateConfig((current) => {
      current.sub_type_profiles = current.sub_type_profiles || {}
      current.sub_type_profiles[subType] = nextProfile
      return current
    }, { reason: `update_sub_type_profile:${subType}`, updated_by: actor })

    writeLog('info', 'admin sub type profile updated', {
      trace_id: traceId,
      actor,
      sub_type: subType
    })
    logAdminAction({
      traceId,
      actor,
      action: 'update_sub_type_profile',
      target: `sub_type_profiles.${subType}`,
      beforeSummary: { existed: Boolean(prev.sub_type_profiles?.[subType]) },
      afterSummary: { existed: Boolean(updated.sub_type_profiles?.[subType]) },
      status: 'success'
    })

    sendJson(res, 200, successEnvelope(traceId, { sub_type: subType, profile: updated.sub_type_profiles[subType] }))
  } catch (error) {
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'update_sub_type_profile',
      target: `sub_type_profiles.${subType}`,
      status: 'failed',
      error: { code: error.code || 'INVALID_INPUT', message: error.message }
    })
    sendJson(res, 400, errorEnvelope(traceId, error.code || 'INVALID_INPUT', error.message, { details: error.details || [] }))
  }
}

async function handleAdminUpdateWorkflowKey(req, res, traceId, workflowId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  if (!workflowId) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'workflow id is required'))
    return
  }

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const keyValue = typeof payload.key === 'string' ? payload.key.trim() : ''
  const maxKeyChars = Number(process.env.ADMIN_MAX_KEY_CHARS || 512)
  if (!keyValue) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'key is required'))
    return
  }
  if (keyValue.length > maxKeyChars) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', `key is too long (max ${maxKeyChars})`))
    return
  }

  try {
    const actor = getAdminActor(req)
    const encrypted = encryptSecret(keyValue)
    const updated = adminConfigStore.updateConfig((current) => {
      current.workflow_keys = current.workflow_keys || {}
      current.workflow_keys[workflowId] = {
        masked: maskSecret(keyValue),
        encrypted: encrypted || null,
        value: encrypted ? null : keyValue
      }
      return current
    }, { reason: `update_workflow_key:${workflowId}`, updated_by: actor })

    writeLog('info', 'admin workflow key updated', {
      trace_id: traceId,
      actor,
      workflow_id: workflowId
    })
    logAdminAction({
      traceId,
      actor,
      action: 'update_workflow_key',
      target: `workflow_keys.${workflowId}`,
      afterSummary: { encrypted: Boolean(encrypted), masked: maskSecret(keyValue) },
      status: 'success'
    })

    sendJson(
      res,
      200,
      successEnvelope(traceId, {
        workflow_id: workflowId,
        key: {
          masked: updated.workflow_keys[workflowId].masked,
          has_value: Boolean(updated.workflow_keys[workflowId].value),
          encrypted: Boolean(updated.workflow_keys[workflowId].encrypted)
        }
      })
    )
  } catch (error) {
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'update_workflow_key',
      target: `workflow_keys.${workflowId}`,
      status: 'failed',
      error: { code: error.code || 'INVALID_INPUT', message: error.message }
    })
    sendJson(res, 400, errorEnvelope(traceId, error.code || 'INVALID_INPUT', error.message, { details: error.details || [] }))
  }
}

async function handleAdminUpdateWorkflowPrompt(req, res, traceId, workflowId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  if (!workflowId) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'workflow id is required'))
    return
  }

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const content = typeof payload.content === 'string' ? payload.content : ''
  const maxPromptChars = Number(process.env.ADMIN_MAX_PROMPT_CHARS || 50_000)
  if (!content.trim()) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'prompt content is required'))
    return
  }
  if (content.length > maxPromptChars) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', `prompt content is too long (max ${maxPromptChars})`))
    return
  }

  try {
    const actor = getAdminActor(req)
    const prev = adminConfigStore.getConfig()
    const updated = adminConfigStore.updateConfig((current) => {
      current.workflow_prompts = current.workflow_prompts || {}
      const prev = current.workflow_prompts[workflowId] || {}
      const prevVersion = Number(prev.version || 0)
      current.workflow_prompts[workflowId] = {
        version: Number.isFinite(prevVersion) ? prevVersion + 1 : 1,
        content,
        updated_at: new Date().toISOString()
      }
      return current
    }, { reason: `update_workflow_prompt:${workflowId}`, updated_by: actor })

    writeLog('info', 'admin workflow prompt updated', {
      trace_id: traceId,
      actor,
      workflow_id: workflowId,
      version: updated.workflow_prompts[workflowId].version
    })
    logAdminAction({
      traceId,
      actor,
      action: 'update_workflow_prompt',
      target: `workflow_prompts.${workflowId}`,
      beforeSummary: { version: prev.workflow_prompts?.[workflowId]?.version || 0 },
      afterSummary: { version: updated.workflow_prompts[workflowId].version },
      status: 'success'
    })

    sendJson(
      res,
      200,
      successEnvelope(traceId, {
        workflow_id: workflowId,
        prompt: {
          version: updated.workflow_prompts[workflowId].version,
          updated_at: updated.workflow_prompts[workflowId].updated_at
        }
      })
    )
  } catch (error) {
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'update_workflow_prompt',
      target: `workflow_prompts.${workflowId}`,
      status: 'failed',
      error: { code: error.code || 'INVALID_INPUT', message: error.message }
    })
    sendJson(res, 400, errorEnvelope(traceId, error.code || 'INVALID_INPUT', error.message, { details: error.details || [] }))
  }
}

async function handleAdminListHistory(req, res, traceId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  const snapshots = adminConfigStore.listSnapshots(Number(process.env.ADMIN_HISTORY_LIST_LIMIT || 50))
  sendJson(res, 200, successEnvelope(traceId, { snapshots }))
}

async function handleAdminRollbackHistory(req, res, traceId, snapshotId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return
  const actor = getAdminActor(req)
  try {
    const updated = adminConfigStore.rollbackSnapshot(snapshotId, { updated_by: actor })
    writeLog('warn', 'admin config rollback', {
      trace_id: traceId,
      actor,
      snapshot_id: snapshotId
    })
    logAdminAction({
      traceId,
      actor,
      action: 'rollback_config',
      target: `snapshot:${snapshotId}`,
      afterSummary: { updated_at: updated.updated_at },
      status: 'success'
    })
    sendJson(res, 200, successEnvelope(traceId, { rolled_back_to: snapshotId, updated_at: updated.updated_at }))
  } catch (error) {
    logAdminAction({
      traceId,
      actor,
      action: 'rollback_config',
      target: `snapshot:${snapshotId}`,
      status: 'failed',
      error: { code: error.code || 'INVALID_INPUT', message: error.message }
    })
    const code = error.code || 'INVALID_INPUT'
    const status = code === 'NOT_FOUND' ? 404 : 400
    sendJson(res, status, errorEnvelope(traceId, code, error.message))
  }
}

async function handleAdminTestUpload(req, res, traceId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const base64 = typeof payload.base64 === 'string' ? payload.base64 : ''
  const filename = typeof payload.filename === 'string' ? payload.filename : ''
  const contentType = typeof payload.content_type === 'string' ? payload.content_type : ''
  const user = typeof payload.user === 'string' ? payload.user : undefined
  const workflowId = typeof payload.workflow_id === 'string' && payload.workflow_id.trim() ? payload.workflow_id.trim() : ''

  if (!base64.trim()) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'base64 is required'))
    return
  }
  if (!workflowId) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', 'workflow_id is required for upload'))
    return
  }

  try {
    const uploadResult = await uploadImageToDify({
      base64,
      filename,
      contentType,
      user,
      workflowId
    })
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'test_upload',
      target: 'dify_files_upload',
      afterSummary: { file_id: uploadResult.file_id, bytes: uploadResult.bytes },
      status: 'success'
    })
    sendJson(res, 200, successEnvelope(traceId, uploadResult))
  } catch (error) {
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'test_upload',
      target: 'dify_files_upload',
      status: 'failed',
      error: { code: error.code || 'UPSTREAM_ERROR', message: error.message }
    })
    const code = error.code || 'UPSTREAM_ERROR'
    const status = code === 'INVALID_INPUT' ? 400 : code === 'UPSTREAM_TIMEOUT' ? 504 : 502
    sendJson(res, status, errorEnvelope(traceId, code, error.message, error.details || {}))
  }
}

async function handleAdminTestRun(req, res, traceId) {
  const guard = adminGuard(req, res, traceId)
  if (!guard.ok) return

  let payload
  try {
    payload = await readJsonBody(req)
  } catch (error) {
    sendJson(res, 400, errorEnvelope(traceId, 'INVALID_INPUT', error.message))
    return
  }

  const scenarioId = typeof payload.scenario_id === 'string' && payload.scenario_id.trim() ? payload.scenario_id.trim() : 'exam_qa'
  const baseScenario = scenarioRegistry.get(scenarioId)
  if (!baseScenario) {
    sendJson(res, 404, errorEnvelope(traceId, 'SCENARIO_NOT_FOUND', `scenario not found: ${scenarioId}`))
    return
  }

  const adminConfig = adminConfigStore.getConfig()
  const scenario = resolveScenarioWithAdminOverrides(baseScenario, adminConfig) || baseScenario

  try {
    const result = await runWorkflowTest({
      scenario,
      payload,
      traceId,
      tenantId: payload?.context?.tenant_id || null,
      knowledgeManager,
      kbMappingStore,
      adminConfig
    })
    auditUpsert({
      trace_id: traceId,
      scenario_id: scenarioId,
      tenant_id: payload?.context?.tenant_id || null,
      status: 'completed',
      result,
      policy: { source: 'admin_test' },
      completed_at: new Date().toISOString(),
      latency_ms: result?.metrics?.latency_ms || 0
    })
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'test_run',
      target: `scenario:${scenarioId}`,
      afterSummary: {
        workflow_id: result.workflow_id || null,
        sub_type: result.sub_type || null,
        latency_ms: result?.metrics?.latency_ms || 0
      },
      status: 'success'
    })
    sendJson(res, 200, successEnvelope(traceId, result))
  } catch (error) {
    const code = error.code || 'UPSTREAM_ERROR'
    const status = code === 'INVALID_INPUT' ? 400 : code === 'WORKFLOW_NOT_FOUND' ? 404 : code === 'UPSTREAM_TIMEOUT' ? 504 : 502
    auditUpsert({
      trace_id: traceId,
      scenario_id: scenarioId,
      tenant_id: payload?.context?.tenant_id || null,
      status: 'error',
      error: { code, message: error.message, details: error.details || {} },
      policy: { source: 'admin_test' },
      completed_at: new Date().toISOString()
    })
    logAdminAction({
      traceId,
      actor: getAdminActor(req),
      action: 'test_run',
      target: `scenario:${scenarioId}`,
      status: 'failed',
      error: { code, message: error.message }
    })
    sendJson(res, status, errorEnvelope(traceId, code, error.message, error.details || {}))
  }
}

function handleAdminTestStream(req, res, traceId, pathname) {
  const guard = adminGuard(req, res, traceId)
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
          break
        }
      }
    }
  })
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
        },
        admin: {
          config: adminConfigStore.getInfo()
        }
      })
    )
    return
  }

  if (pathname === '/metrics' && req.method === 'GET') {
    handleMetrics(req, res, traceId)
    return
  }

  if (serveAdminStatic(req, res, pathname)) {
    return
  }

  if (pathname === '/admin/api/config' && req.method === 'GET') {
    await handleAdminGetConfig(req, res, traceId)
    return
  }

  if (pathname === '/admin/api/history' && req.method === 'GET') {
    await handleAdminListHistory(req, res, traceId)
    return
  }

  if (pathname.startsWith('/admin/api/history/') && pathname.endsWith('/rollback') && req.method === 'POST') {
    const parts = parseAdminPath(pathname)
    const snapshotId = parts.length >= 4 ? decodeURIComponent(parts[3]) : ''
    await handleAdminRollbackHistory(req, res, traceId, snapshotId)
    return
  }

  if (pathname === '/admin/api/routes' && req.method === 'PUT') {
    await handleAdminUpdateRoutes(req, res, traceId)
    return
  }

  if (pathname.startsWith('/admin/api/subtypes/') && pathname.endsWith('/profile') && req.method === 'PUT') {
    const parts = parseAdminPath(pathname)
    const subType = parts.length >= 4 ? decodeURIComponent(parts[3]) : ''
    await handleAdminUpdateSubTypeProfile(req, res, traceId, subType)
    return
  }

  if (pathname.startsWith('/admin/api/workflows/') && pathname.endsWith('/key') && req.method === 'PUT') {
    const parts = parseAdminPath(pathname)
    const workflowId = parts.length >= 4 ? decodeURIComponent(parts[3]) : ''
    await handleAdminUpdateWorkflowKey(req, res, traceId, workflowId)
    return
  }

  if (pathname.startsWith('/admin/api/workflows/') && pathname.endsWith('/prompt') && req.method === 'PUT') {
    const parts = parseAdminPath(pathname)
    const workflowId = parts.length >= 4 ? decodeURIComponent(parts[3]) : ''
    await handleAdminUpdateWorkflowPrompt(req, res, traceId, workflowId)
    return
  }

  if (pathname === '/admin/api/test/upload' && req.method === 'POST') {
    await handleAdminTestUpload(req, res, traceId)
    return
  }

  if (pathname === '/admin/api/test/run' && req.method === 'POST') {
    await handleAdminTestRun(req, res, traceId)
    return
  }

  if (pathname.startsWith('/admin/api/test/stream/') && req.method === 'GET') {
    handleAdminTestStream(req, res, traceId, pathname)
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
