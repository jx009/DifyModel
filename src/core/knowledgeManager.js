const fs = require('fs')
const path = require('path')

const REGISTRY_PATH = path.join(process.cwd(), 'configs', 'kb', 'KB_REGISTRY.json')

class KnowledgeManager {
  constructor() {
    this.registry = null
    this.kbIndex = new Map()
    this.lastMtimeMs = 0
    this.lastStatCheckAt = 0
    this.lastLoadError = null
    this.loadRegistry()
  }

  maybeReload() {
    const intervalMs = Number(process.env.KB_REGISTRY_RELOAD_INTERVAL_MS || 10_000)
    const now = Date.now()
    if (now - this.lastStatCheckAt < intervalMs) return
    this.lastStatCheckAt = now

    try {
      const stat = fs.statSync(REGISTRY_PATH)
      if (Number(stat.mtimeMs || 0) > this.lastMtimeMs) {
        this.loadRegistry()
      }
    } catch (_error) {
      // ignore
    }
  }

  loadRegistry() {
    this.kbIndex.clear()
    this.lastLoadError = null

    if (!fs.existsSync(REGISTRY_PATH)) {
      this.registry = { version: '0', updated_at: new Date().toISOString(), items: [] }
      this.lastLoadError = { reason: 'registry_file_missing', path: REGISTRY_PATH }
      if (String(process.env.KB_REGISTRY_FAIL_FAST || '').toLowerCase() === 'true') {
        throw new Error(`KB_REGISTRY file is missing: ${REGISTRY_PATH}`)
      }
      console.warn(`[KnowledgeManager] KB registry file missing: ${REGISTRY_PATH}`)
      return
    }

    let parsed
    try {
      parsed = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'))
    } catch (error) {
      this.registry = { version: '0', updated_at: new Date().toISOString(), items: [] }
      this.lastLoadError = { reason: 'registry_parse_failed', message: error.message }
      if (String(process.env.KB_REGISTRY_FAIL_FAST || '').toLowerCase() === 'true') {
        throw new Error(`KB_REGISTRY parse failed: ${error.message}`)
      }
      console.error(`[KnowledgeManager] KB registry parse failed: ${error.message}`)
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      this.registry = { version: '0', updated_at: new Date().toISOString(), items: [] }
      this.lastLoadError = { reason: 'registry_invalid_shape' }
      console.error('[KnowledgeManager] KB registry invalid shape: root is not object')
      return
    }

    this.registry = parsed

    const items = Array.isArray(parsed.items) ? parsed.items : []
    if (!Array.isArray(parsed.items)) {
      this.lastLoadError = { reason: 'registry_items_missing_or_not_array' }
      console.error('[KnowledgeManager] KB registry invalid: items must be array')
    }
    for (const item of items) {
      if (!item || typeof item.kb_id !== 'string' || !item.kb_id.trim()) continue
      this.kbIndex.set(item.kb_id, item)
    }

    try {
      const stat = fs.statSync(REGISTRY_PATH)
      this.lastMtimeMs = Number(stat.mtimeMs || 0)
    } catch (_error) {
      // ignore
    }
  }

  getRegistryInfo() {
    return {
      version: this.registry?.version || '0',
      updated_at: this.registry?.updated_at || null,
      count: this.kbIndex.size,
      load_error: this.lastLoadError
    }
  }

  getKbIndex() {
    this.maybeReload()
    return new Map(this.kbIndex)
  }

  listItems() {
    return Array.from(this.kbIndex.values())
  }

  getItem(kbId) {
    return this.kbIndex.get(kbId) || null
  }

  enrichPlan(knowledgePlan) {
    this.maybeReload()

    if (!knowledgePlan || !knowledgePlan.enabled) {
      return {
        enabled: false,
        mode: knowledgePlan?.mode || 'off',
        kb_ids: [],
        top_k: Number(knowledgePlan?.top_k || 0) || undefined,
        rerank: knowledgePlan?.rerank === undefined ? undefined : Boolean(knowledgePlan.rerank),
        max_context_chars: Number(knowledgePlan?.max_context_chars || 0) || undefined
      }
    }

    const allowInactive = String(process.env.KB_ALLOW_INACTIVE || '').toLowerCase() === 'true'
    const kbIds = Array.isArray(knowledgePlan.kb_ids) ? knowledgePlan.kb_ids : []
    const requestedKbIds = [...kbIds]
    const kbItems = []
    const droppedKbIds = []

    for (const kbId of kbIds) {
      const item = this.getItem(kbId)
      const status = item?.status || (item ? 'unknown' : 'missing')
      if (!allowInactive && status !== 'active') {
        droppedKbIds.push(kbId)
        continue
      }
      kbItems.push({
        kb_id: kbId,
        kb_version: item?.kb_version || 'unknown',
        status,
        source: item?.source || 'unknown'
      })
    }

    if (knowledgePlan.enabled && kbItems.length === 0) {
      return {
        enabled: false,
        mode: knowledgePlan.mode || 'conditional',
        kb_ids: [],
        kb_items: [],
        requested_kb_ids: requestedKbIds,
        dropped_kb_ids: droppedKbIds,
        top_k: Number(knowledgePlan.top_k || 0) || undefined,
        rerank: knowledgePlan.rerank === undefined ? undefined : Boolean(knowledgePlan.rerank),
        max_context_chars: Number(knowledgePlan.max_context_chars || 0) || undefined,
        reason: 'no_active_kb'
      }
    }

    return {
      ...knowledgePlan,
      kb_ids: kbItems.map((x) => x.kb_id),
      kb_items: kbItems,
      requested_kb_ids: requestedKbIds,
      dropped_kb_ids: droppedKbIds
    }
  }
}

module.exports = {
  KnowledgeManager
}
