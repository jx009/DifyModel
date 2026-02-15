const Ajv = require('ajv')

const ajv = new Ajv({ allErrors: true, strict: false })

const strictInput = String(process.env.API_STRICT_INPUT || '').toLowerCase() === 'true'

const inferBaseSchema = {
  type: 'object',
  properties: {
    scenario_id: { type: 'string', minLength: 1 },
    input: { type: 'object' },
    context: {
      type: 'object',
      properties: {
        user_id: { type: 'string' },
        tenant_id: { type: 'string' },
        locale: { type: 'string' }
      },
      additionalProperties: true
    },
    options: {
      type: 'object',
      properties: {
        stream: { type: 'boolean' },
        latency_budget_ms: { type: 'integer', minimum: 100, maximum: 120000 },
        quality_tier: { type: 'string', enum: ['fast', 'balanced', 'strict'] },
        response_format: { type: 'string' }
      },
      additionalProperties: true
    }
  },
  required: ['scenario_id', 'input'],
  // Contract rule: unknown fields should be ignored unless strict mode is enabled.
  // Runtime can still choose to reject unknown fields by setting env `API_STRICT_INPUT=true`.
  additionalProperties: !strictInput
}

const feedbackSchema = {
  type: 'object',
  properties: {
    trace_id: { type: 'string', minLength: 1 },
    scenario_id: { type: 'string' },
    feedback: {
      type: 'object',
      properties: {
        label: {
          type: 'string',
          enum: ['correct', 'partially_correct', 'incorrect', 'irrelevant']
        },
        score: { type: 'number', minimum: 0, maximum: 5 },
        comment: { type: 'string', maxLength: 5000 }
      },
      required: ['label'],
      additionalProperties: true
    },
    operator: {
      type: 'object',
      properties: {
        user_id: { type: 'string' },
        tenant_id: { type: 'string' }
      },
      additionalProperties: true
    }
  },
  required: ['trace_id', 'feedback'],
  additionalProperties: !strictInput
}

const validateInferBase = ajv.compile(inferBaseSchema)
const validateFeedback = ajv.compile(feedbackSchema)

function inputSchemaFromScenario(scenario) {
  const s = scenario.input_schema || {}
  const properties = {}
  const required = Array.isArray(s.required_fields) ? s.required_fields : []

  // Use boolean schemas to explicitly disallow fields while still allowing unknown fields overall.
  // (Ajv supports boolean schemas; `false` means "always invalid" if the property is present.)
  properties.text = s.allow_text
    ? { type: 'string', maxLength: Number(s.max_text_length || 8000) }
    : false

  properties.images = s.allow_images
    ? {
        type: 'array',
        items: { type: 'string', minLength: 1 },
        maxItems: Number(s.max_images || 5)
      }
    : false

  properties.attachments = s.allow_attachments
    ? {
        type: 'array',
        items: { type: 'string', minLength: 1 }
      }
    : false

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: !strictInput
  }
}

const scenarioInputValidatorCache = new Map()

function getScenarioInputValidator(scenario) {
  const cacheKey = `${scenario.scenario_id}:${scenario.version || '0'}`
  if (scenarioInputValidatorCache.has(cacheKey)) {
    return scenarioInputValidatorCache.get(cacheKey)
  }

  const schema = inputSchemaFromScenario(scenario)
  const validator = ajv.compile(schema)
  scenarioInputValidatorCache.set(cacheKey, validator)
  return validator
}

function formatAjvErrors(errors) {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'invalid payload'
  }
  const first = errors[0]
  const path = first.instancePath || first.schemaPath || 'payload'
  return `${path} ${first.message}`.trim()
}

function validateInfer(payload, scenario) {
  const baseOk = validateInferBase(payload)
  if (!baseOk) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: formatAjvErrors(validateInferBase.errors),
      details: validateInferBase.errors || []
    }
  }

  const inputValidator = getScenarioInputValidator(scenario)
  const inputOk = inputValidator(payload.input)
  if (!inputOk) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: formatAjvErrors(inputValidator.errors),
      details: inputValidator.errors || []
    }
  }

  return { ok: true }
}

function validateFeedbackPayload(payload) {
  const ok = validateFeedback(payload)
  if (!ok) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: formatAjvErrors(validateFeedback.errors),
      details: validateFeedback.errors || []
    }
  }
  return { ok: true }
}

module.exports = {
  validateInfer,
  validateFeedbackPayload
}
