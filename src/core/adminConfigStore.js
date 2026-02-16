const fs = require('fs')
const path = require('path')

const { pickWritableDataRoot } = require('./storagePaths')

const DATA_ROOT = pickWritableDataRoot()
const ADMIN_DIR = path.join(DATA_ROOT, 'admin')
const ADMIN_HISTORY_DIR = path.join(ADMIN_DIR, 'history')
const ADMIN_CONFIG_FILE = path.join(ADMIN_DIR, 'workflow-overrides.json')

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asStringArray(value) {
  if (!Array.isArray(value)) return []
  return value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value))
}

function nowIso() {
  return new Date().toISOString()
}

function defaultConfig() {
  return {
    version: '1.0.0',
    updated_at: null,
    updated_by: null,
    routes: {
      main_workflow_id: null,
      fallback_workflow_id: null,
      sub_type_routes: {}
    },
    sub_type_profiles: {},
    workflow_keys: {},
    workflow_prompts: {}
  }
}

function validateConfigShape(input) {
  const errors = []
  if (!isObject(input)) {
    return ['config root must be object']
  }

  if (input.version !== undefined && typeof input.version !== 'string') {
    errors.push('version must be string')
  }
  if (input.updated_at !== undefined && input.updated_at !== null && typeof input.updated_at !== 'string') {
    errors.push('updated_at must be string or null')
  }
  if (input.updated_by !== undefined && input.updated_by !== null && typeof input.updated_by !== 'string') {
    errors.push('updated_by must be string or null')
  }

  if (input.routes !== undefined) {
    if (!isObject(input.routes)) {
      errors.push('routes must be object')
    } else {
      const routes = input.routes
      if (routes.main_workflow_id !== undefined && routes.main_workflow_id !== null && typeof routes.main_workflow_id !== 'string') {
        errors.push('routes.main_workflow_id must be string or null')
      }
      if (routes.fallback_workflow_id !== undefined && routes.fallback_workflow_id !== null && typeof routes.fallback_workflow_id !== 'string') {
        errors.push('routes.fallback_workflow_id must be string or null')
      }
      if (routes.sub_type_routes !== undefined) {
        if (!isObject(routes.sub_type_routes)) {
          errors.push('routes.sub_type_routes must be object')
        } else {
          for (const [subType, workflowId] of Object.entries(routes.sub_type_routes)) {
            if (typeof subType !== 'string' || !subType.trim()) {
              errors.push('routes.sub_type_routes key must be non-empty string')
            }
            if (typeof workflowId !== 'string' || !workflowId.trim()) {
              errors.push(`routes.sub_type_routes.${subType} must be non-empty string`)
            }
          }
        }
      }
    }
  }

  if (input.sub_type_profiles !== undefined) {
    if (!isObject(input.sub_type_profiles)) {
      errors.push('sub_type_profiles must be object')
    } else {
      for (const [subType, profile] of Object.entries(input.sub_type_profiles)) {
        if (!isObject(profile)) {
          errors.push(`sub_type_profiles.${subType} must be object`)
          continue
        }
        if (profile.display_name !== undefined && profile.display_name !== null && typeof profile.display_name !== 'string') {
          errors.push(`sub_type_profiles.${subType}.display_name must be string or null`)
        }
        if (profile.classifier_hints !== undefined && !isObject(profile.classifier_hints)) {
          errors.push(`sub_type_profiles.${subType}.classifier_hints must be object`)
        }
        if (profile.workflow_guidance !== undefined && !isObject(profile.workflow_guidance)) {
          errors.push(`sub_type_profiles.${subType}.workflow_guidance must be object`)
        }
      }
    }
  }

  if (input.workflow_keys !== undefined) {
    if (!isObject(input.workflow_keys)) {
      errors.push('workflow_keys must be object')
    } else {
      for (const [workflowId, keyInfo] of Object.entries(input.workflow_keys)) {
        if (!isObject(keyInfo)) {
          errors.push(`workflow_keys.${workflowId} must be object`)
          continue
        }
        if (keyInfo.masked !== undefined && keyInfo.masked !== null && typeof keyInfo.masked !== 'string') {
          errors.push(`workflow_keys.${workflowId}.masked must be string or null`)
        }
        if (keyInfo.encrypted !== undefined && keyInfo.encrypted !== null && typeof keyInfo.encrypted !== 'string') {
          errors.push(`workflow_keys.${workflowId}.encrypted must be string or null`)
        }
        if (keyInfo.value !== undefined && keyInfo.value !== null && typeof keyInfo.value !== 'string') {
          errors.push(`workflow_keys.${workflowId}.value must be string or null`)
        }
      }
    }
  }

  if (input.workflow_prompts !== undefined) {
    if (!isObject(input.workflow_prompts)) {
      errors.push('workflow_prompts must be object')
    } else {
      for (const [workflowId, promptInfo] of Object.entries(input.workflow_prompts)) {
        if (!isObject(promptInfo)) {
          errors.push(`workflow_prompts.${workflowId} must be object`)
          continue
        }
        if (promptInfo.version !== undefined && !Number.isFinite(Number(promptInfo.version))) {
          errors.push(`workflow_prompts.${workflowId}.version must be number`)
        }
        if (promptInfo.content !== undefined && promptInfo.content !== null && typeof promptInfo.content !== 'string') {
          errors.push(`workflow_prompts.${workflowId}.content must be string or null`)
        }
      }
    }
  }

  return errors
}

