# AegisLink - Backlog Fases 3 y 4

> **Re-sincronizado con el código 2026-06-29** (regla de oro "la doc no miente").
> El estado de abajo refleja el **CÓDIGO**, no el plan original. Varios ítems se
> realizaron con una arquitectura distinta a la planeada; se anota la divergencia.
> Cada ✅ lleva su evidencia (ruta/test) al lado.

## Fase 3 — Features grandes (sprints)
- [x] **G1**: Votación anónima en polls — **HECHO (vía E2EE, no server-side)**. El
  endpoint HTTP de voto y la tabla `poll_votes` se **eliminaron** (cero-metadatos):
  los votos viajan E2EE dentro del grupo, sin `voterHash` en el relay. Evidencia:
  `mobile/src/screens/Poll.tsx`, `mobile/src/store/polls.ts`, `server/src/db/client.ts:1756`.
- [x] **G3**: Backup cifrado real (AES + upload) — **HECHO**. `mobile/src/crypto/backup.ts`
  + `screens/Backup.tsx` + `store/backup.ts`; tests `crypto/__tests__/backup.test.ts`,
  `screens/__tests__/Backup.test.tsx`.
- [x] **I2**: Blob store cifrado para media (reemplaza base64 inline) — **HECHO** (rutas
  server + cliente móvil).
- [x] **I7**: Multicast E2EE real (reemplaza "MLS" falso) — **HECHO**. SenderKey sellado
  por miembro en `mobile/src/crypto/channelKey.ts`; test `channelKey.sealRecipients.test.ts`.
- [x] **C3**: Autenticar metadata de grupos (firma de admin) — **HECHO** (resolución
  dinámica de identidades de admins + integración asíncrona de firmas en `client.ts`).
- [x] **C2**: Borrado seguro de claves Ratchet post-uso — **HECHO** (auditado, LGTM qa-lead).

## Fase 4 — Work Enterprise real
- [ ] **P1**: Work Dashboard con datos reales del relay — **PENDIENTE** (solo strings i18n
  a 2026-06-29; no existe pantalla `WorkDashboard`).
- [ ] **G2**: UI de pagos Lightning — **PENDIENTE**. Prototipo aparcado en
  `mobile/src/_unused/web3/payments/LightningPayment.ts` + `_unused/screens/Subscription.tsx`
  (no cableado).
- [x] **G6**: Tor routing — **HECHO (vía Orbot/onion + mailbox)**. `routeViaTor` + `ONION_URL`
  + mailbox mode fail-closed en `mobile/src/config.ts`; transporte mailbox sellado (#171/#172).
  Ver `docs/FASE4-TOR-EMBEDDED-IMPL.md`, `docs/SEALED-SENDER-ARCHITECTURE.md`.
- [~] **W1**: DID en Onboarding/Profile — **EN CURSO** (rama `feat/w1-did-profile`). El
  `did:key` ya se deriva en Onboarding (`getOrCreateDID`, off-chain, opt-in); falta mostrarlo
  en Profile. Evidencia: `mobile/src/web3/did/`. El anclaje on-chain `did:ethr` queda como
  opt-in futuro documentado (rompería "anónimo por defecto, sin wallet").

---
## Notas de realización (divergencias del plan original)
* **G1** se resolvió **eliminando** el voto server-side en lugar de derivar `voterHash`
  server-side (lo que planteaba A-8 en `SECURITY-ROADMAP-2026-06.md`); la versión E2EE es
  estrictamente cero-metadatos y supera la propuesta original.
* **G6** se realizó con transporte mailbox + onion/Orbot, **no** con un SOCKS proxy embebido
  en el cliente Socket.IO.
* **C2 / I2 / C3** completadas y auditadas en fases previas.
