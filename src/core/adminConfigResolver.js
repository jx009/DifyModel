const { ScenarioRegistry } = require('../config/scenarioRegistry')
const { AdminConfigStore } = require('./adminConfigStore')

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(base, override) {
  if (!isObject(base)) {
    return isObject(override) ? { ...override } : base
  }
  if (!isObject(override)) {
    return { ...base }
  }

  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (isObject(value) && isObject(out[key])) {
      out[key] = deepMerge(out[key], value)
      continue
    }
    out[key] = value
  }
  return out
}

function parseEnvWorkflowApiKeyMap() {
  const raw = process.env.DIFY_API_KEYS_BY_WORKFLOW_ID || '{}'
  try {
    const parsed = JSON.parse(raw)
    if (!isObject(parsed)) return {}
    const out = {}
    for (const [workflowId, key] of Object.entries(parsed)) {
      if (typeof workflowId !== 'string' || !workflowId.trim()) continue
      if (typeof key !== 'string' || !key.trim()) continue
      out[workflowId.trim()] = key.trim()
    }
    return out
  } catch (_error) {
    return {}
  }
}

function maskSecret(secret) {
  if (typeof secret !== 'string' || !secret) return null
  if (secret.length <= 8) return '***'
  return `${secret.slice(0, 2)}***${secret.slice(-4)}`
}

function mergeSubTypeProfiles(baseProfiles, overrideProfiles) {
  const base = isObject(baseProfiles) ? baseProfiles : {}
  const overrides = isObject(overrideProfiles) ? overrideProfiles : {}
  const merged = { ...base }

  for (const [subType, overrideProfile] of Object.entries(overrides)) {
    if (!isObject(overrideProfile)) continue
    const current = isObject(merged[subType]) ? merged[subType] : {}
    merged[subType] = deepMerge(current, overrideProfile)
  }

  return merged
}

function applyRouteOverrides(workflowBinding, routesOverride) {
  const binding = isObject(workflowBinding) ? { ...workflowBinding } : {}
  const routes = isObject(binding.sub_type_routes) ? { ...binding.sub_type_routes } : {}
  const overrideRoutes = isObject(routesOverride?.sub_type_routes) ? routesOverride.sub_type_routes : {}

  for (const [subType, workflowId] of Object.entries(overrideRoutes)) {
    if (typeof subType !== 'string' || !subType.trim()) continue
    if (typeof workflowId !== 'string' || !workflowId.trim()) continue
    routes[subType.trim()] = workflowId.trim()
  }

  if (typeof routesOverride?.main_workflow_id === 'string' && routesOverride.main_workflow_id.trim()) {
    binding.workflow_id = routesOverride.main_workflow_id.trim()
  }

  if (typeof routesOverride?.fallback_workflow_id === 'string' && routesOverride.fallback_workflow_id.trim()) {
    binding.fallback_workflow_id = routesOverride.fallback_workflow_id.trim()
  }

  binding.sub_type_routes = routes
  return binding
}

function resolveScenarioWithAdminOverrides(scenario, adminConfig) {
  if (!isObject(scenario)) return null
  const cfg = isObject(adminConfig) ? adminConfig : {}

  const merged = {
    ...scenario,
    workflow_binding: applyRouteOverrides(scenario.workflow_binding, cfg.routes),
    sub_type_profiles: mergeSubTypeProfiles(scenario.sub_type_profiles, cfg.sub_type_profiles)
  }

  return merged
}

function getWorkflowKeyView(adminConfig) {
  const envMap = parseEnvWorkflowApiKeyMap()
  const overrideMap = isObject(adminConfig?.workflow_keys) ? adminConfig.workflow_keys : {}
  const workflowIds = new Set([...Object.keys(envMap), ...Object.keys(overrideMap)])
  const out = {}

  for (const workflowId of workflowIds) {
    const override = isObject(overrideMap[workflowId]) ? overrideMap[workflowId] : null
    const envKey = envMap[workflowId]
    const source = override && (override.masked || override.encrypted) ? 'admin_override' : envKey ? 'env_map' : 'unknown'

    out[workflowId] = {
      source,
      has_env_value: Boolean(envKey),
      has_admin_masked: Boolean(override && override.masked),
      has_admin_encrypted: Boolean(override && override.encrypted),
      has_admin_value: Boolean(override && override.value),
      masked: override?.masked || maskSecret(envKey)
    }
  }

  return out
}

function resolveScenarioById(scenarioId, options = {}) {
  const registry = options.registry || new ScenarioRegistry()
  const adminStore = options.adminStore || new AdminConfigStore()

  if (!options.registry) {
    registry.load()
  }

  const scenario = registry.get(scenarioId)
  if (!scenario) return null

  const adminConfig = adminStore.getConfig()
  return resolveScenarioWithAdminOverrides(scenario, adminConfig)
}

function getAdminEffectiveConfigView(options = {}) {
  const adminStore = options.adminStore || new AdminConfigStore()
  const adminConfig = adminStore.getConfig()
  return {
    meta: {
      updated_at: adminConfig.updated_at || null,
      updated_by: adminConfig.updated_by || null
    },
    routes: isObject(adminConfig.routes) ? adminConfig.routes : { main_workflow_id: null, fallback_workflow_id: null, sub_type_routes: {} },
    sub_type_profiles: isObject(adminConfig.sub_type_profiles) ? adminConfig.sub_type_profiles : {},
    workflow_keys: getWorkflowKeyView(adminConfig),
    workflow_prompts: isObject(adminConfig.workflow_prompts) ? adminConfig.workflow_prompts : {}
  }
}

module.exports = {
  resolveScenarioWithAdminOverrides,
  resolveScenarioById,
  getWorkflowKeyView,
  getAdminEffectiveConfigView,
  parseEnvWorkflowApiKeyMap,
  maskSecret
}
