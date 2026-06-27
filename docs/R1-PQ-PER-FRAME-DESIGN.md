# R1 — Ratchet híbrido PQ (ML-KEM-768 renovado por cadena)

> Estado: **DISEÑO v2** (jun-25-2026). Rama `feat/r1-pq-per-frame`.
> Origen: paridad con Zerion "Mode 3" + Signal Triple Ratchet/SPQR
> (ver [[project_competitor_zerion]], [[project_competitor_session]]).
> Reglas de oro: #5 (paridad mobile↔desktop), #8 (constant-time),
> #9 (zeroizar intermedios), #11 (un test por fix), #12 (mirar a los expertos).

## 0. Decisión de diseño (CEO, jun-25)

Tras leer Signal SPQR: el experto **NO** manda el ciphertext ML-KEM completo en
cada frame (Zerion "Mode 3-Full") — lo trocea con erasure coding y avanza la
frescura PQ **por época**, porque el coste de wire del per-frame no compensa el
delta de seguridad (un atacante cuántico que rompe ML-KEM es capacidad de
futuro lejano; 1 vs N mensajes de ventana por época es marginal).

**Elegido: per-época, enfoque por fases.**
- **v1 (esta spec):** PQ mezclado en la **frontera de cadena** (cada giro del
  DH ratchet), EK/CT completos en el mensaje de giro, **sin chunking ni erasure
  coding**. Nuestro transporte (mailbox sobre Tor) es **ordenado**, así que no
  necesitamos la robustez de SPQR ante reordenamiento arbitrario.
- **Forward-compatible:** el header lleva un campo `pqMode` desde v1, para que
  añadir chunking/erasure-coding (o per-frame) más tarde sea enchufar, no
  reescribir el wire.

Esto cierra la MISMA brecha de seguridad que el per-frame (la sesión deja de
estar protegida solo por X25519 tras el handshake) con una fracción del coste y
del código en el núcleo del ratchet.

## 1. Problema

Hoy nuestro PQXDH ([[project_pqxdh_hybrid]], `x3dh.ts`) inyecta ML-KEM-768
**solo en el handshake X3DH inicial**. Después, el Double Ratchet
(`ratchet.ts`) avanza con **solo X25519 + KDFs simétricos**. Un atacante que
cosecha hoy y rompe X25519 con un cuántico a futuro recupera **todo el historial
posterior al handshake**. R1 renueva la frescura PQ en cada giro de cadena: el
material de clave nuevo exige romper X25519 **Y** ML-KEM-768 una y otra vez.

## 2. Benchmark que lo respalda

`_scratch/bench-mlkem.mjs` (Node v24, `@noble/post-quantum` `ml_kem768`, ya en
`mobile/node_modules`):

| Op | Node | Hermes est. (×60, [[project_hermes_kdf_costs]]) |
|---|---|---|
| `keygen` | 0.41 ms | ~24 ms |
| `encapsulate` | 0.43 ms | ~26 ms |
| `decapsulate` | 0.51 ms | ~30 ms |

Con mezcla **por cadena** (no por frame), estas ops ocurren **una vez por giro
de ratchet**, no por mensaje → coste despreciable. El benchmark per-frame
(~30 ms/mensaje) ya era tolerable; por-cadena lo vuelve irrelevante.

## 3. Modelo criptográfico — ratchet híbrido DH+KEM

KEM es asimétrico: `encapsulate(pk) → (ct, ss)`, `decapsulate(ct, sk) → ss`.

En paralelo al par X25519 de ratchet, cada parte mantiene un par KEM de cadena:
- `PQs = {publicKey(1184B), secretKey(2400B)}` — nuestro par KEM actual (análogo a `DHs`).
- `PQr` — la public key KEM del peer (análogo a `DHr`), aprendida de su header de giro.

### Giro de cadena (`dhRatchet`) — único punto donde entra PQ
Cuando recibimos un header con nueva `ratchetKey` (giro):
1. Como hoy: `DH(DHs.sec, header.ratchetKey)` → avanza root/CKr.
2. **Nuevo:** `ss_r = decapsulate(header.pqCt, PQs.secretKey)` — el peer
   encapsuló contra NUESTRA `PQs.publicKey` anterior.
3. Generamos `DHs` nuevo **y** `PQs` nuevo (`ml_kem768.keygen()`).
4. **Nuevo:** `{ct, ss_s} = encapsulate(PQr)` contra la PQ pubkey del peer.
5. La root key mezcla AMBOS secretos: `kdfRootHybrid(RK, dhOut, ss)`:
   `combined = dhOut ‖ ss`, `HKDF(combined, salt=RK, info="AegisLinkRootPQ")`.
6. Nuestro próximo header de giro lleva `ratchetKey=DHs.pub`, `pqRatchetKey=PQs.pub` (EK), `pqCt=ct`.

### Mensajes dentro de la cadena (`ratchetEncrypt`/`Decrypt`)
**Sin cambios.** `kdfChain` simétrico como hoy. El PQ ya quedó mezclado en la
root key en el giro; toda la cadena hereda esa frescura PQ vía CKs/CKr.

