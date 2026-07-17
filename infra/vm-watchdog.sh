#!/usr/bin/env bash
# infra/vm-watchdog.sh — on-VM resource & health watchdog with ntfy alerts.
#
# Complements .github/workflows/health-watchdog.yml (external reachability):
# this one watches the INSIDE of the VM — load, RAM, disk, containers, relay
# health — and pushes alerts to the operator's phone through the co-hosted
# ntfy (zero third parties, same as everything else in this stack).
#
# Install (once, as root on the VM):
#   cp /opt/aegislink/infra/vm-watchdog.sh /usr/local/bin/aegis-watchdog
#   chmod +x /usr/local/bin/aegis-watchdog
#   echo "<random-topic>" > /etc/aegislink-watchdog.topic   # e.g. openssl rand -hex 8
#   crontab -e →  */5 * * * * /usr/local/bin/aegis-watchdog >/dev/null 2>&1
#
# Subscribe on the phone: ntfy app → add server https://aegislink.duckdns.org:8443
# → subscribe to the topic in /etc/aegislink-watchdog.topic.
#
# Anti-flap: each check keeps a state file under /run/aegis-watchdog/; an alert
# fires once when a condition starts and once more ("RECOVERED") when it ends.
# Thresholds match docs' scaling plan: they are the "time to split servers" bell.

set -u

NTFY_LOCAL="http://127.0.0.1:8090"
TOPIC_FILE="/etc/aegislink-watchdog.topic"
STATE_DIR="/run/aegis-watchdog"
mkdir -p "$STATE_DIR"

[ -r "$TOPIC_FILE" ] || exit 0   # not configured — do nothing, never break cron
TOPIC="$(tr -d '[:space:]' < "$TOPIC_FILE")"
[ -n "$TOPIC" ] || exit 0

notify() { # $1=priority $2=title $3=body
  curl -s --max-time 10 -H "Priority: $1" -H "Title: $2" -d "$3" \
    "$NTFY_LOCAL/$TOPIC" >/dev/null 2>&1 || true
}

# alert <key> <in_alarm(0/1)> <title> <body>
alert() {
  local key="$1" bad="$2" title="$3" body="$4" flag="$STATE_DIR/$1.alarm"
  if [ "$bad" = "1" ] && [ ! -f "$flag" ]; then
    touch "$flag"; notify high "⚠️ $title" "$body"
  elif [ "$bad" = "0" ] && [ -f "$flag" ]; then
    rm -f "$flag"; notify default "✅ RECOVERED: $title" "$body"
  fi
}

# ── 1. Load average (2 cores → alarm at 1.4 sustained) ───────────────────────
LOAD="$(cut -d' ' -f2 /proc/loadavg)"   # 5-min average, resists blips
alert load "$(awk -v l="$LOAD" 'BEGIN{print (l>1.4)?1:0}')" \
  "Carga alta en la VM" "load 5min = $LOAD (umbral 1.4 de 2 cores). Si persiste: toca el split del plan de escalado."

# ── 2. Available RAM (< 500 MB) ──────────────────────────────────────────────
AVAIL_MB="$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)"
alert ram "$([ "$AVAIL_MB" -lt 500 ] && echo 1 || echo 0)" \
  "RAM baja en la VM" "MemAvailable = ${AVAIL_MB} MB (umbral 500 MB)."

# ── 3. Disk usage (> 85 %) ───────────────────────────────────────────────────
DISK_PCT="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
alert disk "$([ "$DISK_PCT" -gt 85 ] && echo 1 || echo 0)" \
  "Disco lleno en la VM" "Uso de / = ${DISK_PCT}% (umbral 85%)."

# ── 4. Containers that must be running ───────────────────────────────────────
for c in aegislink-relay aegislink-ntfy aegislink-tor aegislink-coturn; do
  RUNNING=0
  docker inspect -f '{{.State.Running}}' "$c" 2>/dev/null | grep -q true && RUNNING=1
  alert "container_$c" "$([ "$RUNNING" = "1" ] && echo 0 || echo 1)" \
    "Contenedor caído: $c" "docker inspect dice que $c no está Running. (Si es el relay: los clientes ven 502.)"
done

# ── 5. Relay health endpoint, from inside (localhost, sin pasar por nginx) ───
HEALTHY=0
curl -sf --max-time 8 http://127.0.0.1:3001/health 2>/dev/null | grep -q '"ok":true' && HEALTHY=1
alert relay_health "$([ "$HEALTHY" = "1" ] && echo 0 || echo 1)" \
  "Relay /health KO (interno)" "El proceso del relay corre pero /health no responde ok — probable crash-loop o deadlock."

# ── 6. Network throughput (TURN es lo primero que saturará) ──────────────────
# Muestra de 5 s de la interfaz por defecto; alarma sobre 25 MB/s sostenidos
# (≈200 Mbit/s ≈ la mitad del enlace del CX). Señal de "separar coturn YA".
IFACE="$(ip route show default 2>/dev/null | awk '{print $5; exit}')"
if [ -n "${IFACE:-}" ]; then
  RX1=$(cat "/sys/class/net/$IFACE/statistics/rx_bytes"); TX1=$(cat "/sys/class/net/$IFACE/statistics/tx_bytes")
  sleep 5
  RX2=$(cat "/sys/class/net/$IFACE/statistics/rx_bytes"); TX2=$(cat "/sys/class/net/$IFACE/statistics/tx_bytes")
  MBPS=$(( ( (RX2-RX1) + (TX2-TX1) ) / 5 / 1024 / 1024 ))
  alert net "$([ "$MBPS" -gt 25 ] && echo 1 || echo 0)" \
    "Tráfico de red alto" "~${MBPS} MB/s sostenidos en $IFACE (umbral 25). Probable pico TURN — activar split de coturn."
fi

exit 0
