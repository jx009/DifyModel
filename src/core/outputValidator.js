function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n)
}

function normalizeConfidence(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(1, n))
}

function pickConstraints(scenario, subType) {
  const cfg = scenario?.output_constraints
  if (!cfg || typeof cfg !== 'object') {
    return {
      mode: 'text_or_option',
      minEvidence: 1,
      requireEvidence: true,
      enforceSubTypeMatch: true,
      jsonRootType: null,
      jsonRequiredFields: [],
      jsonArrayMinItems: {},
      jsonFieldTypes: {}
    }
  }

  const defaults = cfg.defaults && typeof cfg.defaults === 'object' ? cfg.defaults : {}
  const subRules = cfg.sub_type_rules && typeof cfg.sub_type_rules === 'object' ? cfg.sub_type_rules : {}
  const rule = subRules[subType] && typeof subRules[subType] === 'object' ? subRules[subType] : {}

  return {
    mode: typeof rule.mode === 'string' ? rule.mode : typeof defaults.mode === 'string' ? defaults.mode : 'text_or_option',
    minEvidence: Number(rule.min_evidence ?? defaults.min_evidence ?? 1),
    requireEvidence: Boolean(rule.require_evidence ?? defaults.require_evidence ?? true),
    enforceSubTypeMatch: Boolean(rule.enforce_sub_type_match ?? defaults.enforce_sub_type_match ?? true),
    jsonRootType: typeof rule.json_root_type === 'string' ? rule.json_root_type : typeof defaults.json_root_type === 'string' ? defaults.json_root_type : null,
    jsonRequiredFields: asStringArray(rule.json_required_fields ?? defaults.json_required_fields),
    jsonArrayMinItems: rule.json_array_min_items && typeof rule.json_array_min_items === 'object'
      ? rule.json_array_min_items
      : defaults.json_array_min_items && typeof defaults.json_array_min_items === 'object'
        ? defaults.json_array_min_items
        : {},
    jsonFieldTypes: rule.json_field_types && typeof rule.json_field_types === 'object'
      ? rule.json_field_types
      : defaults.json_field_types && typeof defaults.json_field_types === 'object'
        ? defaults.json_field_types
        : {}
  }
}

function isSingleOption(answer) {
  return /^[A-Z]$/.test(answer)
}

function isMultiOption(answer) {
  return /^[A-Z]{2,}$/.test(answer)
}

function isNumber(answer) {
  return /^-?\d+(\.\d+)?%?$/.test(answer)
}

function validateAnswerByMode(answer, mode) {
  if (!answer) return false
  if (mode === 'single_option') return isSingleOption(answer)
  if (mode === 'multi_option') return isMultiOption(answer)
  if (mode === 'number_or_option') return isSingleOption(answer) || isMultiOption(answer) || isNumber(answer)
  return answer.length > 0
}

function stripJsonFence(text) {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced && fenced[1]) {
    return fenced[1].trim()
  }
  return trimmed
}

function getValueByPath(root, fieldPath) {
  if (!fieldPath) return root
  const parts = String(fieldPath)
    .split('.')
    .map((x) => x.trim())
    .filter(Boolean)

  let current = root
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !(part in current)) {
      return undefined
    }
    current = current[part]
  }
  return current
}

function matchType(value, type) {
  if (type === 'string') return typeof value === 'string'
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value)
  if (type === 'boolean') return typeof value === 'boolean'
  if (type === 'array') return Array.isArray(value)
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
  return true
}

function validateJsonAnswer(answer, constraints) {
  const raw = stripJsonFence(answer)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (_error) {
    return { ok: false, reason: 'invalid_json_answer' }
  }

  if (constraints.jsonRootType === 'object') {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: 'json_root_type_mismatch:object' }
    }
  }
  if (constraints.jsonRootType === 'array') {
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: 'json_root_type_mismatch:array' }
    }
  }

  for (const field of constraints.jsonRequiredFields) {
    if (getValueByPath(parsed, field) === undefined) {
      return { ok: false, reason: `missing_json_field:${field}` }
    }
  }

  const minItemsCfg = constraints.jsonArrayMinItems || {}
  for (const [fieldPath, rawMin] of Object.entries(minItemsCfg)) {
    const min = Number(rawMin)
    if (!Number.isFinite(min) || min < 0) continue

    const value = getValueByPath(parsed, fieldPath)
    if (!Array.isArray(value) || value.length < min) {
      return { ok: false, reason: `json_array_too_short:${fieldPath}` }
    }
  }

  const fieldTypeCfg = constraints.jsonFieldTypes || {}
  for (const [fieldPath, expectedType] of Object.entries(fieldTypeCfg)) {
    if (typeof expectedType !== 'string' || !expectedType.trim()) continue

    const value = getValueByPath(parsed, fieldPath)
    if (value === undefined) continue

    if (!matchType(value, expectedType.trim())) {
      return { ok: false, reason: `json_field_type_mismatch:${fieldPath}:${expectedType}` }
    }
  }

  return { ok: true, parsed }
}

function validateResultForScenario({ scenario, executionContext, result }) {
  const subType = executionContext?.subType || 'unknown'
  const constraints = pickConstraints(scenario, subType)

  if (!result || typeof result !== 'object') {
    return { ok: false, reason: 'empty_result' }
  }

  const out = {
    ...result,
    result: result.result && typeof result.result === 'object' ? { ...result.result } : {}
  }

  const answer = typeof out.result.answer === 'string' ? out.result.answer.trim() : ''

  if (constraints.mode === 'json') {
    const jsonCheck = validateJsonAnswer(answer, constraints)
    if (!jsonCheck.ok) {
      return { ok: false, reason: jsonCheck.reason }
    }
    out.result.answer = JSON.stringify(jsonCheck.parsed)
  } else if (!validateAnswerByMode(answer, constraints.mode)) {
    return { ok: false, reason: `invalid_answer_mode:${constraints.mode}` }
  }

  const evidence = asStringArray(out.result.evidence)
  if (constraints.requireEvidence && evidence.length < Math.max(1, Number(constraints.minEvidence || 1))) {
    return { ok: false, reason: 'insufficient_evidence' }
  }
  out.result.evidence = evidence

  const confidence = normalizeConfidence(out.result.confidence)
  if (confidence === null) {
    return { ok: false, reason: 'invalid_confidence' }
  }
  out.result.confidence = Number(confidence.toFixed(2))

  if (constraints.enforceSubTypeMatch) {
    const outputSubType = typeof out.sub_type === 'string' ? out.sub_type.trim() : ''
    if (outputSubType && outputSubType !== subType) {
      return { ok: false, reason: `sub_type_mismatch:${outputSubType}!=${subType}` }
    }
  }

  if (typeof out.sub_type !== 'string' || !out.sub_type.trim()) {
    out.sub_type = subType
  }

  out.debug = out.debug || {}
  out.debug.output_validation = {
    ok: true,
    mode: constraints.mode,
    min_evidence: constraints.minEvidence,
    require_evidence: constraints.requireEvidence,
    json_required_fields: constraints.jsonRequiredFields
  }

  if (!isFiniteNumber(out.metrics?.latency_ms)) {
    out.metrics = out.metrics || {}
    out.metrics.latency_ms = Number(out.metrics.latency_ms || 0)
  }

  return { ok: true, repairedResult: out }
}

module.exports = {
  validateResultForScenario
}
