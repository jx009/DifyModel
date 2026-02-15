const { KnowledgeManager } = require('./knowledgeManager')
const { KbMappingStore } = require('./kbMappingStore')
const { ScenarioRegistry } = require('../config/scenarioRegistry')
const { writeLog } = require('./logger')

const knowledgeManager = new KnowledgeManager()
const kbMappingStore = new KbMappingStore()
let initialized = false

function validateKbMappingsOnBoot() {
  const allowInactive = String(process.env.KB_ALLOW_INACTIVE || '').toLowerCase() === 'true'
  const failFast = String(process.env.KB_MAPPING_FAIL_FAST || '').toLowerCase() === 'true'
  const requireMappingsForEnabledScenarios = String(process.env.KB_MAPPING_REQUIRE_ENABLED_SCENARIOS || 'true').toLowerCase() !== 'false'

  const loadErrors = kbMappingStore.getLoadErrors()
  for (const err of loadErrors) {
    writeLog('warn', 'kb mapping load error', {
      trace_id: 'bootstrap',
      file: err.file || 'unknown',
      reason: err.reason,
      message_detail: err.message || null
    })
  }

  const regInfo = knowledgeManager.getRegistryInfo()
  if (regInfo.load_error) {
    writeLog('warn', 'kb registry load error', {
      trace_id: 'bootstrap',
      reason: regInfo.load_error.reason,
      message_detail: regInfo.load_error.message || null
    })
  }

  const kbIndex = knowledgeManager.getKbIndex()
  const issues = kbMappingStore.validateWithRegistry({ kbIndex, allowInactive })
  for (const issue of issues) {
    writeLog('warn', 'kb mapping validation issue', {
      trace_id: 'bootstrap',
      scenario_id: issue.scenario_id,
      kb_id: issue.kb_id,
      reason: issue.reason
    })
  }

  if (requireMappingsForEnabledScenarios) {
    const scenarioRegistry = new ScenarioRegistry()
    scenarioRegistry.load()
    for (const scenarioId of scenarioRegistry.listIds()) {
      const scenario = scenarioRegistry.get(scenarioId)
      if (!scenario || !scenario.enabled) continue
      const kp = scenario.knowledge_policy || {}
      if (!kp.enabled || kp.mode === 'off') continue

      const raw = kbMappingStore.getRaw(scenarioId)
      if (!raw) {
        const detail = {
          trace_id: 'bootstrap',
          scenario_id: scenarioId,
          reason: 'mapping_missing_for_enabled_scenario'
        }
        if (failFast) {
          throw new Error(`kb mapping missing for enabled scenario: ${scenarioId}`)
        }
        writeLog('warn', 'kb mapping missing for enabled scenario', detail)
      }
    }
  }

  if (!issues.length) return

  for (const issue of issues) {
    if (failFast) {
      throw new Error(`kb mapping validation failed scenario=${issue.scenario_id} kb=${issue.kb_id} reason=${issue.reason}`)
    }
  }
}

function initializeRuntimeResources() {
  if (initialized) return
  validateKbMappingsOnBoot()
  initialized = true
}

function getRuntimeResources() {
  return {
    knowledgeManager,
    kbMappingStore,
    initialized
  }
}

module.exports = {
  getRuntimeResources,
  initializeRuntimeResources
}
