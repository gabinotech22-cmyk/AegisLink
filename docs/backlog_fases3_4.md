# AegisLink - Backlog Fases 3 y 4

## Fase 3 — Features grandes (sprints)
- [ ] **G1**: Sistema de votación anónima en polls (mobile-lead + backend-lead)
- [ ] **G3**: Backup cifrado real (AES + upload) (crypto-lead + mobile-lead)
- [x] **I2**: Blob store cifrado para media (reemplaza base64 inline) (backend-lead + mobile-lead)
- [ ] **I7**: Multicast E2EE real (reemplazar "MLS" falso) (crypto-lead)
- [x] **C3**: Autenticar metadata de grupos (firma de admin) (crypto-lead + backend-lead)
- [x] **C2**: Borrado seguro de claves Ratchet post-uso (crypto-lead)

## Fase 4 — Work Enterprise real
- [ ] **P1**: Work Dashboard con datos reales del relay (backend-lead + mobile-lead)
- [ ] **G2**: UI de pagos Lightning (mobile-lead)
- [ ] **G6**: Tor routing (SOCKS proxy en socket client) (backend-lead)
- [ ] **W1**: DID on-chain en Onboarding/Profile (web3-lead + mobile-lead)

---
## Progreso Actual
* **C2: Borrado seguro de claves Ratchet post-uso**: Completada y auditada (LGTM de qa-lead).
* **I2: Blob store cifrado para media**: Completada (Rutas server y cliente móvil).
* **C3: Autenticar metadata de grupos**: Completada (Resolución dinámica de identidades de administradores terceros e integración asíncrona de firmas en client.ts).
