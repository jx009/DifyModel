#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fail(msg) {
  console.error(`[FAIL] ${msg}`)
  process.exitCode = 1
}

function pass(msg) {
  console.log(`[PASS] ${msg}`)
}

function main() {
  const root = process.cwd()
  const scenarioFile = path.join(root, 'configs', 'scenarios', 'exam_qa.scenario.json')
  const registryFile = path.join(root, 'configs', 'kb', 'KB_REGISTRY.json')
  const mappingFile = path.join(root, 'configs', 'kb-mappings', 'exam_qa.kbmap.json')
  const manifestFile = path.join(root, 'configs', 'workflows', 'exam_qa', 'workflow-manifest.json')

  const scenario = readJson(scenarioFile)
  const registry = readJson(registryFile)
  const mapping = readJson(mappingFile)
  const manifest = readJson(manifestFile)

  if (manifest.scenario_id !== scenario.scenario_id) {
    fail(`manifest scenario_id mismatch: ${manifest.scenario_id} != ${scenario.scenario_id}`)
  } else {
    pass('manifest scenario_id matches scenario config')
  }

  const routeMap = scenario?.workflow_binding?.sub_type_routes || {}
  const profileMap = scenario?.sub_type_profiles || {}
  const mappingMap = mapping?.overrides?.sub_type_kb_map || {}
  const registrySet = new Set((registry.items || []).map((x) => x.kb_id))
  const promptDir = path.join(root, 'configs', 'workflows', 'exam_qa')

  for (const wf of manifest.workflows || []) {
    const st = wf.sub_type
    if (!st) {
      fail('workflow item has empty sub_type')
      continue
    }

    if (routeMap[st] !== wf.workflow_id) {
      fail(`sub_type ${st} workflow mismatch: route=${routeMap[st] || 'null'} manifest=${wf.workflow_id}`)
    } else {
      pass(`sub_type ${st} workflow id is consistent`)
    }

    if (!profileMap[st]) {
      fail(`sub_type ${st} missing sub_type_profiles`)
    } else {
      pass(`sub_type ${st} has profile`)
    }

    const mappedKbIds = Array.isArray(mappingMap[st]) ? mappingMap[st] : []
    for (const kbId of mappedKbIds) {
      if (!registrySet.has(kbId)) {
        fail(`sub_type ${st} mapped kb ${kbId} not found in registry`)
      }
    }
    if (mappedKbIds.length > 0) {
      pass(`sub_type ${st} kb mapping exists`)
    } else {
      fail(`sub_type ${st} kb mapping missing`)
    }

    const promptFile = wf.prompt_template_file
    if (!promptFile) {
      fail(`sub_type ${st} missing prompt_template_file`)
    } else if (!fs.existsSync(path.join(promptDir, promptFile))) {
      fail(`sub_type ${st} prompt file not found: ${promptFile}`)
    } else {
      pass(`sub_type ${st} prompt file exists`)
    }
  }

  const contractFields = manifest?.output_contract?.required_fields || []
  const required = ['answer', 'evidence', 'confidence', 'sub_type']
  for (const field of required) {
    if (!contractFields.includes(field)) {
      fail(`manifest output contract missing field: ${field}`)
    }
  }
  if (required.every((x) => contractFields.includes(x))) {
    pass('manifest output contract fields are complete')
  }

  if (process.exitCode && process.exitCode !== 0) {
    console.error('\nworkflow manifest validation failed')
    return
  }
  console.log('\nworkflow manifest validation passed')
}

main()
