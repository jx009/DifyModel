const { runMockPipeline } = require('./inferenceRunner')
const { callDifyWorkflow, getDifyConfig } = require('./difyConnector')
const { classifyExamSubType } = require('./subTypeClassifier')
const { resolveWorkflowId, resolveSubTypeProfile, buildSubTypePromptPlan, resolveKnowledgePlan } = require('./examRouter')
const { logRetrievalPlan } = require('./retrievalLogger')
const { validateResultForScenario } = require('./outputValidator')
const { getRuntimeResources } = require('./runtimeResources')

const MIN_REMAINING_MS_TO_RETRY = 900
const { knowledgeManager, kbMappingStore } = getRuntimeResources()

function getSubTypeQualityOverride(scenario, subType) {
  const map = scenario?.quality_policy?.sub_type_overrides || {}
  return map[subType] || null
}

function getRetryPolicy(scenario, policy, subType, classifierConfidence) {
  const override = getSubTypeQualityOverride(scenario, subType)

  let threshold = Number(policy.confidence_threshold || 0.7)
  let maxRetries = Number(policy.max_retries || 0)
  let retryMode = 'same_workflow'
  let retryOnValidationFail = Boolean(scenario?.quality_policy?.validation_retry_on_fail ?? true)

  if (override) {
    if (override.confidence_threshold !== undefined) {
      threshold = Number(override.confidence_threshold)
    }
    if (override.max_retries !== undefined) {
      maxRetries = Number(override.max_retries)
    }
    if (typeof override.retry_mode === 'string' && override.retry_mode.trim()) {
      retryMode = override.retry_mode.trim()
    }
    if (override.retry_on_validation_fail !== undefined) {
      retryOnValidationFail = Boolean(override.retry_on_validation_fail)
    }
  }

  // If subtype classification is low confidence, allow at most one extra retry
  // but do not force extra cost when we already have a reasonable subtype.
  if (subType === 'unknown' && Number(classifierConfidence || 0) < 0.6) {
    maxRetries = Math.max(maxRetries, 1)
    threshold = Math.max(threshold, 0.75)
  }

  return {
    confidenceThreshold: Math.max(0.1, Math.min(0.99, threshold)),
    maxRetries: Math.max(0, maxRetries),
    retryMode: retryMode === 'fallback_workflow' ? 'fallback_workflow' : 'same_workflow',
    retryOnValidationFail
  }
}

async function buildExecutionContext(payload, scenario, retryIndex, traceId, streamManager, cachedClassification, tenantId) {
  const classified = await classifyExamSubType(payload, traceId, streamManager, {
    retryIndex,
    cached: cachedClassification,
    scenario
  })
  const workflowId = resolveWorkflowId(scenario, classified.subType)
  const subTypeProfile = resolveSubTypeProfile(scenario, classified.subType)
  const promptPlan = buildSubTypePromptPlan(scenario, classified.subType)
  const appEnv = process.env.APP_ENV || 'dev'
  const effectiveTenant = tenantId || payload?.context?.tenant_id || null
  const kbMapping = kbMappingStore.getEffectiveMapping(scenario.scenario_id, appEnv, effectiveTenant)
  const knowledgeBasePlan = resolveKnowledgePlan(
    scenario,
    classified.subType,
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

  return {
    subType: classified.subType,
    classifier: {
      source: classified.source,
      confidence: Number(classified.confidence || 0.5)
    },
    workflowId,
    subTypeProfile,
    promptPlan,
    knowledge,
    kb_mapping: kbMapping,
    kb_registry: knowledgeManager.getRegistryInfo(),
    retryIndex: Number(retryIndex || 0)
  }
}

function shouldRetry(result, retryPolicy, retryIndex) {
  if (!result || !result.result) return false
  if (retryIndex >= Number(retryPolicy.maxRetries || 0)) return false

  const confidence = Number(result.result.confidence || 0)
  return confidence < Number(retryPolicy.confidenceThreshold || 0.7)
}

function asStringSet(values) {
  const out = new Set()
  if (!Array.isArray(values)) return out
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) out.add(v.trim())
  }
  return out
}

