const { detectExamSubTypeHeuristic } = require('./examRouter')
const { buildDifyImageFiles } = require('./difyFiles')

function parseClassifierMode() {
  return String(process.env.EXAM_SUBTYPE_CLASSIFIER_MODE || 'heuristic').toLowerCase()
}

function shouldReclassifyOnRetry() {
  return String(process.env.EXAM_RECLASSIFY_ON_RETRY || 'false').toLowerCase() === 'true'
}

function safeParseJson(text) {
  try {
    return JSON.parse(text)
  } catch (_error) {
    return null
  }
}

function buildClassifierHints(scenario) {
  const profiles = scenario?.sub_type_profiles
  if (!profiles || typeof profiles !== 'object') return {}
  const out = {}
  for (const [subType, profileRaw] of Object.entries(profiles)) {
    const profile = profileRaw && typeof profileRaw === 'object' ? profileRaw : {}
    const hints = profile.classifier_hints && typeof profile.classifier_hints === 'object' ? profile.classifier_hints : {}
    const keywords = Array.isArray(hints.keywords) ? hints.keywords.filter((x) => typeof x === 'string' && x.trim()) : []
    out[subType] = {
      keywords,
      require_images: Boolean(hints.require_images),
      prefer_images: Boolean(hints.prefer_images)
    }
  }
  return out
}

async function classifyWithDify(payload, scenario, traceId) {
  const baseUrl = (process.env.DIFY_BASE_URL || '').replace(/\/$/, '')
  const apiKey = process.env.DIFY_SUBTYPE_CLASSIFIER_API_KEY || process.env.DIFY_API_KEY || ''
  const timeoutMs = Number(process.env.DIFY_SUBTYPE_TIMEOUT_MS || process.env.DIFY_TIMEOUT_MS || 8000)

  if (!baseUrl || !apiKey) {
    throw new Error('classifier dify config missing')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const files = buildDifyImageFiles(payload?.input)
    const body = {
      inputs: {
        input: payload.input || {},
        images: files,
        context: payload.context || {},
        scenario_id: scenario?.scenario_id || null,
        classifier_hints: buildClassifierHints(scenario),
        trace_id: traceId
      },
      response_mode: 'blocking',
      user: `classifier:${traceId}`,
      files
    }

    const res = await fetch(`${baseUrl}/v1/workflows/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    const raw = await res.text()
    const parsed = safeParseJson(raw)
    if (!res.ok || !parsed) {
      throw new Error(`classifier upstream failed: ${res.status}`)
    }

    const outputs = parsed?.data?.outputs || {}
    const subType = outputs.sub_type || outputs.question_type || 'unknown'
    const confidence = Number(outputs.confidence || 0.6)

    return {
      subType,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.6,
      source: 'dify_classifier'
    }
  } finally {
    clearTimeout(timer)
  }
}

async function classifyExamSubType(payload, traceId, streamManager, opts = {}) {
  const mode = parseClassifierMode()
  const retryIndex = Number(opts.retryIndex || 0)
  const cached = opts.cached
  const scenario = opts.scenario || null

  if (cached && retryIndex > 0 && !shouldReclassifyOnRetry()) {
    return cached
  }

  if (mode !== 'dify') {
    return detectExamSubTypeHeuristic(payload, scenario)
  }

  try {
    streamManager.publish(traceId, 'progress', {
      trace_id: traceId,
      stage: 'subtype_classifying',
      progress: 12,
      message: 'classifying exam subtype via dify classifier'
    })
    return await classifyWithDify(payload, scenario, traceId)
  } catch (_error) {
    return detectExamSubTypeHeuristic(payload, scenario)
  }
}

module.exports = {
  classifyExamSubType
}
