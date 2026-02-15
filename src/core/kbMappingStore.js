const fs = require('fs')
const path = require('path')

const KBMAP_DIR = path.join(process.cwd(), 'configs', 'kb-mappings')

function safeJsonParse(text) {
  try {
    return JSON.parse(text)
  } catch (_error) {
    return null
  }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base
  const out = { ...(base || {}) }
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out[k] = deepMerge(out[k], v)
      continue
    }
    out[k] = v
  }
  return out
}

class KbMappingStore {
  constructor() {
    this.mappings = new Map()
    this.lastMtimeMs = 0
    this.lastStatCheckAt = 0
    this.lastLoadErrors = []
    this.load()
  }

  maybeReload() {
    const intervalMs = Number(process.env.KB_MAPPING_RELOAD_INTERVAL_MS || 10_000)
    const now = Date.now()
    if (now - this.lastStatCheckAt < intervalMs) return
    this.lastStatCheckAt = now

    const latestMtime = this.getLatestMtimeMs()
    if (latestMtime > this.lastMtimeMs) {
      this.load()
    }
  }

  getLatestMtimeMs() {
    if (!fs.existsSync(KBMAP_DIR)) return 0
    const files = fs.readdirSync(KBMAP_DIR).filter((x) => x.endsWith('.kbmap.json'))
    let maxMtime = 0
    for (const file of files) {
      try {
        const stat = fs.statSync(path.join(KBMAP_DIR, file))
        maxMtime = Math.max(maxMtime, Number(stat.mtimeMs || 0))
      } catch (_error) {
        // ignore broken file stat
      }
    }
    return maxMtime
  }

  load() {
    this.mappings.clear()
    this.lastLoadErrors = []
    if (!fs.existsSync(KBMAP_DIR)) return

    const files = fs.readdirSync(KBMAP_DIR)
    for (const file of files) {
      if (!file.endsWith('.kbmap.json')) continue
      const full = path.join(KBMAP_DIR, file)
      let raw
      try {
        raw = fs.readFileSync(full, 'utf8')
      } catch (error) {
        this.lastLoadErrors.push({ file, reason: 'read_error', message: error.message })
        continue
      }
      const parsed = safeJsonParse(raw)
      if (!parsed || !parsed.scenario_id) {
        this.lastLoadErrors.push({ file, reason: 'invalid_json_or_missing_scenario_id' })
        continue
      }
      this.mappings.set(parsed.scenario_id, parsed)
    }

    this.lastMtimeMs = this.getLatestMtimeMs()
  }

  getRaw(scenarioId) {
    this.maybeReload()
    return this.mappings.get(scenarioId) || null
  }

  listScenarioIds() {
    this.maybeReload()
    return Array.from(this.mappings.keys())
  }

  getLoadErrors() {
    return [...this.lastLoadErrors]
  }

  validateWithRegistry({ kbIndex, allowInactive = false } = {}) {
    this.maybeReload()
    const issues = []
    if (!(kbIndex instanceof Map)) return issues

    for (const [scenarioId, raw] of this.mappings.entries()) {
      const candidates = []
      const base = raw.overrides || {}
      const envLayers = raw.env_overrides && typeof raw.env_overrides === 'object' ? Object.values(raw.env_overrides) : []
      const tenantLayers = raw.tenant_overrides && typeof raw.tenant_overrides === 'object' ? Object.values(raw.tenant_overrides) : []
      candidates.push(base, ...envLayers, ...tenantLayers)

      for (const layer of candidates) {
        if (!layer || typeof layer !== 'object') continue
        const defaultKbIds = Array.isArray(layer.default_kb_ids) ? layer.default_kb_ids : []
        const subTypeMap = layer.sub_type_kb_map && typeof layer.sub_type_kb_map === 'object' ? layer.sub_type_kb_map : {}

        for (const kbId of defaultKbIds) {
          const item = kbIndex.get(kbId)
          if (!item) {
            issues.push({ scenario_id: scenarioId, kb_id: kbId, reason: 'missing_kb' })
            continue
          }
          if (!allowInactive && item.status !== 'active') {
            issues.push({ scenario_id: scenarioId, kb_id: kbId, reason: `kb_not_active:${item.status}` })
          }
        }

        for (const kbIds of Object.values(subTypeMap)) {
          if (!Array.isArray(kbIds)) continue
          for (const kbId of kbIds) {
            const item = kbIndex.get(kbId)
            if (!item) {
              issues.push({ scenario_id: scenarioId, kb_id: kbId, reason: 'missing_kb' })
              continue
            }
            if (!allowInactive && item.status !== 'active') {
              issues.push({ scenario_id: scenarioId, kb_id: kbId, reason: `kb_not_active:${item.status}` })
            }
          }
        }
      }
    }

    return issues
  }

  getEffectiveMapping(scenarioId, env, tenantId) {
    const raw = this.getRaw(scenarioId)
    if (!raw) {
      return {
        found: false,
        version: null,
        updated_at: null,
        default_kb_ids: undefined,
        sub_type_kb_map: undefined,
        top_k: undefined,
        rerank: undefined,
        max_context_chars: undefined,
        source: 'none'
      }
    }

    const base = raw.overrides || {}
    const envLayer = (raw.env_overrides && raw.env_overrides[env]) || {}
    const tenantLayer = (raw.tenant_overrides && tenantId && raw.tenant_overrides[tenantId]) || {}

    const merged = deepMerge(deepMerge(base, envLayer), tenantLayer)

    return {
      found: true,
      version: raw.version || '0',
      updated_at: raw.updated_at || null,
      default_kb_ids: merged.default_kb_ids,
      sub_type_kb_map: merged.sub_type_kb_map,
      top_k: merged.top_k,
      rerank: merged.rerank,
      max_context_chars: merged.max_context_chars,
      source: tenantLayer && Object.keys(tenantLayer).length ? 'tenant_override' : envLayer && Object.keys(envLayer).length ? 'env_override' : 'base_override'
    }
  }
}

module.exports = {
  KbMappingStore
}
