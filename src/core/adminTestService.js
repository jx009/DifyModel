const { detectExamSubTypeHeuristic, resolveWorkflowId, buildSubTypePromptPlan, resolveKnowledgePlan } = require('./examRouter')
const { buildDifyImageFiles } = require('./difyFiles')
const { getDifyConfig, resolveApiKey } = require('./difyConnector')
const { derivePolicy } = require('./policyEngine')

function makeError(code, message, details) {
  const error = new Error(message)
  error.code = code
  error.details = details || {}
  return error
}

function pickFileId(payload) {
  return (
    payload?.id ||
    payload?.file_id ||
    payload?.upload_file_id ||
    payload?.data?.id ||
    payload?.data?.file_id ||
    payload?.data?.upload_file_id ||
    null
  )
}

function parseBase64Image(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw makeError('INVALID_INPUT', 'base64 is required')
  }
  const trimmed = input.trim()
  const match = trimmed.match(/^data:([^;]+);base64,(.+)$/i)
  if (match) {
    const contentType = match[1]
    const body = match[2]
    return { contentType, base64: body }
  }
  return {
    contentType: 'application/octet-stream',
    base64: trimmed
  }
}

async function uploadImageToDify({ base64, filename, contentType, user }) {
  const cfg = getDifyConfig()
  if (!cfg.enabled || !cfg.baseUrl) {
    throw makeError('UPSTREAM_ERROR', 'dify is not configured')
  }

  const apiKey = resolveApiKey(cfg, null)
  if (!apiKey) {
    throw makeError('WORKFLOW_NOT_FOUND', 'dify api key is not configured')
  }

  const parsed = parseBase64Image(base64)
  const effectiveContentType = typeof contentType === 'string' && contentType.trim() ? contentType.trim() : parsed.contentType
  const effectiveFilename = typeof filename === 'string' && filename.trim() ? filename.trim() : `upload_${Date.now()}.png`
  const buffer = Buffer.from(parsed.base64, 'base64')
  if (!buffer.length) {
    throw makeError('INVALID_INPUT', 'base64 image is empty')
  }

  const maxBytes = Number(process.env.ADMIN_UPLOAD_MAX_BYTES || 10 * 1024 * 1024)
  if (buffer.length > maxBytes) {
    throw makeError('INVALID_INPUT', `image too large (max ${maxBytes} bytes)`)
  }

  const form = new FormData()
  form.append('file', new Blob([buffer], { type: effectiveContentType }), effectiveFilename)
  form.append('user', user || `admin-upload-${Date.now()}`)

  const controller = new AbortController()
  const timeoutMs = Number(process.env.ADMIN_DIFY_TEST_TIMEOUT_MS || cfg.timeoutMs || 15000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`${cfg.baseUrl}/v1/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`
      },
      body: form,
      signal: controller.signal
    })

    const raw = await response.text()
    let parsedResponse = {}
    try {
      parsedResponse = raw ? JSON.parse(raw) : {}
    } catch (_error) {
      throw makeError('UPSTREAM_ERROR', 'dify file upload returned non-json response', {
        status: response.status,
        body_preview: raw.slice(0, 400)
      })
    }

    if (!response.ok) {
      throw makeError('UPSTREAM_ERROR', `dify file upload failed: HTTP ${response.status}`, {
        status: response.status,
        response: parsedResponse
      })
    }

    const fileId = pickFileId(parsedResponse)
    if (!fileId) {
      throw makeError('UPSTREAM_ERROR', 'dify file upload succeeded but file id is missing', {
        response: parsedResponse
      })
    }

    return {
      file_id: fileId,
      file_name: effectiveFilename,
      content_type: effectiveContentType,
      bytes: buffer.length,
      raw: parsedResponse
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw makeError('UPSTREAM_TIMEOUT', 'dify file upload timeout', { timeout_ms: timeoutMs })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

function buildFilesFromPayload(input) {
  const files = buildDifyImageFiles(input || {})
  const uploadFileIds = Array.isArray(input?.upload_file_ids) ? input.upload_file_ids : []
  for (const uploadFileId of uploadFileIds) {
    if (typeof uploadFileId !== 'string' || !uploadFileId.trim()) continue
    files.push({
      type: 'image',
      transfer_method: 'local_file',
      upload_file_id: uploadFileId.trim()
    })
  }
  return files
}

async function runWorkflowTest({
  scenario,
  payload,
  traceId,
  tenantId,
  knowledgeManager,
  kbMappingStore,
  adminConfig
}) {
  const cfg = getDifyConfig()
  if (!cfg.enabled || !cfg.baseUrl) {
    throw makeError('UPSTREAM_ERROR', 'dify is not configured')
  }

  const input = payload.input && typeof payload.input === 'object' ? payload.input : {}
  const options = payload.options && typeof payload.options === 'object' ? payload.options : {}
  const hintedSubType = typeof payload.sub_type === 'string' && payload.sub_type.trim() ? payload.sub_type.trim() : null
  const classifier = hintedSubType ? { subType: hintedSubType, confidence: 0.99, source: 'forced' } : detectExamSubTypeHeuristic({ input }, scenario)
  const subType = classifier.subType || 'unknown'
  const workflowId =
    (typeof payload.workflow_id === 'string' && payload.workflow_id.trim() ? payload.workflow_id.trim() : null) ||
    resolveWorkflowId(scenario, subType)

  const apiKey = resolveApiKey(cfg, workflowId)
  if (!apiKey) {
    throw makeError('WORKFLOW_NOT_FOUND', `api key for workflow ${workflowId || 'default'} is not configured`)
  }

  const appEnv = process.env.APP_ENV || 'dev'
  const effectiveTenant = tenantId || payload?.context?.tenant_id || null
  const kbMapping = kbMappingStore.getEffectiveMapping(scenario.scenario_id, appEnv, effectiveTenant)
  const knowledgeBasePlan = resolveKnowledgePlan(
    scenario,
    subType,
    kbMapping && kbMapping.found
      ? {
          default_kb_ids: kbMapping.default_kb_ids,
          sub_type_kb_map: kbMapping.sub_type_kb_map,
          top_k: kbMapping.top_k,
          rerank: kbMapping.rerank,
          max_context_chars: kbMapping.max_context_chars
        }
      : null
  )
  const knowledge = knowledgeManager.enrichPlan(knowledgeBasePlan)

  const promptPlan = buildSubTypePromptPlan(scenario, subType)
  const derivedPolicy = derivePolicy({ options }, scenario)
  const effectivePolicy = payload.policy && typeof payload.policy === 'object' ? payload.policy : derivedPolicy
  const overridePrompt = adminConfig?.workflow_prompts?.[workflowId]?.content || null
  const files = buildFilesFromPayload(input)
  const retryIndex = Number.isFinite(Number(payload.retry_index)) ? Number(payload.retry_index) : 0
  const user = `admin-test:${tenantId || 'anonymous'}:${traceId}`
  const body = {
    inputs: {
      scenario_id: scenario.scenario_id,
      sub_type: subType,
      sub_type_profile: scenario?.sub_type_profiles?.[subType] || {},
      prompt_plan: promptPlan,
      workflow_hint: workflowId || null,
      prompt_override: overridePrompt,
      kb_plan: knowledge,
      input,
      images: files,
      context: payload.context || {},
      options,
      policy: effectivePolicy,
      trace_id: traceId,
      retry_index: retryIndex
    },
    response_mode: 'blocking',
    user,
    files
  }

  const controller = new AbortController()
  const timeoutMs = Number(process.env.ADMIN_DIFY_TEST_TIMEOUT_MS || cfg.timeoutMs || 15000)
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const response = await fetch(`${cfg.baseUrl}/v1/workflows/run`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    const rawText = await response.text()
    let responseJson = {}
    try {
      responseJson = rawText ? JSON.parse(rawText) : {}
    } catch (_error) {
      throw makeError('UPSTREAM_ERROR', 'dify workflow returned non-json response', {
        status: response.status,
        body_preview: rawText.slice(0, 400)
      })
    }

    if (!response.ok) {
      throw makeError('UPSTREAM_ERROR', `dify workflow failed: HTTP ${response.status}`, {
        status: response.status,
        response: responseJson
      })
    }

    const outputs = responseJson?.data?.outputs || {}
    const answer = outputs.answer || outputs.result || outputs.output || null
    const evidence = Array.isArray(outputs.evidence) ? outputs.evidence : outputs.reason ? [String(outputs.reason)] : []
    const confidence = Number(outputs.confidence ?? responseJson?.data?.confidence ?? 0)

    return {
      trace_id: traceId,
      scenario_id: scenario.scenario_id,
      workflow_id: workflowId,
      sub_type: subType,
      classifier,
      prompt_plan: promptPlan,
      prompt_override_applied: Boolean(overridePrompt),
      metrics: {
        latency_ms: Date.now() - startedAt
      },
      result: {
        answer,
        evidence,
        confidence: Number.isFinite(confidence) ? confidence : null
      },
      raw: responseJson
    }
  } catch (error) {
    if (error && error.name === 'AbortError') {
      throw makeError('UPSTREAM_TIMEOUT', 'dify workflow test timeout', { timeout_ms: timeoutMs })
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

module.exports = {
  uploadImageToDify,
  runWorkflowTest
}