function computeKbPlanActualDiff(knowledge, result) {
  const plannedKbIds = Array.isArray(knowledge?.kb_ids) ? knowledge.kb_ids : []
  const actualHits = Array.isArray(result?.debug?.kb_hits) ? result.debug.kb_hits : []
  const actualKbIds = actualHits.map((x) => x && typeof x.kb_id === 'string' ? x.kb_id : '').filter(Boolean)

  const plannedSet = asStringSet(plannedKbIds)
  const actualSet = asStringSet(actualKbIds)

  const plannedButNotHit = []
  for (const id of plannedSet) {
    if (!actualSet.has(id)) plannedButNotHit.push(id)
  }

  const hitButNotPlanned = []
  for (const id of actualSet) {
    if (!plannedSet.has(id)) hitButNotPlanned.push(id)
  }

  const kbHitsSource = result?.debug?.kb_hits_source || null
  const actualIsPlannedFallback = kbHitsSource === 'planned_fallback'
  const match = actualIsPlannedFallback ? null : plannedButNotHit.length === 0 && hitButNotPlanned.length === 0

  return {
    planned_kb_ids: Array.from(plannedSet),
    actual_kb_ids: Array.from(actualSet),
    kb_hits_source: kbHitsSource,
    actual_is_planned_fallback: actualIsPlannedFallback,
    planned_but_not_hit: plannedButNotHit,
    hit_but_not_planned: hitButNotPlanned,
    match
  }
}

async function executeOnePass({ provider, traceId, payload, scenario, policy, streamManager, tenantId, executionContext }) {
  if (provider !== 'dify') {
    return runMockPipeline(traceId, scenario, policy, streamManager, {
      subType: executionContext.subType,
      workflowId: executionContext.workflowId,
      subTypeProfile: executionContext.subTypeProfile || null,
      promptPlan: executionContext.promptPlan || null,
      knowledge: executionContext.knowledge,
      kbMapping: executionContext.kb_mapping || null,
      kbRegistry: executionContext.kb_registry || null,
      classifier: executionContext.classifier,
      retryIndex: executionContext.retryIndex,
      providerTag: executionContext.retryIndex > 0 ? 'provider:mock-retry' : 'router:mock'
    })
  }

  return callDifyWorkflow({
    payload,
    scenario,
    policy,
    traceId,
    tenantId,
    streamManager,
    context: executionContext,
    timeoutMsOverride: executionContext.timeoutMsOverride
  })
}

