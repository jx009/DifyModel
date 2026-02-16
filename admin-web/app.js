const state = {
  config: null,
  uploadedFileIds: [],
  eventSource: null
}

function $(id) {
  return document.getElementById(id)
}

function getToken() {
  return $('adminToken').value.trim()
}

function setStatus(text, isError = false) {
  const el = $('statusBar')
  el.textContent = text
  el.style.color = isError ? '#a52424' : '#0a7a44'
}

function toLines(value) {
  if (!Array.isArray(value)) return ''
  return value.join('\n')
}

function parseLines(value) {
  return String(value || '')
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
}

async function api(path, method = 'GET', body) {
  const token = getToken()
  if (!token) {
    throw new Error('请先填写 Admin Token')
  }
  const headers = {
    Authorization: `Bearer ${token}`
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json'
  }
  const response = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok || payload.success === false) {
    const message = payload?.error?.message || `HTTP ${response.status}`
    throw new Error(message)
  }
  return payload.data
}

function renderRoutes() {
  const wrap = $('routesList')
  const routes = state.config?.admin_config?.routes?.sub_type_routes || {}
  wrap.innerHTML = ''
  const keys = Object.keys(routes)
  keys.forEach((subType) => {
    const row = document.createElement('div')
    row.className = 'route-item'
    row.innerHTML = `<span class="key">${subType}</span><input data-subtype="${subType}" value="${routes[subType] || ''}" />`
    wrap.appendChild(row)
  })
}

function renderProfileOptions() {
  const profiles = state.config?.admin_config?.sub_type_profiles || {}
  const routes = state.config?.admin_config?.routes?.sub_type_routes || {}
  const set = new Set([...Object.keys(profiles), ...Object.keys(routes)])
  const select = $('profileSubType')
  select.innerHTML = ''
  ;[...set].sort().forEach((subType) => {
    const opt = document.createElement('option')
    opt.value = subType
    opt.textContent = subType
    select.appendChild(opt)
  })
}

function fillProfile(subType) {
  const profile = state.config?.admin_config?.sub_type_profiles?.[subType] || {}
  const hints = profile.classifier_hints || {}
  const guidance = profile.workflow_guidance || {}
  $('profileDisplayName').value = profile.display_name || ''
  $('profileWorkflowId').value = profile.workflow_id || ''
  $('profileKeywords').value = toLines(hints.keywords)
  $('requireImages').checked = Boolean(hints.require_images)
  $('preferImages').checked = Boolean(hints.prefer_images)
  $('imageOnlyDefault').checked = Boolean(hints.image_only_default)
  $('solvingSteps').value = toLines(guidance.solving_steps)
  $('promptFocus').value = toLines(guidance.prompt_focus)
  $('answerConstraints').value = toLines(guidance.answer_constraints)
}

function renderWorkflowOptions() {
  const view = state.config?.admin_config?.workflow_keys || {}
  const routes = state.config?.admin_config?.routes?.sub_type_routes || {}
  const workflows = new Set([...Object.keys(view), ...Object.values(routes)])
  const select = $('workflowIdSelect')
  select.innerHTML = ''
  ;[...workflows].sort().forEach((id) => {
    const opt = document.createElement('option')
    opt.value = id
    opt.textContent = id
    select.appendChild(opt)
  })
  if (select.value) {
    fillWorkflow(select.value)
  } else if (select.options.length > 0) {
    select.value = select.options[0].value
    fillWorkflow(select.value)
  }
}

async function refreshHistory() {
  const data = await api('/admin/api/history')
  const list = data.snapshots || []
  const wrap = $('historyList')
  wrap.innerHTML = ''
  list.forEach((item) => {
    const row = document.createElement('div')
    row.className = 'history-item'
    const left = document.createElement('div')
    left.innerHTML = `<div>${item.id}</div><div class="history-meta">${item.snapshot_at || '-'} | ${item.reason || '-'} | ${item.updated_by || '-'}</div>`
    const btn = document.createElement('button')
    btn.className = 'btn'
    btn.textContent = '回滚'
    btn.addEventListener('click', () => rollbackSnapshot(item.id))
    row.appendChild(left)
    row.appendChild(btn)
    wrap.appendChild(row)
  })
}