function normalizeConfig(input) {
  const base = defaultConfig()
  const src = isObject(input) ? input : {}

  const routes = isObject(src.routes) ? src.routes : {}
  const subTypeRoutes = isObject(routes.sub_type_routes) ? routes.sub_type_routes : {}
  const normalizedSubTypeRoutes = {}
  for (const [subType, workflowId] of Object.entries(subTypeRoutes)) {
    if (typeof subType !== 'string' || !subType.trim()) continue
    if (typeof workflowId !== 'string' || !workflowId.trim()) continue
    normalizedSubTypeRoutes[subType.trim()] = workflowId.trim()
  }

  const normalizedSubTypeProfiles = {}
  const sourceProfiles = isObject(src.sub_type_profiles) ? src.sub_type_profiles : {}
  for (const [subType, rawProfile] of Object.entries(sourceProfiles)) {
    if (!isObject(rawProfile)) continue
    const hints = isObject(rawProfile.classifier_hints) ? rawProfile.classifier_hints : {}
    const guidance = isObject(rawProfile.workflow_guidance) ? rawProfile.workflow_guidance : {}

    normalizedSubTypeProfiles[subType] = {
      ...(typeof rawProfile.display_name === 'string' ? { display_name: rawProfile.display_name } : {}),
      classifier_hints: {
        keywords: asStringArray(hints.keywords),
        ...(hints.require_images !== undefined ? { require_images: Boolean(hints.require_images) } : {}),
        ...(hints.prefer_images !== undefined ? { prefer_images: Boolean(hints.prefer_images) } : {}),
        ...(hints.image_only_default !== undefined ? { image_only_default: Boolean(hints.image_only_default) } : {})
      },
      workflow_guidance: {
        solving_steps: asStringArray(guidance.solving_steps),
        prompt_focus: asStringArray(guidance.prompt_focus),
        answer_constraints: asStringArray(guidance.answer_constraints)
      }
    }
  }

  const normalizedWorkflowKeys = {}
  const sourceWorkflowKeys = isObject(src.workflow_keys) ? src.workflow_keys : {}
  for (const [workflowId, rawKey] of Object.entries(sourceWorkflowKeys)) {
    if (!isObject(rawKey)) continue
    normalizedWorkflowKeys[workflowId] = {
      masked: typeof rawKey.masked === 'string' ? rawKey.masked : null,
      encrypted: typeof rawKey.encrypted === 'string' ? rawKey.encrypted : null,
      value: typeof rawKey.value === 'string' ? rawKey.value : null
    }
  }

  const normalizedWorkflowPrompts = {}
  const sourceWorkflowPrompts = isObject(src.workflow_prompts) ? src.workflow_prompts : {}
  for (const [workflowId, rawPrompt] of Object.entries(sourceWorkflowPrompts)) {
    if (!isObject(rawPrompt)) continue
    const version = Number(rawPrompt.version)
    normalizedWorkflowPrompts[workflowId] = {
      version: Number.isFinite(version) ? version : 1,
      content: typeof rawPrompt.content === 'string' ? rawPrompt.content : '',
      updated_at: typeof rawPrompt.updated_at === 'string' ? rawPrompt.updated_at : null
    }
  }

  return {
    ...base,
    version: typeof src.version === 'string' ? src.version : base.version,
    updated_at: typeof src.updated_at === 'string' ? src.updated_at : base.updated_at,
    updated_by: typeof src.updated_by === 'string' ? src.updated_by : base.updated_by,
    routes: {
      main_workflow_id: typeof routes.main_workflow_id === 'string' ? routes.main_workflow_id : null,
      fallback_workflow_id: typeof routes.fallback_workflow_id === 'string' ? routes.fallback_workflow_id : null,
      sub_type_routes: normalizedSubTypeRoutes
    },
    sub_type_profiles: normalizedSubTypeProfiles,
    workflow_keys: normalizedWorkflowKeys,
    workflow_prompts: normalizedWorkflowPrompts
  }
}

