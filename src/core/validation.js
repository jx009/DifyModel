function hasField(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj || {}, key)
}

function validateInferPayload(payload, scenario) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', message: 'request body must be an object' }
  }

  if (typeof payload.scenario_id !== 'string' || !payload.scenario_id.trim()) {
    return { ok: false, code: 'INVALID_INPUT', message: 'scenario_id is required' }
  }

  const input = payload.input
  if (!input || typeof input !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', message: 'input is required' }
  }

  const schema = scenario.input_schema || {}
  const requiredFields = Array.isArray(schema.required_fields) ? schema.required_fields : []

  for (const field of requiredFields) {
    if (!hasField(input, field)) {
      return { ok: false, code: 'INVALID_INPUT', message: `input.${field} is required` }
    }
  }

  const text = input.text
  if (hasField(input, 'text')) {
    if (!schema.allow_text) {
      return { ok: false, code: 'INVALID_INPUT', message: 'input.text is not allowed for this scenario' }
    }
    if (typeof text !== 'string') {
      return { ok: false, code: 'INVALID_INPUT', message: 'input.text must be string' }
    }
    const maxText = Number(schema.max_text_length || 8000)
    if (text.length > maxText) {
      return { ok: false, code: 'INVALID_INPUT', message: `input.text exceeds ${maxText}` }
    }
  }

  const images = input.images
  if (hasField(input, 'images')) {
    if (!schema.allow_images) {
      return { ok: false, code: 'INVALID_INPUT', message: 'input.images is not allowed for this scenario' }
    }
    if (!Array.isArray(images)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'input.images must be array' }
    }
    const maxImages = Number(schema.max_images || 0)
    if (images.length > maxImages) {
      return { ok: false, code: 'INVALID_INPUT', message: `input.images exceeds ${maxImages}` }
    }
  }

  const attachments = input.attachments
  if (hasField(input, 'attachments')) {
    if (!schema.allow_attachments) {
      return { ok: false, code: 'INVALID_INPUT', message: 'input.attachments is not allowed for this scenario' }
    }
    if (!Array.isArray(attachments)) {
      return { ok: false, code: 'INVALID_INPUT', message: 'input.attachments must be array' }
    }
  }

  return { ok: true }
}

function validateFeedbackPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'INVALID_INPUT', message: 'request body must be object' }
  }

  if (typeof payload.trace_id !== 'string' || !payload.trace_id.trim()) {
    return { ok: false, code: 'INVALID_INPUT', message: 'trace_id is required' }
  }

  const label = payload.feedback && payload.feedback.label
  const allowed = new Set(['correct', 'partially_correct', 'incorrect', 'irrelevant'])
  if (!allowed.has(label)) {
    return { ok: false, code: 'INVALID_INPUT', message: 'feedback.label is invalid' }
  }

  return { ok: true }
}

module.exports = {
  validateInferPayload,
  validateFeedbackPayload
}
