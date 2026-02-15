function normalizeText(text) {
  return typeof text === 'string' ? text.trim().toLowerCase() : ''
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n))
}

function getScenarioSubTypeProfiles(scenario) {
  const profiles = scenario?.sub_type_profiles
  if (!profiles || typeof profiles !== 'object') return {}
  return profiles
}

function getImageOnlyDefaultSubType() {
  const v = String(process.env.EXAM_IMAGE_ONLY_DEFAULT_SUBTYPE || 'figure_reasoning').trim()
  return v || 'figure_reasoning'
}

function getImageOnlyDefaultConfidence() {
  const n = Number(process.env.EXAM_IMAGE_ONLY_CONFIDENCE || 0.62)
  if (!Number.isFinite(n)) return 0.62
  return Math.max(0.1, Math.min(0.95, n))
}

function detectByScenarioProfiles(payload, scenario) {
  const profiles = getScenarioSubTypeProfiles(scenario)
  const profileEntries = Object.entries(profiles)
  if (profileEntries.length === 0) return null

  const text = normalizeText(payload?.input?.text)
  const images = payload?.input?.images
  const hasImages = Array.isArray(images) && images.length > 0

  let best = null
  for (const [subType, profileRaw] of profileEntries) {
    const profile = profileRaw && typeof profileRaw === 'object' ? profileRaw : {}
    const hints = profile.classifier_hints && typeof profile.classifier_hints === 'object' ? profile.classifier_hints : {}
    const keywords = asStringArray(hints.keywords).map((x) => x.toLowerCase())

    let score = 0
    let hitCount = 0
    for (const kw of keywords) {
      if (text && text.includes(kw)) {
        hitCount += 1
        score += kw.length >= 4 ? 0.2 : 0.14
      }
    }

    if (hitCount > 0) {
      score += Math.min(0.2, hitCount * 0.04)
    }

    if (hints.require_images === true && !hasImages) {
      score -= 0.25
    }

    if (hints.prefer_images === true && hasImages) {
      score += 0.08
    }

    if (!text && hasImages && hints.image_only_default === true) {
      score += 0.35
    }

    if (!best || score > best.score) {
      best = { subType, score, hitCount }
    }
  }

  if (!best || best.score < 0.24) return null

  const confidence = clamp(0.58 + best.score, 0.55, 0.96)
  return {
    subType: best.subType,
    confidence: Number(confidence.toFixed(2)),
    source: 'profile_heuristic'
  }
}

function detectExamSubTypeHeuristic(payload, scenario) {
  const forced = payload?.options?.force_sub_type
  if (typeof forced === 'string' && forced.trim()) {
    return { subType: forced.trim(), confidence: 0.98, source: 'forced' }
  }

  const byProfile = detectByScenarioProfiles(payload, scenario)
  if (byProfile) {
    return byProfile
  }

  const text = normalizeText(payload?.input?.text)
  const images = payload?.input?.images
  const hasImages = Array.isArray(images) && images.length > 0
  if (!text) {
    // In `exam_qa`, images are typically required and text may be absent.
    // In that case, default to `figure_reasoning` as the least-wrong routing to avoid
    // forcing `unknown`-driven retries/cost for the common path.
    if (hasImages) {
      return { subType: getImageOnlyDefaultSubType(), confidence: getImageOnlyDefaultConfidence(), source: 'heuristic_images' }
    }
    return { subType: 'unknown', confidence: 0.35, source: 'heuristic' }
  }

  const rules = [
    { subType: 'figure_reasoning', confidence: 0.86, patterns: ['图推', '图形', '旋转', '对称', '折叠', '位置规律'] },
    { subType: 'logic', confidence: 0.82, patterns: ['逻辑', '真假', '削弱', '加强', '推理', '论证'] },
    { subType: 'language', confidence: 0.8, patterns: ['言语', '主旨', '填空', '病句', '语句排序', '阅读理解'] },
    { subType: 'data_analysis', confidence: 0.84, patterns: ['资料分析', '同比', '环比', '增长率', '百分点', '数据表'] },
    { subType: 'common_knowledge', confidence: 0.78, patterns: ['常识', '法律', '历史', '地理', '科技', '时政'] }
  ]

  for (const rule of rules) {
    if (rule.patterns.some((pattern) => text.includes(pattern))) {
      return { subType: rule.subType, confidence: rule.confidence, source: 'heuristic' }
    }
  }

  return { subType: 'unknown', confidence: 0.45, source: 'heuristic' }
}

