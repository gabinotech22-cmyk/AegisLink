# GitHub Actions — Secrets requeridos

Configura en: **repo → Settings → Secrets and variables → Actions → New repository secret**

---

## EAS Build (builds móviles iOS + Android)

| Secret | Descripción | Cómo obtenerlo |
|--------|-------------|----------------|
| `EXPO_TOKEN` | Token de acceso a EAS | expo.dev → Account Settings → Access Tokens → Create |

---

## Deploy SSH (relay Node.js en AWS EC2)

| Secret | Descripción | Ejemplo |
|--------|-------------|---------|
| `DEPLOY_HOST` | IP pública de la instancia AWS EC2 | `51.20.60.155` |
| `DEPLOY_USER` | Usuario SSH de la instancia AWS | `ubuntu` |
| `DEPLOY_SSH_KEY` | Clave privada SSH completa | Contenido de `~/.ssh/id_ed25519` |
| `DEPLOY_PATH` | Directorio de la app en la VM | `/home/aegis/app` |

### Generar clave SSH dedicada para CI (recomendado)

```bash
# En tu máquina local
ssh-keygen -t ed25519 -C "aegislink-ci" -f ~/.ssh/aegislink_ci -N ""

# Autorizar en la VM
ssh-copy-id -i ~/.ssh/aegislink_ci.pub ubuntu@<TU_IP>

# El valor de DEPLOY_SSH_KEY es el contenido de:
cat ~/.ssh/aegislink_ci
```

---

## Notas de infraestructura

- El relay Node.js y coturn **ya corren** en la instancia AWS EC2 via PM2.
- El workflow hace `pm2 reload aegislink-relay` — zero-downtime, sin Docker.
- Para reiniciar coturn: usa **workflow_dispatch** con `restart_coturn = true`.
- `server/Dockerfile` y `server/deploy/deploy.sh` sirven como referencia y deploy manual local.

### Deploy manual desde tu máquina

```bash
cd server
bash deploy/deploy.sh <IP_AWS>
# Con reinicio de coturn:
bash deploy/deploy.sh <IP_AWS> --restart-coturn
```