### Header
`{ ratchetKey, n, pn }` →
`+ pqMode: uint8` (1=hybrid-per-chain v1; reservado: 2=chunked, 3=per-frame),
`+ pqRatchetKey?: Uint8Array(1184)` (EK, solo en mensaje de giro),
`+ pqCt?: Uint8Array(1088)` (CT, solo en mensaje de giro).
Mensajes intra-cadena: `pqMode=1`, sin `pqRatchetKey`/`pqCt`.

### Por qué §5 (el problema difícil del per-frame) desaparece
Como el PQ se mezcla en la root key en el giro y NO por mensaje, `MKSKIPPED`
sigue guardando **solo claves simétricas** (idéntico a hoy). No hay que retener
secretos KEM por mensaje saltado: una vez girada la cadena, `ss` ya está fundido
en la root y se zeroiza. Out-of-order intra-cadena funciona exactamente como el
Double Ratchet actual.

## 4. Cambios por archivo (paridad mobile↔desktop, regla #5)

Gemelos: `mobile/src/crypto/signal/ratchet.ts` y
`desktop/src/renderer/crypto/signal/ratchet.ts` (+ serde + tests de cada uno).

- **`RatchetState`**: `+ PQs: {publicKey;secretKey} | null`, `+ PQr: Uint8Array | null`.
  `initRatchet`: Bob siembra `PQs` desde el PQSPK ya usado en PQXDH (para que el
  primer giro cuadre); Alice aprende `PQr` del primer header de Bob. Sesión v1
  legacy ⇒ ambos `null` ⇒ comportamiento clásico (interop, regla #5).
- **header**: `pqMode` + `pqRatchetKey?` + `pqCt?`.
- **`kdfRoot` → `kdfRootHybrid`**: acepta `ss?` opcional; sin `ss` = byte-idéntico
  a hoy (v1 legacy). Con `ss` = label `"AegisLinkRootPQ"`.
- **`dhRatchet`**: encaps/decaps + keygen PQ, dentro del mismo paso transaccional.
- **`cloneState`/`commitState`/`discardState`**: copiar/zeroizar `PQs.secretKey`, `PQr`.
- **`ratchetSerde.ts`** (mobile+desktop gemelos): revivir `PQs`/`PQr` (reusar
  `reviveBytes`); versionar el blob de sesión para migrar sesiones v1 en disco.
- **wire/transporte**: `pqRatchetKey`/`pqCt` viajan DENTRO del mensaje sellado
  (igual que `pqCtB64` de PQXDH). **El relay NO cambia** (regla #2).

### Anti-downgrade (regla #1, #5)
Sesión establecida v2 (PQXDH) ⇒ el mensaje de giro **debe** traer `pqRatchetKey`
+ `pqCt` con `pqMode>=1`; si falta en una sesión PQ ⇒ **throw**, no se degrada en
silencio. Sesiones v1 legacy siguen clásicas.

## 5. Referencias (regla #12 — ya consultadas)
- **Signal SPQR / Triple Ratchet (2025)** — fuente de la decisión per-época y del
  rechazo al per-frame por coste de wire. Su erasure coding es el camino de la
  fase 2 SI Tor exige robustez ante reorden.
- **Zerion `docs/TRIPLE_RATCHET_DESIGN.md`** — su Mode 3 per-epoch (lo que
  replicamos en espíritu) y Mode 3-Full (lo que descartamos).
- **PQXDH propio (`x3dh.ts`)** — el patrón de mezcla híbrida (`dhOut ‖ ss` →
  HKDF con label v2) ya está probado en producción; R1 lo extiende al ratchet.

## 6. Tests (regla #11)
- KAT cross-plataforma: semilla fija (root + DH + PQ keypairs) → mismo ciphertext
  mobile↔desktop tras 1 giro híbrido. Gemelo del KAT de PQXDH.
- Anti-downgrade: giro sin `pqCt` en sesión PQ ⇒ throw.
- Multi-giro: A→B→A con varias vueltas, todas desencriptan; verificar que la root
  cambia por la mezcla PQ (no solo X25519).
- Out-of-order intra-cadena: frames 0,2,1 ⇒ los 3 desencriptan (regresión Double Ratchet).
- Zeroización: `PQs.secretKey`, `ss_r`, `ss_s` a cero tras commit/discard.
- Serde: round-trip con PQs/PQr; revival de sesión v1 legacy ⇒ clásico.

## 7. Orden de implementación
1. `RatchetState` + header + `kdfRootHybrid` + `dhRatchet` híbrido (mobile).
2. Serde + versionado + clone/commit/discard (mobile).
3. Cablear transporte: copiar EK/CT al header sellado en el mensaje de giro (mobile).
4. Portar idéntico a desktop (misma rama).
5. Tests §6 en ambos.
6. KAT + APK release 2-device contra prod ([[feedback_no_debug_apk_expo_tests]]).
