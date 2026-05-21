import { sha256 } from '@noble/hashes/sha256'
import { utf8ToBytes } from '@noble/hashes/utils'

export async function fetchPowChallenge(relayUrl) {
  const res = await fetch(`${trimSlash(relayUrl)}/identity/challenge`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
  })
  if (!res.ok) {
    throw new Error(`PoW challenge fetch failed: HTTP ${res.status}`)
  }
  const json = await res.json()
  if (!isPowChallenge(json)) {
    throw new Error('PoW challenge: malformed response')
  }
  return { challenge: json.challenge, difficulty: json.difficulty }
}

export async function solvePoW(challenge, difficulty) {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) {
    throw new Error('PoW: invalid difficulty')
  }
  const challengeBytes = utf8ToBytes(challenge)
  const batch = 2048
  let counter = 0
  while (true) {
    for (let i = 0; i < batch; i++) {
      const nonce = counter.toString(16)
      const nonceBytes = utf8ToBytes(nonce)
      const input = new Uint8Array(nonceBytes.length + challengeBytes.length)
      input.set(nonceBytes, 0)
      input.set(challengeBytes, nonceBytes.length)
      const digest = sha256(input)
      if (hasLeadingZeroBits(digest, difficulty)) {
        return nonce
      }
      counter++
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function hasLeadingZeroBits(digest, bits) {
  const fullBytes = Math.floor(bits / 8)
  const remBits = bits % 8
  for (let i = 0; i < fullBytes; i++) {
    if (digest[i] !== 0) return false
  }
  if (remBits === 0) return true
  const mask = 0xff << (8 - remBits)
  return (digest[fullBytes] & mask) === 0
}

export async function uploadIdentityAndPrekeys(
  identity,
  preKeySecrets,
  relayUrl,
  powChallenge,
  powNonce,
  oneTimePreKeysPublic,
  signedPreKeyPublic,
) {
  const base = trimSlash(relayUrl)

  const identityBody = {
    aegisId: identity.aegisId,
    publicKey: identity.publicKeyB64,
    signingPublicKey: identity.signingPublicKeyB64,
    powChallenge,
    powNonce,
  }

  let identityRes
  try {
    identityRes = await fetch(`${base}/identity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(identityBody),
    })
  } catch (e) {
    return { ok: false, error: `identity: network error: ${errMsg(e)}` }
  }

  if (identityRes.status !== 201 && identityRes.status !== 200) {
    const detail = await safeText(identityRes)
    return {
      ok: false,
      error: `identity: HTTP ${identityRes.status}${detail ? ` — ${detail}` : ''}`,
    }
  }

  if (containsAnySecret(signedPreKeyPublic, oneTimePreKeysPublic)) {
    return { ok: false, error: 'prekeys: refusing to upload — secret material detected' }
  }
  void preKeySecrets

  const prekeysBody = {
    aegisId: identity.aegisId,
    signedPreKey: signedPreKeyPublic,
    oneTimePreKeys: oneTimePreKeysPublic,
  }

  let prekeysRes
  try {
    prekeysRes = await fetch(`${base}/prekeys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(prekeysBody),
    })
  } catch (e) {
    return { ok: false, error: `prekeys: network error: ${errMsg(e)}` }
  }

  if (prekeysRes.status !== 201 && prekeysRes.status !== 200) {
    const detail = await safeText(prekeysRes)
    return {
      ok: false,
      error: `prekeys: HTTP ${prekeysRes.status}${detail ? ` — ${detail}` : ''}`,
    }
  }

  return { ok: true }
}

function trimSlash(url) {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function errMsg(e) {
  if (e instanceof Error) return e.message
  return 'unknown'
}

async function safeText(res) {
  try {
    const t = await res.text()
    return t.slice(0, 200)
  } catch {
    return ''
  }
}

function isPowChallenge(v) {
  if (typeof v !== 'object' || v === null) return false
  return typeof v.challenge === 'string' && typeof v.difficulty === 'number'
}

function containsAnySecret(spk, opks) {
  if ('secretKey' in spk || 'secretKeyB64' in spk) return true
  for (const opk of opks) {
    if ('secretKey' in opk || 'secretKeyB64' in opk) return true
  }
  return false
}
