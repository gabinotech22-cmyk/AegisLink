---
name: did-onchain
description: Skill para DIDs (Decentralized Identifiers) en la blockchain, registro de identidades soberanas anónimas y pagos Lightning Network.
---

# Identidades Soberanas y Pagos Anónimos (DID & Lightning)

Esta skill proporciona las especificaciones para integrar el estándar W3C de Identificadores Descentralizados (DID) y pagos anónimos en AegisLink mediante Web3 y Lightning Network.

## 1. Identificadores Descentralizados (DID)
Los usuarios pueden asociar opcionalmente un DID on-chain a su perfil público para demostrar su identidad sin depender de una autoridad centralizada.

### Especificación `did:aegis`
- **Generación de Claves**: El par de claves de identidad pública (Ed25519) del dispositivo se utiliza para construir el identificador DID.
- **Formato**: `did:aegis:<Base32-Fingerprint>` (ej. `did:aegis:ABC12345678`).
- **DID Document**: Contiene la clave pública de verificación para firmas digitales y cifrado:
  ```json
  {
    "@context": "https://www.w3.org/ns/did/v1",
    "id": "did:aegis:ABC12345678",
    "verificationMethod": [
      {
        "id": "did:aegis:ABC12345678#key-1",
        "type": "Ed25519VerificationKey2020",
        "controller": "did:aegis:ABC12345678",
        "publicKeyMultibase": "z6MkpTHR8VNsBx..."
      }
    ],
    "authentication": [
      "did:aegis:ABC12345678#key-1"
    ]
  }
  ```

---

## 2. Pagos Anónimos mediante Lightning Network (Bitcoin)
Para el onboarding opcional de nivel Enterprise o suscripciones de AegisLink Work, se admiten micropagos instantáneos y anónimos.

### Integración de Billetera (Lightning Wallet)
- **Facturas de un solo uso (Invoices)**: El relay de AegisLink genera facturas Lightning temporales vinculadas a un hash de pago anónimo.
- **Privacidad**: El relay no vincula la factura con la IP ni con el AegisId en base permanente. Una vez verificado el pago mediante el comprobante de preimagen de Lightning, se otorga acceso instantáneo al plan.
- El cliente móvil utiliza llamadas API REST firmadas con la clave de identidad efímera para solicitar la generación de la factura.
