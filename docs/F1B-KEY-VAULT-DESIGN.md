# F-1b — Bóveda de claves nativa (claves privadas fuera de la memoria de JavaScript)

> Estado: **DISEÑO v1** (2026-09-25); fases 1a, 1b, 2 y 3 implementadas (F-1b completo) (§5 describe lo que se hizo de
> verdad en las exportaciones). Alcance aprobado por el dueño: **fases 1, 2 y 3**, mobile y
> desktop; UnifiedPush va después. Estado de cada fase: `docs/ROADMAP.md` → Hito 3 (fuente única).
> Reglas de oro: #1 (fail-closed), #5 (paridad), #8 (constant-time), #9 (zeroizar), #11 (un test por
> fix), #12 (mirar a los expertos).

## 0. Qué resuelve y qué no

F-1 movió el **cómputo** a libsodium nativo, pero las claves siguen viviendo en el heap de
JavaScript: el móvil pasa arrays de JS al C por puntero y el escritorio las manda del renderer al
proceso main por IPC. F-1b hace que las claves privadas **no existan nunca en JavaScript** (salvo
las exportaciones explícitas del §5): JS solo maneja *handles* opacos y *blobs* cifrados.

- **Cierra:** lectura de claves por código JS arbitrario del proceso (un XSS en el renderer del
  escritorio, una dependencia npm comprometida, un volcado del heap de Hermes/V8), y la permanencia
  de copias de claves en el heap hasta que las recoja el GC.
- **No cierra:** un atacante con ejecución nativa en el dispositivo (puede usar la bóveda como
  oráculo igual que usaría la app). Tampoco cambia el protocolo ni el wire.

Referencias: libsignal (claves y estado del ratchet en Rust, JS/Swift/Java solo con handles),
Session (libsession-util en C++), SimpleX (Haskell nativo; el cliente UI no ve claves).

## 1. Arquitectura: una bóveda con clave maestra que JS nunca ve

```
            JS (Hermes / renderer)                  Nativo (C core / proceso main)
  ┌──────────────────────────────────┐        ┌───────────────────────────────────────┐
  │ handle: number                    │  ops   │ tabla handle → clave (memoria guarded)│
  │ blob: base64 (clave cifrada)      │ ─────► │ clave de envoltura (KEK) en memoria   │
  │ guarda blobs donde hoy guarda     │ ◄───── │ KEK persistida por el SO:             │
  │ claves (SecureStore, SQLite)      │ result │   iOS Keychain / Android Keystore /   │
  └──────────────────────────────────┘        │   Electron safeStorage                │
                                              └───────────────────────────────────────┘
```

