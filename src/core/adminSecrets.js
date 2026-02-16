const crypto = require('crypto')

const ALGO = 'aes-256-gcm'

function getSecret() {
  const raw = String(process.env.ADMIN_KEY_ENCRYPTION_SECRET || '')
  if (!raw.trim()) return null
  return crypto.createHash('sha256').update(raw).digest()
}

function encryptSecret(plainText) {
  const secret = getSecret()
  if (!secret) return null
  if (typeof plainText !== 'string' || !plainText) return null

  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv(ALGO, secret, iv)
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`
}

function decryptSecret(cipherText) {
  const secret = getSecret()
  if (!secret) return null
  if (typeof cipherText !== 'string' || !cipherText.trim()) return null

  const parts = cipherText.split('.')
  if (parts.length !== 3) return null

  try {
    const iv = Buffer.from(parts[0], 'base64')
    const tag = Buffer.from(parts[1], 'base64')
    const encrypted = Buffer.from(parts[2], 'base64')
    const decipher = crypto.createDecipheriv(ALGO, secret, iv)
    decipher.setAuthTag(tag)
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()])
    return plain.toString('utf8')
  } catch (_error) {
    return null
  }
}

module.exports = {
  encryptSecret,
  decryptSecret
}