function resolveWorkflowId(scenario, subType) {
  const profile = resolveSubTypeProfile(scenario, subType)
  if (profile && typeof profile.workflow_id === 'string' && profile.workflow_id.trim()) {
    return profile.workflow_id.trim()
  }

  const binding = scenario?.workflow_binding || {}
  const main = binding.workflow_id || null
  const routes = binding.sub_type_routes || {}
  if (subType && routes[subType]) {
    return routes[subType]
  }
  return main
}

function resolveSubTypeProfile(scenario, subType) {
  if (!subType) return null
  const profiles = getScenarioSubTypeProfiles(scenario)
  const profile = profiles[subType]
  if (!profile || typeof profile !== 'object') return null
  return profile
}

function buildSubTypePromptPlan(scenario, subType) {
  const profile = resolveSubTypeProfile(scenario, subType)
  if (!profile) {
    return {
      sub_type: subType || 'unknown',
      display_name: subType || 'unknown',
      solving_steps: [],
      prompt_focus: [],
      answer_constraints: []
    }
  }

  const guidance = profile.workflow_guidance && typeof profile.workflow_guidance === 'object' ? profile.workflow_guidance : {}
  const displayName = typeof profile.display_name === 'string' && profile.display_name.trim() ? profile.display_name.trim() : subType

  return {
    sub_type: subType,
    display_name: displayName,
    solving_steps: asStringArray(guidance.solving_steps),
    prompt_focus: asStringArray(guidance.prompt_focus),
    answer_constraints: asStringArray(guidance.answer_constraints)
  }
}

function resolveKnowledgePlan(scenario, subType, mappingOverrides) {
  const policy = scenario?.knowledge_policy || {}
  const mapping = mappingOverrides && typeof mappingOverrides === 'object' ? mappingOverrides : null

  const topK = Number(mapping?.top_k ?? policy.top_k ?? 5)
  const rerank = mapping?.rerank ?? policy.rerank ?? false
  const maxContextChars = Number(mapping?.max_context_chars ?? policy.max_context_chars ?? 12000)

  if (!policy.enabled || policy.mode === 'off') {
    return {
      enabled: false,
      mode: policy.mode || 'off',
      kb_ids: [],
      top_k: topK,
      rerank: Boolean(rerank),
      max_context_chars: Number.isFinite(maxContextChars) ? maxContextChars : 12000
    }
  }

  if (policy.mode === 'always') {
    return {
      enabled: true,
      mode: 'always',
      kb_ids: Array.isArray(policy.default_kb_ids) ? policy.default_kb_ids : [],
      top_k: topK,
      rerank: Boolean(rerank),
      max_context_chars: Number.isFinite(maxContextChars) ? maxContextChars : 12000
    }
  }

  const subTypeMap =
    mapping && mapping.sub_type_kb_map && typeof mapping.sub_type_kb_map === 'object'
      ? mapping.sub_type_kb_map
      : policy.sub_type_kb_map || {}
  const selected = subTypeMap[subType]
  if (Array.isArray(selected) && selected.length > 0) {
    return {
      enabled: true,
      mode: 'conditional',
      kb_ids: selected,
      top_k: topK,
      rerank: Boolean(rerank),
      max_context_chars: Number.isFinite(maxContextChars) ? maxContextChars : 12000
    }
  }

  const defaultKbIds = mapping && Array.isArray(mapping.default_kb_ids) ? mapping.default_kb_ids : Array.isArray(policy.default_kb_ids) ? policy.default_kb_ids : []
  return {
    enabled: true,
    mode: 'conditional',
    kb_ids: defaultKbIds,
    top_k: topK,
    rerank: Boolean(rerank),
    max_context_chars: Number.isFinite(maxContextChars) ? maxContextChars : 12000
  }
}

function buildPlannedKbHits(knowledgePlan) {
  if (!knowledgePlan?.enabled) return []
  const kbItems = Array.isArray(knowledgePlan.kb_items) ? knowledgePlan.kb_items : []
  if (kbItems.length > 0) {
    return kbItems.map((item, idx) => ({
      kb_id: item.kb_id,
      kb_version: item.kb_version || 'unknown',
      chunk_id: `planned_${idx + 1}`,
      score: 0,
      source: 'knowledge_plan'
    }))
  }

  if (!Array.isArray(knowledgePlan.kb_ids) || knowledgePlan.kb_ids.length === 0) return []

  return knowledgePlan.kb_ids.map((kbId, idx) => ({
    kb_id: kbId,
    kb_version: 'unknown',
    chunk_id: `planned_${idx + 1}`,
    score: 0,
    source: 'knowledge_plan'
  }))
}

module.exports = {
  detectExamSubTypeHeuristic,
  resolveWorkflowId,
  resolveSubTypeProfile,
  buildSubTypePromptPlan,
  resolveKnowledgePlan,
  buildPlannedKbHits
}