- **KEK (key-encryption key), 32 B:** la genera la bóveda la primera vez y la persiste el SO:
  - iOS: Keychain, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` (no va en backups de iCloud).
  - Android: una clave AES-256-GCM **no exportable** del Android Keystore (StrongBox si existe)
    cifra la KEK, guardada en los ficheros privados de la app.
  - Escritorio: `safeStorage` de Electron (DPAPI / Keychain / libsecret) en el proceso main.
  Una KEK por perfil (slot), para mantener el aislamiento de perfiles.
- **Blobs (v2):** toda clave que sale de la bóveda sale cifrada:
  `"AV" | 2 | tipo | nonce(24) | secretbox_KEK(tipo | slotlen | slot | clave)`. El tipo y el slot van
  **dentro** de la caja y se comprueban al cargar, así que un blob de otro perfil no carga y una
  cabecera con el tipo cambiado tampoco (la v1 solo llevaba el slot dentro; no llegó a ninguna
  versión publicada y ya no se acepta). JS guarda el blob, como `"vault1:" + base64`, donde antes
  guardaba la clave cruda, así que el almacenamiento no cambia de sitio.
- **Tipos:** `x25519` (identidad), `ed25519`, `mlkem768`, `secret32` y `x25519prekey` (SPK/OPK):
  hace todo lo que hace `x25519`, pero es un tipo propio para que el escritorio pueda exportar la SPK
  a los dispositivos vinculados del usuario sin pedir permiso, sin que eso sirva para sacar la clave
  de identidad (el tipo está autenticado en el blob, así que no se puede disfrazar una de otra).
- **Handles:** al cargar un blob, la bóveda lo descifra en memoria protegida (`sodium_malloc` +
  `sodium_mprotect_noaccess` entre usos) y devuelve un número. Las operaciones reciben el handle:
  `sign`, `scalarmult` (X25519), `box.open`/`box` con la clave de identidad, `mlkem.dec`, KDFs del
  ratchet. `destroy(handle)` borra la clave (`sodium_free`).
- **Fail-closed:** sin KEK (Keychain/Keystore no disponible) la bóveda no abre; la app no cae a
  claves en JS.

## 2. Plataformas

- **Móvil:** la bóveda es parte del núcleo C de `modules/aegis-sodium` (tabla de handles, memoria
  guarded, envoltura). Kotlin/Swift solo guardan y leen la KEK en el Keystore/Keychain. Las
  operaciones siguen siendo síncronas por JSI (como hoy), y las lentas, asíncronas.
- **Escritorio:** la bóveda vive en el proceso main (`sodium-native` con `sodium_malloc`, KEK en
  `safeStorage`); el renderer pide operaciones por el IPC que ya existe (`window.aegis.sodium`),
  ahora con handles en vez de claves. ML-KEM-768 (fase 2) corre en main (`main/crypto/sodium/
  mlkem.ts`): allí no llega el XSS del renderer, que es la amenaza del escritorio. Sigue siendo
  `@noble/post-quantum` (JavaScript), porque `sodium-native` 5.1 no expone el ML-KEM de libsodium.

## 3. Fases (cada una en PRs pequeñas, móvil y escritorio en la misma rama por fase)

| Fase | Qué sale de JS | Dónde se usa hoy |
|---|---|---|
| **1a** | Infraestructura: bóveda, KEK, blobs, handles, tests diferenciales | — |
| **1b** | Claves de identidad (X25519 + Ed25519) | `crypto/identity.ts`, `db/core.ts`, `store/identity.ts`, `store/profiles.ts`, firmas (prekeys, auth, TURN, grupos, canales, mailbox), sealed sender, llamadas |
| **2** | Prekeys: SPK, OPKs y PQSPK (ML-KEM); en escritorio también ML-KEM nativo en main | `crypto/signal/x3dh.ts`, `crypto/registration.ts`, `db/prekeys.ts` |
| **3** | Estado del Double Ratchet (root, chain y message keys, DHs, PQs) | `crypto/signal/ratchet.ts`, `socket/ratchetSerde.ts`, sesiones en SQLite |

**Fase 2 (hecha):** las prekeys se generan dentro de la bóveda (SPK/OPK como `x25519prekey`, PQSPK
como `mlkem768`) y se guardan como blobs en los mismos sitios que antes; las guardadas en crudo se
migran al reutilizarlas (`ensureDevicePreKeys`) o al abrirlas. El X3DH receptor las usa por handle.
El Double Ratchet del receptor arranca con su SPK/PQSPK como par inicial: el ratchet acepta ese
handle (`crypto/sodium/secretRef.ts`), lo consume en el primer paso y nunca lo persiste
(`ratchetSerde` se niega). La SPK que va a los dispositivos vinculados del usuario (vincular y
sincronización tras rotar) es una exportación explícita (§5). Las claves por turno del ratchet
salen de JS en la fase 3.

**Fase 3 (hecha):** en móvil el ratchet está portado al C core (`cpp/aegis_ratchet.c`); cada
llamada abre el estado sellado en memoria guarded, da el paso y sella un estado NUEVO (el viejo
queda intacto: un mensaje que no autentica no deja rastro). El estado es de tamaño fijo (9464 B,
`ratchetState.ts`) y se sella como blob de tipo 6, que nunca carga como clave. En escritorio el
mismo algoritmo (gemelo TS, `main/crypto/vault/ratchetCore.ts`) corre en el proceso main. JS guarda
`{v:3, slot, sealed, info}`; `info` son contadores y claves públicas. Las sesiones anteriores se
importan una vez al cargarlas. Límite honesto: la salida del X3DH (clave raíz) y la efímera del
emisor siguen pasando por JS una vez por sesión nueva y se ponen a cero en cuanto la bóveda tiene
la sesión (mover el X3DH entero a la bóveda sería una fase aparte). Diseño original: en móvil el ratchet se porta al C core; el estado se persiste como blob sellado con la
KEK (JS guarda el blob en SQLite, como hoy guarda el JSON). En escritorio el ratchet corre en el
proceso main (TypeScript sobre `sodium-native`), con el mismo estado sellado: las claves no llegan
al renderer. El formato del wire y el de los mensajes no cambia; los estados guardados se migran
una vez (ver §4). Paridad obligatoria: el test `f1-golden` (sesión híbrida persistida) debe seguir
descifrando en las dos plataformas.

## 4. Migración (sin forzar actualización ni perder sesiones)

Al primer arranque con la bóveda, cada clave cruda guardada hoy (SecureStore / SQLite) se lee **una
última vez** en JS, se importa (`vault.import(raw)` → blob + handle), el slot se sobrescribe con el
blob y la copia cruda se borra y se pone a cero. Idempotente y por slot: un fallo a mitad deja el
slot en crudo y se reintenta en el siguiente arranque. Es la única vez que la clave pasa por JS
después de F-1b, y se documenta como tal.

## 5. Exportaciones explícitas (las únicas salidas de la clave)

Implementado en 1b (2026-09-26) con **una sola** operación de salida, `vault.exportSecret` (C:
`aegis_vault_export`; desktop: `KeyVault.exportSecret`), que devuelve la clave cruda para que la
pantalla que la necesita la use y la ponga a cero:

- **Backup cifrado** (`screens/Backup.tsx`): la clave entra en el payload y se sella en el acto con
  la passphrase (Argon2id + secretbox). El formato del archivo no cambia.
- **Vincular dispositivo** (`screens/Devices.tsx`, solo móvil; el escritorio recibe, nunca envía):
  el paquete se cifra en el acto con `box` para la clave efímera del dispositivo nuevo. El formato
  no cambia.
- **Frase de recuperación (32 palabras):** se exporta solo mientras el usuario la tiene revelada
  (§7 decidió mantenerla).

Por qué no se construyen el backup y el paquete de vinculación dentro de la bóveda, como decía la
v1 de este diseño: la bóveda tendría que cifrar para una clave que elige JS, así que un JS
comprometido le pediría cifrar para una clave suya y obtendría lo mismo que con una exportación.
El control real está en **quién puede pedir la exportación**:

- **Escritorio:** el proceso main pregunta al usuario con un **diálogo nativo** antes de cada
  exportación (`main/ipc/vault.ts`, `confirmExport`); el renderer no puede verlo ni pulsarlo, así
  que un XSS puede *usar* las claves mientras la app corre, pero no sacarlas en silencio.
  Test: `main/crypto/vault/__tests__/ops.test.ts`.
- **Ambas plataformas:** un test de guarda (`crypto/__tests__/vaultExport.guard.test.ts`) exige que
  cada llamada a la exportación esté en una lista cerrada de ficheros.
- **Límite honesto:** mientras dura una exportación o una importación (restaurar backup, frase o
  vinculación, y la migración única del §4) la clave pasa por JS, también como cadena base64 que no
  se puede poner a cero. Es un acto puntual del usuario, no el estado normal de la app.
- **Modo pánico / borrado de perfil:** `vault.destroyProfile(slot)` borra la KEK del Keychain/
  Keystore: los blobs restantes quedan ilegibles aunque sobrevivan en disco (borrado criptográfico).

## 6. Pruebas

- **Diferenciales:** cada operación por handle da los mismos bytes que la operación con la clave
  cruda (libsodium / @noble como oráculo), en C (`differential.mjs`) y en el escritorio.
- **Golden:** `f1-golden` (vectores, sealed sender, ratchet clásico e híbrido) sigue pasando.
- **Guardas de código:** un test prohíbe `secretKey`/`signingSecretKey` crudos fuera de la bóveda y
  de las rutas de migración y exportación (como `crypto-imports.test.ts`).
- **Borrado:** tras `destroy`, el handle no opera; tras `destroyProfile`, los blobs no descifran.
- **E2E Android (Maestro):** registro, chat y bloqueo con PIN sobre la bóveda real.

## 7. Decisiones de producto abiertas

1. **Frase de recuperación:** mantenerla (exportación explícita) o sustituirla por el backup
   cifrado. Recomendación: mantenerla, porque es la única recuperación sin archivo.
2. **Android StrongBox** (chip seguro): usarlo si existe; en su ausencia, Keystore TEE. Sin
   impacto visible.