async function rollbackSnapshot(snapshotId) {
  if (!snapshotId) throw new Error('snapshot id 为空')
  await api(`/admin/api/history/${encodeURIComponent(snapshotId)}/rollback`, 'POST', {})
  await refreshConfig(false)
  await refreshHistory()
  setStatus(`已回滚到 ${snapshotId}`)
}

function fillWorkflow(workflowId) {
  const keyView = state.config?.admin_config?.workflow_keys?.[workflowId] || {}
  const prompt = state.config?.admin_config?.workflow_prompts?.[workflowId] || {}
  $('workflowKeyMasked').value = keyView.masked || ''
  $('workflowPromptInput').value = prompt.content || ''
}

async function refreshConfig(showStatus = true) {
  try {
    const data = await api('/admin/api/config')
    state.config = data
    const routes = data.admin_config.routes || {}
    $('mainWorkflowId').value = routes.main_workflow_id || ''
    $('fallbackWorkflowId').value = routes.fallback_workflow_id || ''
    renderRoutes()
    renderProfileOptions()
    if ($('profileSubType').value) fillProfile($('profileSubType').value)
    renderWorkflowOptions()
    await refreshHistory()
    if (showStatus) setStatus('配置已刷新')
  } catch (error) {
    setStatus(`加载失败: ${error.message}`, true)
  }
}

async function saveRoutes() {
  const inputs = document.querySelectorAll('#routesList input[data-subtype]')
  const subTypeRoutes = {}
  inputs.forEach((el) => {
    const subType = el.getAttribute('data-subtype')
    const value = el.value.trim()
    if (subType && value) subTypeRoutes[subType] = value
  })
  await api('/admin/api/routes', 'PUT', {
    routes: {
      main_workflow_id: $('mainWorkflowId').value.trim(),
      fallback_workflow_id: $('fallbackWorkflowId').value.trim(),
      sub_type_routes: subTypeRoutes
    }
  })
  await refreshConfig(false)
  setStatus('路由配置已保存')
}

async function saveProfile() {
  const subType = $('profileSubType').value
  if (!subType) throw new Error('请选择 subType')
  await api(`/admin/api/subtypes/${encodeURIComponent(subType)}/profile`, 'PUT', {
    display_name: $('profileDisplayName').value.trim(),
    workflow_id: $('profileWorkflowId').value.trim(),
    classifier_hints: {
      keywords: parseLines($('profileKeywords').value),
      require_images: $('requireImages').checked,
      prefer_images: $('preferImages').checked,
      image_only_default: $('imageOnlyDefault').checked
    },
    workflow_guidance: {
      solving_steps: parseLines($('solvingSteps').value),
      prompt_focus: parseLines($('promptFocus').value),
      answer_constraints: parseLines($('answerConstraints').value)
    }
  })
  await refreshConfig(false)
  setStatus(`SubType ${subType} 策略已保存`)
}

async function saveWorkflowKey() {
  const workflowId = $('workflowIdSelect').value
  const key = $('workflowKeyInput').value.trim()
  if (!workflowId) throw new Error('请选择 workflow_id')
  if (!key) throw new Error('请输入新 key')
  await api(`/admin/api/workflows/${encodeURIComponent(workflowId)}/key`, 'PUT', { key })
  $('workflowKeyInput').value = ''
  await refreshConfig(false)
  setStatus(`Workflow ${workflowId} key 已更新`)
}

async function saveWorkflowPrompt() {
  const workflowId = $('workflowIdSelect').value
  const content = $('workflowPromptInput').value
  if (!workflowId) throw new Error('请选择 workflow_id')
  if (!content.trim()) throw new Error('prompt 不能为空')
  await api(`/admin/api/workflows/${encodeURIComponent(workflowId)}/prompt`, 'PUT', { content })
  await refreshConfig(false)
  setStatus(`Workflow ${workflowId} prompt 已更新`)
}

async function uploadImage() {
  const file = $('imageFileInput').files && $('imageFileInput').files[0]
  if (!file) throw new Error('请先选择图片')
  const reader = new FileReader()
  const result = await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })

  $('uploadStatus').textContent = '上传中...'
  const data = await api('/admin/api/test/upload', 'POST', {
    base64: result,
    filename: file.name,
    content_type: file.type
  })
  state.uploadedFileIds.push(data.file_id)
  $('testUploadFileIds').value = state.uploadedFileIds.join(',')
  $('uploadStatus').textContent = `已上传: ${data.file_id}`
  setStatus('图片上传成功')
}