function writeJsonAtomic(filePath, payload) {
  const tempPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  fs.renameSync(tempPath, filePath)
}

class AdminConfigStore {
  constructor() {
    this.cache = defaultConfig()
    this.lastMtimeMs = 0
    this.lastStatCheckAt = 0
    this.lastLoadError = null
    this.ensureDirs()
    this.load()
  }

  ensureDirs() {
    fs.mkdirSync(ADMIN_HISTORY_DIR, { recursive: true })
  }

  maybeReload() {
    const intervalMs = Number(process.env.ADMIN_CONFIG_RELOAD_INTERVAL_MS || 5000)
    const now = Date.now()
    if (now - this.lastStatCheckAt < intervalMs) return
    this.lastStatCheckAt = now

    try {
      const stat = fs.statSync(ADMIN_CONFIG_FILE)
      const mtimeMs = Number(stat.mtimeMs || 0)
      if (mtimeMs > this.lastMtimeMs) {
        this.load()
      }
    } catch (_error) {
      if (this.lastMtimeMs !== 0) {
        this.cache = defaultConfig()
        this.lastMtimeMs = 0
      }
    }
  }

  load() {
    this.lastLoadError = null
    if (!fs.existsSync(ADMIN_CONFIG_FILE)) {
      this.cache = defaultConfig()
      this.lastMtimeMs = 0
      return
    }

    try {
      const raw = fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8')
      const parsed = raw.trim() ? JSON.parse(raw) : {}
      const errors = validateConfigShape(parsed)
      if (errors.length > 0) {
        this.cache = defaultConfig()
        this.lastLoadError = {
          reason: 'invalid_shape',
          errors
        }
        return
      }
      this.cache = normalizeConfig(parsed)

      const stat = fs.statSync(ADMIN_CONFIG_FILE)
      this.lastMtimeMs = Number(stat.mtimeMs || 0)
    } catch (error) {
      this.cache = defaultConfig()
      this.lastLoadError = {
        reason: 'read_or_parse_failed',
        message: error.message
      }
      this.lastMtimeMs = 0
    }
  }

  getInfo() {
    this.maybeReload()
    return {
      file: ADMIN_CONFIG_FILE,
      exists: fs.existsSync(ADMIN_CONFIG_FILE),
      updated_at: this.cache.updated_at,
      updated_by: this.cache.updated_by,
      load_error: this.lastLoadError
    }
  }

