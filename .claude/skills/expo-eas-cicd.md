---
name: expo-eas-cicd
description: Guía completa de EAS Build, EAS Update (OTA), y pipelines CI/CD para AegisLink — perfiles dev/preview/production, GitHub Actions integrado, code signing, OTA updates cifrados, y distribución a TestFlight/Play Store. Aplica cuando se configuren builds, se automaticen releases, o se actualice eas.json / app.config.ts.
source: https://github.com/expo/skills (Expo oficial, MIT)
---

# EAS Build + CI/CD — AegisLink

> Basado en los skills oficiales de Expo: `expo-cicd-workflows`, `expo-deployment`, `expo-dev-client`

## Arquitectura de builds de AegisLink

```
eas.json
├── development   → dev client con WebRTC nativo (AEGIS_EXPO_GO=0)
├── preview       → APK/IPA interno para QA — sin Expo Go
└── production    → App Store / Play Store — firmado, ofuscado
```

---

## 1. eas.json — Estructura completa recomendada

```json
{
  "cli": { "version": ">= 12.0.0" },
  "build": {
    "development": {
      "developmentClient": true,
      "distribution": "internal",
      "env": {
        "AEGIS_EXPO_GO": "0",
        "AEGIS_ENV": "development"
      },
      "android": { "buildType": "apk" },
      "ios": { "simulator": false }
    },
    "preview": {
      "distribution": "internal",
      "env": { "AEGIS_ENV": "preview" },
      "android": { "buildType": "apk" },
      "ios": {
        "enterpriseProvisioning": "adhoc"
      }
    },
    "production": {
      "autoIncrement": true,
      "env": { "AEGIS_ENV": "production" },
      "android": {
        "buildType": "app-bundle"
      }
    }
  },
  "submit": {
    "production": {
      "android": {
        "serviceAccountKeyPath": "./google-services-key.json",
        "track": "internal"
      },
      "ios": {
        "appleId": "APPLE_ID",
        "ascAppId": "APP_STORE_CONNECT_APP_ID"
      }
    }
  }
}
```

---

## 2. GitHub Actions — Pipeline AegisLink

```yaml
# .github/workflows/eas-build.yml
name: EAS Build

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  lint-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
        working-directory: mobile
      - run: npm run lint
        working-directory: mobile
      - run: npm test -- --coverage
        working-directory: mobile

  build-preview:
    needs: lint-test
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: expo/expo-github-action@v8
        with:
          expo-version: latest
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}
      - run: npm ci
        working-directory: mobile
      - run: eas build --profile preview --platform all --non-interactive
        working-directory: mobile
```

---

## 3. EAS Update (OTA) — Solo para JS, nunca para crypto

**REGLA CRÍTICA**: Las actualizaciones OTA solo deben tocar la capa JS. Nunca actualizar:
- Módulos nativos (WebRTC, SecureStore)
- Configuración de Keychain/Keystore
- Versiones de TweetNaCl o @noble/hashes

```bash
# Publicar update OTA al canal production
eas update --channel production --message "fix: pantalla de mensajes"

# Previsualizar qué cambiaría
eas update --branch main --dry-run
```

### Canales recomendados
| Canal | Rama | Audiencia |
|---|---|---|
| `development` | cualquier feature branch | Devs internos |
| `preview` | `main` | QA, beta testers |
| `production` | tags `v*` | Usuarios finales |

---

## 4. Dev Client — Build para WebRTC real

El stub `webrtc-expogo-stub.ts` se activa con `AEGIS_EXPO_GO=1`. Para desarrollo real:

```bash
# Build del dev client (solo primera vez o cuando cambian módulos nativos)
eas build --profile development --platform ios
eas build --profile development --platform android

# Luego, actualizaciones rápidas vía Metro bundler
npx expo start --dev-client
```

---

## 5. Code Signing y privacidad

- **iOS**: Certificates gestionados por EAS (`credentialsSource: "remote"`)
- **Android**: Keystore en EAS Credentials Vault (no en repositorio)
- **No commitar**: `google-services.json`, `GoogleService-Info.plist`, `.env.production`
- **Sí commitar**: `eas.json`, `app.config.ts` (sin secrets), `google-services-key.json.example`

---

## 6. Checklist de release production

- [ ] `npm test` pasa al 100%
- [ ] `npm run lint` sin errores TypeScript strict
- [ ] qa-lead ejecutó auditoría de seguridad en el diff
- [ ] `eas build --profile production` sin warnings de permisos innecesarios
- [ ] Manifest de permisos revisado (solo CAMERA, MICROPHONE, NOTIFICATIONS)
- [ ] No hay `console.log` ni claves hardcodeadas
- [ ] OTA update channel correcto (`production`, no `preview`)