async function runTest() {
  const uploadFileIds = $('testUploadFileIds').value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
  const payload = {
    scenario_id: $('testScenarioId').value.trim() || 'exam_qa',
    workflow_id: $('testWorkflowId').value.trim() || undefined,
    sub_type: $('testSubType').value.trim() || undefined,
    input: {
      text: $('testText').value.trim(),
      upload_file_ids: uploadFileIds
    },
    options: {
      quality_tier: $('testQualityTier').value || undefined
    }
  }
  const data = await api('/admin/api/test/run', 'POST', payload)
  $('testResult').value = JSON.stringify(data, null, 2)
  $('sseTraceId').value = data.trace_id || ''
  setStatus(`测试完成 trace_id=${data.trace_id || '-'}`)
}

function appendSseLine(line) {
  const box = $('sseEvents')
  box.value += `${line}\n`
  box.scrollTop = box.scrollHeight
}

function closeSse() {
  if (state.eventSource) {
    state.eventSource.close()
    state.eventSource = null
  }
}

function startSseListen() {
  const traceId = $('sseTraceId').value.trim()
  const token = getToken()
  if (!traceId) throw new Error('请输入 trace_id')
  if (!token) throw new Error('请先填写 token')
  closeSse()
  $('sseEvents').value = ''
  const url = `/admin/api/test/stream/${encodeURIComponent(traceId)}?admin_token=${encodeURIComponent(token)}`
  const source = new EventSource(url)
  state.eventSource = source
  appendSseLine(`[connect] ${traceId}`)
  source.onmessage = (event) => {
    appendSseLine(`[message] ${event.data}`)
  }
  ;['connected', 'progress', 'completed', 'error', 'heartbeat'].forEach((name) => {
    source.addEventListener(name, (event) => {
      appendSseLine(`[${name}] ${event.data}`)
      if (name === 'completed' || name === 'error') {
        closeSse()
      }
    })
  })
  source.onerror = () => {
    appendSseLine('[error] stream closed')
    closeSse()
  }
}

function bindTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'))
      document.querySelectorAll('.panel').forEach((x) => x.classList.remove('active'))
      tab.classList.add('active')
      const name = tab.getAttribute('data-tab')
      $(`tab-${name}`).classList.add('active')
    })
  })
}

function bindActions() {
  $('saveTokenBtn').addEventListener('click', async () => {
    localStorage.setItem('admin_token', $('adminToken').value.trim())
    await refreshConfig()
  })
  $('saveRoutesBtn').addEventListener('click', () => saveRoutes().catch((e) => setStatus(e.message, true)))
  $('profileSubType').addEventListener('change', () => fillProfile($('profileSubType').value))
  $('saveProfileBtn').addEventListener('click', () => saveProfile().catch((e) => setStatus(e.message, true)))
  $('workflowIdSelect').addEventListener('change', () => fillWorkflow($('workflowIdSelect').value))
  $('saveWorkflowKeyBtn').addEventListener('click', () => saveWorkflowKey().catch((e) => setStatus(e.message, true)))
  $('saveWorkflowPromptBtn').addEventListener('click', () => saveWorkflowPrompt().catch((e) => setStatus(e.message, true)))
  $('refreshHistoryBtn').addEventListener('click', () => refreshHistory().catch((e) => setStatus(e.message, true)))
  $('uploadImageBtn').addEventListener('click', () => uploadImage().catch((e) => setStatus(e.message, true)))
  $('runTestBtn').addEventListener('click', () => runTest().catch((e) => setStatus(e.message, true)))
  $('startSseBtn').addEventListener('click', () => startSseListen().catch((e) => setStatus(e.message, true)))
}

function boot() {
  const savedToken = localStorage.getItem('admin_token')
  if (savedToken) {
    $('adminToken').value = savedToken
  }
  bindTabs()
  bindActions()
  if (savedToken) {
    refreshConfig()
  } else {
    setStatus('请先输入 Admin Token')
  }
}

boot()
