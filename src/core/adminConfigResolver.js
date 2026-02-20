const { ScenarioRegistry } = require('../config/scenarioRegistry')
const { AdminConfigStore } = require('./adminConfigStore')
const fs = require('fs')
const path = require('path')

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


function getAdminOverrideScenarioSet() {
  const raw = String(process.env.ADMIN_ROUTE_OVERRIDE_SCENARIOS || 'exam_qa').trim()
  if (!raw) return new Set(['exam_qa'])
  return new Set(raw.split(',').map((x) => x.trim()).filter(Boolean))
}

function shouldApplyAdminOverridesForScenario(scenarioId) {
  if (typeof scenarioId !== 'string' || !scenarioId.trim()) return false
  const scoped = getAdminOverrideScenarioSet()
  return scoped.has(scenarioId.trim())
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

  if (!shouldApplyAdminOverridesForScenario(scenario.scenario_id)) {
    return { ...scenario }
  }

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
  const registry = options.registry || new ScenarioRegistry()
  if (!options.registry) {
    registry.load()
  }

  const scenarioId = typeof options.scenarioId === 'string' && options.scenarioId.trim() ? options.scenarioId.trim() : 'exam_qa'
  const baseScenario = registry.get(scenarioId)
  const adminStore = options.adminStore || new AdminConfigStore()
  const adminConfig = adminStore.getConfig()
  const resolvedScenario = baseScenario ? resolveScenarioWithAdminOverrides(baseScenario, adminConfig) : null

  const effectiveRoutes = resolvedScenario?.workflow_binding
    ? {
        main_workflow_id: resolvedScenario.workflow_binding.workflow_id || null,
        fallback_workflow_id: resolvedScenario.workflow_binding.fallback_workflow_id || null,
        sub_type_routes: isObject(resolvedScenario.workflow_binding.sub_type_routes) ? resolvedScenario.workflow_binding.sub_type_routes : {}
      }
    : isObject(adminConfig.routes)
      ? adminConfig.routes
      : { main_workflow_id: null, fallback_workflow_id: null, sub_type_routes: {} }

  const defaultPrompts = {}
  if (baseScenario && baseScenario.scenario_id) {
    const manifestPath = path.join(process.cwd(), 'configs', 'workflows', baseScenario.scenario_id, 'workflow-manifest.json')
    try {
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
        const workflows = Array.isArray(manifest.workflows) ? manifest.workflows : []
        for (const wf of workflows) {
          const workflowId = typeof wf.workflow_id === 'string' ? wf.workflow_id.trim() : ''
          const promptFile = typeof wf.prompt_template_file === 'string' ? wf.prompt_template_file.trim() : ''
          if (!workflowId || !promptFile) continue
          const promptPath = path.join(process.cwd(), 'configs', 'workflows', baseScenario.scenario_id, promptFile)
          if (!fs.existsSync(promptPath)) continue
          const content = fs.readFileSync(promptPath, 'utf8')
          defaultPrompts[workflowId] = {
            version: 0,
            content,
            updated_at: null,
            source: 'default_file'
          }
        }
      }
    } catch (_error) {
      // ignore default prompt parse failure
    }
  }

  const overridePrompts = isObject(adminConfig.workflow_prompts) ? adminConfig.workflow_prompts : {}
  const mergedPrompts = { ...defaultPrompts, ...overridePrompts }

  return {
    meta: {
      updated_at: adminConfig.updated_at || null,
      updated_by: adminConfig.updated_by || null,
      scenario_id: scenarioId
    },
    routes: effectiveRoutes,
    sub_type_profiles: resolvedScenario?.sub_type_profiles || {},
    workflow_keys: getWorkflowKeyView(adminConfig),
    workflow_prompts: mergedPrompts
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
