function resolveQualityTier(options, scenario) {
  const requested = options && options.quality_tier
  if (requested && ['fast', 'balanced', 'strict'].includes(requested)) {
    return requested
  }
  if (scenario.quality_policy && scenario.quality_policy.quality_tiers && scenario.quality_policy.quality_tiers.balanced) {
    return 'balanced'
  }
  return 'fast'
}

function derivePolicy(payload, scenario) {
  const options = payload.options || {}
  const qualityTier = resolveQualityTier(options, scenario)
  const qualityTiers = (scenario.quality_policy && scenario.quality_policy.quality_tiers) || {}
  const selectedQuality = qualityTiers[qualityTier] || {}

  const latencyFromRequest = Number(options.latency_budget_ms || 0)
  const latencyFromScenario = Number((scenario.latency_budget && scenario.latency_budget.total_ms) || 8000)
  const totalLatencyBudgetMs = latencyFromRequest > 0 ? Math.min(latencyFromRequest, latencyFromScenario) : latencyFromScenario

  return {
    quality_tier: qualityTier,
    confidence_threshold: Number(selectedQuality.confidence_threshold || scenario.quality_policy?.confidence_threshold || 0.7),
    max_retries: Number(selectedQuality.max_retries ?? scenario.quality_policy?.max_retries ?? 0),
    strict_output_validation: Boolean(scenario.quality_policy?.strict_output_validation),
    total_latency_budget_ms: totalLatencyBudgetMs,
    stage_budget_ms: (scenario.latency_budget && scenario.latency_budget.stage_budget_ms) || {},
    timeout_strategy: (scenario.latency_budget && scenario.latency_budget.on_timeout) || 'return_best_effort'
  }
}

module.exports = {
  derivePolicy
}