  getConfig() {
    this.maybeReload()
    return deepClone(this.cache)
  }

  writeSnapshot(previous, meta) {
    const snapshot = {
      snapshot_at: nowIso(),
      meta: {
        reason: meta?.reason || null,
        updated_by: meta?.updated_by || null
      },
      config: previous
    }
    const filename = `${Date.now()}.json`
    const snapshotFile = path.join(ADMIN_HISTORY_DIR, filename)
    fs.writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
    return filename
  }

  saveConfig(nextConfig, meta = {}) {
    const errors = validateConfigShape(nextConfig)
    if (errors.length > 0) {
      const error = new Error(`admin config invalid: ${errors.join('; ')}`)
      error.code = 'INVALID_ADMIN_CONFIG'
      error.details = errors
      throw error
    }

    const previous = this.getConfig()
    const normalized = normalizeConfig(nextConfig)
    normalized.updated_at = nowIso()
    normalized.updated_by = typeof meta.updated_by === 'string' && meta.updated_by.trim() ? meta.updated_by.trim() : 'system'

    this.writeSnapshot(previous, meta)
    writeJsonAtomic(ADMIN_CONFIG_FILE, normalized)
    this.cache = normalized

    try {
      const stat = fs.statSync(ADMIN_CONFIG_FILE)
      this.lastMtimeMs = Number(stat.mtimeMs || 0)
    } catch (_error) {
      this.lastMtimeMs = Date.now()
    }

    return this.getConfig()
  }

  updateConfig(mutator, meta = {}) {
    if (typeof mutator !== 'function') {
      throw new Error('mutator must be function')
    }
    const current = this.getConfig()
    const next = mutator(deepClone(current))
    if (!isObject(next)) {
      throw new Error('mutator must return config object')
    }
    return this.saveConfig(next, meta)
  }

  listSnapshots(limit = 30) {
    this.ensureDirs()
    const max = Math.max(1, Math.min(200, Number(limit || 30)))
    const files = fs
      .readdirSync(ADMIN_HISTORY_DIR)
      .filter((name) => name.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, max)

    const out = []
    for (const file of files) {
      const fullPath = path.join(ADMIN_HISTORY_DIR, file)
      try {
        const raw = fs.readFileSync(fullPath, 'utf8')
        const parsed = raw.trim() ? JSON.parse(raw) : {}
        out.push({
          id: file,
          snapshot_at: parsed.snapshot_at || null,
          updated_by: parsed?.meta?.updated_by || null,
          reason: parsed?.meta?.reason || null
        })
      } catch (_error) {
        out.push({
          id: file,
          snapshot_at: null,
          updated_by: null,
          reason: 'broken_snapshot'
        })
      }
    }
    return out
  }

  rollbackSnapshot(snapshotId, meta = {}) {
    if (typeof snapshotId !== 'string' || !snapshotId.trim()) {
      const error = new Error('snapshot id is required')
      error.code = 'INVALID_INPUT'
      throw error
    }
    const safeName = path.basename(snapshotId.trim())
    const fullPath = path.join(ADMIN_HISTORY_DIR, safeName)
    if (!fs.existsSync(fullPath)) {
      const error = new Error(`snapshot not found: ${safeName}`)
      error.code = 'NOT_FOUND'
      throw error
    }

    const raw = fs.readFileSync(fullPath, 'utf8')
    const parsed = raw.trim() ? JSON.parse(raw) : {}
    const config = parsed && parsed.config
    if (!isObject(config)) {
      const error = new Error('snapshot content invalid')
      error.code = 'INVALID_INPUT'
      throw error
    }

    return this.saveConfig(config, {
      reason: `rollback:${safeName}`,
      updated_by: meta.updated_by || 'admin'
    })
  }
}

module.exports = {
  AdminConfigStore,
  ADMIN_CONFIG_FILE,
  ADMIN_DIR,
  ADMIN_HISTORY_DIR,
  DATA_ROOT
}
