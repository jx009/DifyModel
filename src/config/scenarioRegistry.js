const fs = require('fs')
const path = require('path')

const SCENARIO_DIR = path.join(process.cwd(), 'configs', 'scenarios')

class ScenarioRegistry {
  constructor() {
    this.scenarios = new Map()
  }

  load() {
    this.scenarios.clear()
    if (!fs.existsSync(SCENARIO_DIR)) {
      return
    }

    const files = fs.readdirSync(SCENARIO_DIR)
    for (const file of files) {
      if (!file.endsWith('.scenario.json')) continue
      if (file.startsWith('_')) continue
      const fullPath = path.join(SCENARIO_DIR, file)
      const raw = fs.readFileSync(fullPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed.scenario_id) continue
      this.scenarios.set(parsed.scenario_id, parsed)
    }
  }

  get(scenarioId) {
    return this.scenarios.get(scenarioId) || null
  }

  count() {
    return this.scenarios.size
  }

  listIds() {
    return Array.from(this.scenarios.keys())
  }
}

module.exports = {
  ScenarioRegistry
}
