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
    return { mode: 'text_or_option', minEvidence: 1, requireEvidence: true }
  }

  const defaults = cfg.defaults && typeof cfg.defaults === 'object' ? cfg.defaults : {}
  const subRules = cfg.sub_type_rules && typeof cfg.sub_type_rules === 'object' ? cfg.sub_type_rules : {}
  const rule = subRules[subType] && typeof subRules[subType] === 'object' ? subRules[subType] : {}

  return {
    mode: typeof rule.mode === 'string' ? rule.mode : typeof defaults.mode === 'string' ? defaults.mode : 'text_or_option',
    minEvidence: Number(rule.min_evidence ?? defaults.min_evidence ?? 1),
    requireEvidence: Boolean(rule.require_evidence ?? defaults.require_evidence ?? true),
    enforceSubTypeMatch: Boolean(rule.enforce_sub_type_match ?? defaults.enforce_sub_type_match ?? true)
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
  if (!validateAnswerByMode(answer, constraints.mode)) {
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
    require_evidence: constraints.requireEvidence
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
