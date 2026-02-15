const { buildPlannedKbHits } = require('./examRouter')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function buildMockResult(traceId, scenarioId, policy, context = {}) {
  const confidenceBase = context.subType === 'unknown' ? policy.confidence_threshold - 0.04 : policy.confidence_threshold + 0.05
  const confidence = Number(Math.max(0.1, Math.min(0.99, confidenceBase)).toFixed(2))

  return {
    trace_id: traceId,
    scenario_id: scenarioId,
    sub_type: context.subType || 'logic',
    status: 'completed',
    result: {
      answer: 'B',
      evidence: ['mock evidence from phase-2 skeleton'],
      confidence
    },
    metrics: {
      latency_ms: 0,
      token_in: 0,
      token_out: 0,
      cost: 0
    },
    debug: {
      model_path: [context.providerTag || 'router:mock', 'solver:mock'],
      kb_hits: buildPlannedKbHits(context.knowledge),
      route: {
        sub_type: context.subType || 'logic',
        workflow_id: context.workflowId || null,
        sub_type_profile: context.subTypeProfile || null,
        prompt_plan: context.promptPlan || null,
        knowledge: context.knowledge || null,
        kb_registry: context.kbRegistry || null,
        kb_mapping: context.kbMapping || null,
        retry_index: Number(context.retryIndex || 0),
        classifier: context.classifier || null
      }
    }
  }
}

async function runMockPipeline(traceId, scenario, policy, streamManager, context = {}) {
  const started = Date.now()
  const stages = [
    { name: 'routing', progress: 20 },
    { name: 'retrieval', progress: 45 },
    { name: 'reasoning', progress: 75 },
    { name: 'postprocess', progress: 95 }
  ]

  streamManager.publish(traceId, 'progress', {
    trace_id: traceId,
    stage: 'initializing',
    progress: 5,
    message: 'pipeline started'
  })

  for (const stage of stages) {
    await sleep(120)
    streamManager.publish(traceId, 'progress', {
      trace_id: traceId,
      stage: stage.name,
      progress: stage.progress,
      message: `${stage.name} in progress`
    })
  }

  const payload = buildMockResult(traceId, scenario.scenario_id, policy, context)
  payload.metrics.latency_ms = Date.now() - started

  streamManager.publish(traceId, 'completed', {
    trace_id: traceId,
    result: payload
  })

  return payload
}

module.exports = {
  runMockPipeline
}
