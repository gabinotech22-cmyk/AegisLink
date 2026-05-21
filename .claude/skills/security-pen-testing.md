---
name: security-pen-testing
description: Auditoría de seguridad y pen-testing para AegisLink — threat modeling STRIDE, OWASP Mobile Top 10, análisis de flujos E2EE, detección de fugas de metadatos, y checklist de seguridad por capa. Aplica en revisiones de código del relay, módulos crypto, manejo de claves, y endpoints HTTP.
source: https://github.com/alirezarezvani/claude-skills (engineering-team/security-pen-testing + senior-security)
---

# Security Pen-Testing & Auditoría — AegisLink

> Skill de seguridad ofensiva/defensiva adaptado a los principios de privacidad de AegisLink.

## Modelo de amenaza (STRIDE) por componente

### Relay (server/)

| Amenaza | Vector | Mitigación en AegisLink |
|---------|--------|-------------------------|
| **S**poofing | Suplantación de aegisId | Challenge-response Ed25519 — solo el dueño de la clave puede responder |
| **T**ampering | Modificar envelopes en tránsito | TLS + ciphertext firmado por el remitente (NaCl secretbox) |
| **R**epudiation | Negar envío de mensaje | Sealed sender — el relay NO conoce al remitente |
| **I**nformation Disclosure | Correlación sender/receiver | Forward ciego — el relay solo conoce el `to`, nunca el `from` |
| **D**oS | Flood de envelopes | Rate limiting por aegisId (120 env/min) |
| **E**levation of Privilege | Socket sin autenticar | Timeout de auth: 5s — sockets no autenticados se desconectan |

### Cliente móvil (mobile/)

| Amenaza | Vector | Mitigación |
|---------|--------|-----------|
| Extracción de clave privada | Root/jailbreak | `WHEN_UNLOCKED_THIS_DEVICE_ONLY` en SecureStore |
| Screenshot de mensajes | Malware / screensharing | `expo-screen-capture` preventScreenCaptureAsync |
| Backup a la nube de claves | iCloud/Google Drive | SecureStore excluido de backups automáticos |
| Replay de mensajes | Reutilizar envelope capturado | Message ID único (UUID v4) + Double Ratchet stateful |

---

## OWASP Mobile Top 10 — Checklist AegisLink

### M1 — Improper Credential Usage
```typescript
// ❌ VULNERABLE
const SECRET = 'hardcoded-relay-secret'; // en código fuente

// ✅ CORRECTO
const SECRET = process.env.RELAY_SECRET; // variable de entorno, nunca en repo
```

### M2 — Inadequate Supply Chain Security
- Verificar `npm audit` antes de cada release
- Pinear versiones de `tweetnacl`, `@noble/hashes`, `expo-secure-store`
- No aceptar PRs que cambien estas deps sin revisión de crypto-lead

### M4 — Insufficient Input/Output Validation
```typescript
// ❌ VULNERABLE — sin validación
socket.on('envelope', (data) => relay(data));

// ✅ CORRECTO — Zod antes de procesar
const result = EnvelopeSchema.safeParse(data);
if (!result.success) { socket.emit('error', { code: 'INVALID_PAYLOAD' }); return; }
```

### M8 — Security Misconfiguration
```typescript
// ❌ VULNERABLE — stack trace en producción
res.status(500).json({ error: err.message, stack: err.stack });

// ✅ CORRECTO
res.status(500).json({ error: 'SERVER_ERROR' });
```

### M9 — Insecure Data Storage
```typescript
// ❌ VULNERABLE — clave en AsyncStorage (no cifrado)
AsyncStorage.setItem('identityKey', privateKeyBase64);

// ✅ CORRECTO — SecureStore con accesibilidad máxima
SecureStore.setItemAsync('identityKey', privateKeyBase64, {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
});
```

---

## Análisis de flujos E2EE — Puntos de revisión

### Flujo X3DH (establecimiento de sesión)
```
Revisar:
1. ¿La Identity Key nunca sale de SecureStore sin wrapear?
2. ¿Los One-Time Prekeys se borran del servidor tras el primer uso?
3. ¿La Signed Prekey rota cada 7 días como mínimo?
4. ¿El bundle de prekeys en /identity no incluye la clave privada?
```

### Flujo Double Ratchet (mensajes)
```
Revisar:
1. ¿El estado del ratchet se persiste en SQLite cifrado, no en AsyncStorage?
2. ¿Los message keys usados se eliminan inmediatamente (forward secrecy)?
3. ¿El campo `from` nunca va en el wire (sealed sender)?
4. ¿Los mensajes efímeros se borran del SQLite local al expirar?
```

### Flujo de push notifications
```
Revisar:
1. ¿El payload de push solo contiene { kind: 'wakeup' }?
2. ¿No se incluye sender, recipient, ni contenido?
3. ¿El token push se actualiza al cambiar (sin retener el viejo)?
```

---

## Detección de fugas de metadatos

### Patrones a detectar con grep en el relay

```bash
# Buscar logs de IP (PROHIBIDO en producción)
grep -r "remoteAddress\|x-forwarded-for\|req\.ip\|socket\.handshake\.address" server/src/

# Buscar logs de pares de comunicación (PROHIBIDO)
grep -r "console\.log\|logger\." server/src/ | grep -i "from\|sender\|aegisId"

# Verificar que el push payload no incluye contenido
grep -r "sendExpoPush\|push" server/src/ -A 5 | grep -v "wakeup"
```

### Patrones a detectar en el cliente

```bash
# Claves fuera de SecureStore
grep -r "AsyncStorage" mobile/src/crypto/
grep -r "localStorage\|sessionStorage" mobile/src/

# Logs de contenido de mensajes
grep -r "console\." mobile/src/screens/ | grep -i "message\|text\|content"
```

---

## Severidades y SLA de fix

| Severidad | Ejemplo en AegisLink | SLA |
|-----------|---------------------|-----|
| **Critical** | Clave privada accesible sin auth biométrica | Fix antes de siguiente build |
| **High** | Log de pares sender/receiver en relay | Fix en el mismo sprint |
| **Medium** | Rate limiting ausente en un evento socket | Fix en 2 sprints |
| **Low** | Timeout de auth > 5s | Fix en backlog |
| **Info** | Dependencia con vulnerabilidad sin CVE activo | Monitorear |

---

## Comandos de auditoría rápida

```bash
# Auditoría de dependencias
npm audit --audit-level=moderate

# Buscar secretos hardcodeados
grep -rE "(password|secret|key|token)\s*=\s*['\"][^'\"]{8,}" --include="*.ts" .

# Verificar que no hay logs de IPs
grep -rn "req\.ip\|remoteAddress\|x-forwarded" server/src/

# Verificar cobertura de validación Zod
grep -rn "socket\.on(" server/src/ | wc -l
grep -rn "safeParse\|\.parse(" server/src/ | wc -l
# Los dos números deben ser iguales (cada handler tiene su Zod)
```

---

## Criterios de aprobación de PR (qa-lead)

- [ ] Sin hallazgos Critical ni High sin fix documentado
- [ ] `npm audit` sin vulnerabilidades High/Critical
- [ ] Ningún log de IP ni par de comunicación en relay
- [ ] Todas las claves en SecureStore con `WHEN_UNLOCKED_THIS_DEVICE_ONLY`
- [ ] Push payload verificado como `{ kind: 'wakeup' }` únicamente
- [ ] Todos los handlers socket con validación Zod
- [ ] Errores HTTP sin stack trace ni detalles internos