async function runInferencePipeline({ traceId, payload, scenario, policy, streamManager, tenantId }) {
  const provider = scenario.workflow_binding && scenario.workflow_binding.provider
  const difyConfig = getDifyConfig()
  const disableUpstreamTimeout = String(process.env.DIFY_DISABLE_TIMEOUT || '').toLowerCase() === 'true'
  const startedAt = Date.now()
  const deadline = startedAt + Number(policy.total_latency_budget_ms || 8000)
  const fallbackWorkflowId = scenario?.workflow_binding?.fallback_workflow_id || null

  let retryIndex = 0
  let bestResult = null
  let cachedClassification = null
  let fallbackWorkflowTried = false
  let retryWorkflowIdOverride = null

  while (true) {
    const remainingBudgetMs = deadline - Date.now()
    if (bestResult && remainingBudgetMs < MIN_REMAINING_MS_TO_RETRY) {
      streamManager.publish(traceId, 'progress', {
        trace_id: traceId,
        stage: 'budget_exhausted',
        progress: 92,
        message: `latency budget nearly exhausted, returning best effort (remaining_ms=${Math.max(0, remainingBudgetMs)})`
      })
      return bestResult
    }

    const executionContext = await buildExecutionContext(payload, scenario, retryIndex, traceId, streamManager, cachedClassification, tenantId)
    if (retryWorkflowIdOverride) {
      executionContext.workflowId = retryWorkflowIdOverride
    }
    if (!cachedClassification) {
      cachedClassification = {
        subType: executionContext.subType,
        confidence: executionContext.classifier.confidence,
        source: executionContext.classifier.source
      }
    }
    const retryPolicy = getRetryPolicy(scenario, policy, executionContext.subType, executionContext.classifier.confidence)

    streamManager.publish(traceId, 'progress', {
      trace_id: traceId,
      stage: retryIndex > 0 ? 'quality_retry' : 'routing',
      progress: retryIndex > 0 ? 18 + retryIndex * 3 : 15,
      message: `provider=${provider || 'mock'}, sub_type=${executionContext.subType}, workflow=${executionContext.workflowId || 'default'}, pass=${retryIndex + 1}`
    })

    try {
      // Log retrieval plan for observability (even if retrieval is performed outside this service).
      const requestedKbIds = executionContext.knowledge?.requested_kb_ids || executionContext.knowledge?.kb_ids || []
      if (executionContext.knowledge && (executionContext.knowledge.enabled || (Array.isArray(requestedKbIds) && requestedKbIds.length > 0))) {
        logRetrievalPlan({
          trace_id: traceId,
          scenario_id: scenario.scenario_id,
          scenario_version: scenario.version || null,
          env: process.env.APP_ENV || 'dev',
          tenant_id: tenantId || payload?.context?.tenant_id || null,
          sub_type: executionContext.subType,
          retry_index: executionContext.retryIndex,
          workflow_id: executionContext.workflowId || null,
          sub_type_profile: executionContext.subTypeProfile || null,
          prompt_plan: executionContext.promptPlan || null,
          retry_mode: retryPolicy.retryMode,
          provider: provider || 'mock',
          mode: executionContext.knowledge.mode,
          kb_items: executionContext.knowledge.kb_items || [],
          requested_kb_ids: requestedKbIds,
          dropped_kb_ids: executionContext.knowledge.dropped_kb_ids || [],
          top_k: executionContext.knowledge?.top_k || null,
          rerank: executionContext.knowledge?.rerank === undefined ? null : Boolean(executionContext.knowledge.rerank),
          max_context_chars: executionContext.knowledge?.max_context_chars || null,
          kb_registry: executionContext.kb_registry || null,
          kb_mapping: executionContext.kb_mapping || null
        })
      }

      // Apply remaining budget to upstream timeout to avoid exceeding total latency budget.
      if (disableUpstreamTimeout) {
        executionContext.timeoutMsOverride = null
      } else {
        const remainingForUpstream = Math.max(800, deadline - Date.now())
        executionContext.timeoutMsOverride = Math.min(difyConfig.timeoutMs, remainingForUpstream)
      }

      let result = await executeOnePass({
        provider,
        traceId,
        payload,
        scenario,
        policy,
        streamManager,
        tenantId,
        executionContext
      })

      const validation = validateResultForScenario({
        scenario,
        executionContext,
        result
      })
      if (!validation.ok) {
        streamManager.publish(traceId, 'progress', {
          trace_id: traceId,
          stage: 'output_validation_failed',
          progress: 88,
          message: `validation failed: ${validation.reason}`
        })

        if (policy.strict_output_validation && retryPolicy.retryOnValidationFail && retryIndex < retryPolicy.maxRetries) {
          retryIndex += 1
          continue
        }
      } else if (validation.repairedResult) {
        result = validation.repairedResult
      }

      if (!bestResult || Number(result.result?.confidence || 0) >= Number(bestResult.result?.confidence || 0)) {
        bestResult = result
      }

      const kbDiff = computeKbPlanActualDiff(executionContext.knowledge, result)
      logRetrievalPlan({
        trace_id: traceId,
        scenario_id: scenario.scenario_id,
        scenario_version: scenario.version || null,
        env: process.env.APP_ENV || 'dev',
        tenant_id: tenantId || payload?.context?.tenant_id || null,
        sub_type: executionContext.subType,
        retry_index: executionContext.retryIndex,
        workflow_id: executionContext.workflowId || null,
        provider: provider || 'mock',
        event: 'retrieval_outcome',
        ...kbDiff
      })

      result.debug = result.debug || {}
      result.debug.kb_plan_actual_diff = kbDiff

      const remainingAfter = deadline - Date.now()
      if (!shouldRetry(result, retryPolicy, retryIndex) || remainingAfter < MIN_REMAINING_MS_TO_RETRY) {
        return bestResult
      }

      if (retryPolicy.retryMode === 'fallback_workflow' && fallbackWorkflowId && executionContext.workflowId !== fallbackWorkflowId) {
        retryWorkflowIdOverride = fallbackWorkflowId
        fallbackWorkflowTried = true
        streamManager.publish(traceId, 'progress', {
          trace_id: traceId,
          stage: 'quality_retry_fallback_workflow',
          progress: 23,
          message: `low confidence, retry with fallback workflow: ${fallbackWorkflowId}`
        })
      } else {
        retryWorkflowIdOverride = null
      }
      retryIndex += 1
    } catch (error) {
      const message = error && error.message ? error.message : String(error)

      if (provider !== 'dify') {
        throw error
      }

      if (!difyConfig.fallbackToMock) {
        throw error
      }

      // Prefer fallback workflow (if configured) before falling back to mock.
      if (provider === 'dify' && fallbackWorkflowId && !fallbackWorkflowTried) {
        fallbackWorkflowTried = true
        streamManager.publish(traceId, 'progress', {
          trace_id: traceId,
          stage: 'fallback_workflow',
          progress: 28,
          message: `primary workflow failed, trying fallback workflow: ${fallbackWorkflowId}`
        })

        try {
          const executionContextForFallbackWorkflow = {
            ...(await buildExecutionContext(payload, scenario, retryIndex, traceId, streamManager, cachedClassification, tenantId)),
            workflowId: fallbackWorkflowId,
            retryIndex
          }
          executionContextForFallbackWorkflow.timeoutMsOverride = disableUpstreamTimeout ? null : Math.min(difyConfig.timeoutMs, Math.max(800, deadline - Date.now()))
          const fallbackWorkflowResult = await executeOnePass({
            provider,
            traceId,
            payload,
            scenario,
            policy,
            streamManager,
            tenantId,
            executionContext: executionContextForFallbackWorkflow
          })
          return fallbackWorkflowResult
        } catch (_fallbackError) {
          // Continue to mock fallback below.
        }
      }

      streamManager.publish(traceId, 'progress', {
        trace_id: traceId,
        stage: 'fallback_mock',
        progress: 25,
        message: `dify unavailable, fallback to mock: ${message}`
      })

      const executionContextForFallback = await buildExecutionContext(payload, scenario, retryIndex, traceId, streamManager, cachedClassification, tenantId)
      const fallbackResult = await runMockPipeline(traceId, scenario, policy, streamManager, {
        subType: executionContextForFallback.subType,
        workflowId: executionContextForFallback.workflowId,
        subTypeProfile: executionContextForFallback.subTypeProfile || null,
        promptPlan: executionContextForFallback.promptPlan || null,
        knowledge: executionContextForFallback.knowledge,
        kbMapping: executionContextForFallback.kb_mapping || null,
        kbRegistry: executionContextForFallback.kb_registry || null,
        classifier: executionContextForFallback.classifier,
        retryIndex,
        providerTag: 'provider:mock-fallback'
      })
      fallbackResult.debug = fallbackResult.debug || {}
      fallbackResult.debug.fallback_reason = message
      return fallbackResult
    }
  }
}

module.exports = {
  runInferencePipeline
}
