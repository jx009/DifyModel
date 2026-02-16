function isHttpUrl(value) {
  return /^https?:\/\//i.test(value)
}

function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function toDifyImageFile(item) {
  const fromString = asTrimmedString(item)
  if (fromString) {
    if (!isHttpUrl(fromString)) return null
    return {
      type: 'image',
      transfer_method: 'remote_url',
      url: fromString
    }
  }

  if (!item || typeof item !== 'object') return null

  const transferMethod = asTrimmedString(item.transfer_method)
  const itemType = asTrimmedString(item.type) || 'image'

  if (transferMethod === 'remote_url') {
    const url = asTrimmedString(item.url)
    if (!url || !isHttpUrl(url)) return null
    return {
      type: itemType,
      transfer_method: 'remote_url',
      url
    }
  }

  if (transferMethod === 'local_file') {
    const uploadFileId = asTrimmedString(item.upload_file_id || item.file_id || item.id)
    if (!uploadFileId) return null
    return {
      type: itemType,
      transfer_method: 'local_file',
      upload_file_id: uploadFileId
    }
  }

  const url = asTrimmedString(item.url)
  if (url && isHttpUrl(url)) {
    return {
      type: itemType,
      transfer_method: 'remote_url',
      url
    }
  }

  return null
}

function buildDifyImageFiles(input) {
  const images = Array.isArray(input?.images) ? input.images : []
  const files = []

  for (const item of images) {
    const file = toDifyImageFile(item)
    if (file) files.push(file)
  }

  return files
}

module.exports = {
  buildDifyImageFiles
}
