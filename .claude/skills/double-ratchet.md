---
name: double-ratchet
description: Skill avanzada de criptografía E2EE para AegisLink. Detalla la gestión de claves, X3DH, Double Ratchet y derivación KDF segura con TweetNaCl y @noble/hashes.
---

# Skill de Criptografía Avanzada — Double Ratchet & X3DH

Esta skill proporciona especificaciones precisas para la implementación, auditoría y optimización del protocolo criptográfico Double Ratchet y el intercambio de claves X3DH (Extended Triple Diffie-Hellman) en AegisLink.

## 1. Protocolo X3DH (Extended Triple Diffie-Hellman)
X3DH establece una clave secreta compartida entre dos partes que se autentican mutuamente utilizando sus claves de identidad, incluso si una de las partes está offline en el momento de la inicialización.

### Parámetros de Clave
- **IK_A / IK_B**: Claves de Identidad (Identity Keys) de las partes A y B (X25519).
- **EK_A**: Clave efímera de A (Ephemeral Key, X25519).
- **SPK_B**: Clave pre-firmada de B (Signed Prekey, X25519).
- **OPK_B**: Clave de un solo uso de B (One-Time Prekey, X25519, opcional).

### Derivación de la Clave Maestra (Master Secret)
Se calculan los siguientes DH (Diffie-Hellman):
- $DH_1 = DH(IK_A, SPK_B)$
- $DH_2 = DH(EK_A, IK_B)$
- $DH_3 = DH(EK_A, SPK_B)$
- $DH_4 = DH(EK_A, OPK_B)$ (si OPK_B está presente)

La clave maestra se deriva mediante HKDF con SHA-256:
```typescript
const info = 'AegisLink-X3DH-MasterSecret';
const salt = new Uint8Array(32); // Todo ceros o sal predefinida
const inputKeyMaterial = concatBytes(DH1, DH2, DH3, DH4?);
const masterSecret = hkdf(sha256, inputKeyMaterial, salt, info, 32);
```

### Verificación de Firma SPK
La firma de la clave SPK_B debe verificarse antes de realizar el intercambio de claves.
```typescript
import nacl from 'tweetnacl';
// Birma de SPK_B firmada con la clave de identidad Ed25519 de B
const isValid = nacl.sign.detached.verify(spkBytes, spkSigBytes, identityPubKeyBytes);
if (!isValid) {
  throw new Error('SPK signature verification failed');
}
```

---

## 2. Protocolo Double Ratchet
El Double Ratchet combina una cadena KDF basada en hash (ratchet simétrico) y un intercambio de claves Diffie-Hellman continuo (ratchet DH) para proporcionar **Forward Secrecy** y **Break-in Recovery**.

### Estructura de Cadenas (KDF Chains)
Cada sesión mantiene tres cadenas KDF:
1. **Root Chain**: Se actualiza con cada paso DH (ratchet DH) utilizando la clave de la raíz anterior y el nuevo resultado DH para derivar una nueva clave de raíz y una nueva clave de cadena de recepción/envío.
2. **Sending Chain**: Se actualiza con cada mensaje enviado utilizando la clave de cadena anterior para derivar la clave de mensaje (MK) y la siguiente clave de cadena.
3. **Receiving Chain**: Se actualiza de manera similar a la de envío con cada mensaje recibido.

### Algoritmo de Derivación de Clave de Mensaje (Symmetric Step)
```typescript
// Para cada paso simétrico en una cadena:
// Clave de Mensaje (MK) = HMAC-SHA256(ChainKey, [0x01])
// Siguiente Clave de Cadena = HMAC-SHA256(ChainKey, [0x02])
```

### Eliminación Segura de Claves Post-Uso (Zero-leakage)
Para garantizar Forward Secrecy real, las claves de mensaje (MK) deben ser destruidas de la memoria RAM inmediatamente después de descifrar o cifrar el mensaje. Las claves de cadena antiguas deben ser sobreescritas con ceros antes de ser eliminadas.
```typescript
export function shredBytes(array: Uint8Array): void {
  for (let i = 0; i < array.length; i++) {
    array[i] = 0;
  }
}
```

---

## 3. Cifrado de Adjuntos (Media Encryption)
Los archivos multimedia (imágenes, audios, documentos) no se envían directamente sobre el canal de chat debido al tamaño. Se cifran simétricamente y se suben a un almacén de blobs.

### Flujo de Trabajo
1. **Generación de Claves**: Generar clave efímera simétrica de 256 bits y nonce de 192 bits:
   ```typescript
   const key = nacl.randomBytes(32);
   const nonce = nacl.randomBytes(24);
   ```
2. **Cifrado**:
   ```typescript
   const ciphertext = nacl.secretbox(fileBytes, nonce, key);
   ```
3. **Subida**: Subir el `ciphertext` al almacén de blobs (Relay) y obtener un identificador único (URI del blob).
4. **Envío de Metadatos**: El URI del blob y la clave simétrica se cifran utilizando el canal Double Ratchet existente del chat. El receptor obtiene los metadatos de forma segura, descarga el blob y lo descifra localmente.
