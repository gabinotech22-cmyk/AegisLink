# Self-hosting an AegisLink relay (federation F6)

> Estado: **✅ paquete listo** (`infra/selfhost/`, #492) y **✅ federación activa por
> defecto** en los clientes desde 1.0.7 (F7). Este doc es la fuente canónica de cómo
> montar un relay propio; el diseño y el estado de la federación viven en
> `docs/FEDERATION-DESIGN.md`. Los usuarios lo eligen desde la app en
> **Privacidad → Red → "Mi relay"**, que también explica cómo montarlo: tarjeta
> "¿Cómo monto mi propio relay?" con 3 pasos + enlace a la versión pública de
> esta guía, **`https://aegis-link.it/selfhost.html`** (`web/selfhost.html`,
> ES/EN/IT vía `web/lang.js`; la app la abre con `?lang=` en su idioma;
> desplegada con `infra/deploy-web.sh`). Si cambias los pasos aquí, cambia
> también esa página y las claves `relaySettings.howTo*` de la app.

## Qué es (y qué no)

Un relay de AegisLink es un buzón ciego: recibe sobres sellados (nunca ve
quién escribe a quién) y los guarda hasta que el destinatario los recoge.
Montar el tuyo significa que **tus mensajes nunca pasan por el relay
oficial**: tu identidad y tu buzón viven en tu máquina, y tus contactos
—estén en el relay oficial o en cualquier otro— te escriben directamente a
tu relay por Tor (modelo SimpleX: no hay red entre relays, cada cliente
habla con los relays que necesita).

- **Solo `.onion`.** El relay se publica como servicio oculto de Tor v3.
  No hay listener clearnet, ni TLS, ni certificado, ni dominio, ni puerto
  abierto en tu router. Tu máquina no aprende la IP de nadie y nadie
  necesita saber dónde está: el servicio va **con ubicación oculta** (3
  saltos también del lado servidor, `infra/tor/torrc.selfhost`), a
  diferencia del relay oficial, que usa single-onion porque su ubicación ya
  es pública. Ver `ONION_TORRC` en las opciones si prefieres latencia a
  ocultar dónde corre.
- **No es un relay de Tor** ni un exit: el sidecar solo publica tu servicio.
- **No federa con nadie**: no hay directorio global ni relay-a-relay. La
  dirección de un contacto (`aegislink://v2/...`) incluye su relay y su buzón;
  con eso basta.

## Requisitos

- Una máquina que esté encendida cuando quieras recibir mensajes (un VPS de
  2 GB, un mini-PC en casa, una Raspberry Pi 4). Sin IP pública, sin dominio.
- Docker con el plugin `compose` (Docker 24+).
- Salida a Internet (Tor necesita conectarse a la red Tor; nada entra).
- Opcional: `qrencode` (`sudo apt install qrencode`) para que la dirección salga
  también como **código QR** (terminal + `relay-qr.png`).

## Levantarlo

```bash
git clone https://github.com/gabinotech22-cmyk/AegisLink.git
cd AegisLink/infra/selfhost
./up.sh
```

`up.sh` es idempotente: crea `.env` desde `.env.example`, genera los dos
secretos obligatorios si están vacíos, construye y levanta `relay`, `tor` y
`ntfy`, espera a que Tor publique el servicio y te imprime:

```
  Your relay:  http://xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx.onion
```

y, si tienes `qrencode`, la misma dirección como QR en la terminal y guardada
en `relay-qr.png` (gitignored) para mandársela a tu familia/amigos por un canal
de confianza (`show-qr.sh`; sin `qrencode` solo avisa de cómo instalarlo).

Para volver a verla: `./print-onion.sh` (la dirección por stdout, el QR por
stderr; `--no-qr` para scripts). Para actualizar tras un `git pull`:
`./up.sh` otra vez (rebuild; datos y clave onion se conservan).

## Usarlo desde la app

1. **Privacidad → Red → Mi relay** → **Escanear QR del relay** (móvil, cámara)
   o **Importar imagen de QR** (escritorio, captura/foto), o pega la dirección
   `.onion` → **Verificar**. El escáner solo acepta un onion v3 válido (un QR de
   contacto o de grupo se rechaza, nunca se interpreta) y verifica en el acto;
   el cambio sigue exigiendo confirmación. La app hace `GET /relay/info` + `/health` por Tor y comprueba que el relay
   sirve `mailbox` y `prekeys`. Sin verificar no hay botón de cambio.
2. **Cambiar a …onion** → lee las consecuencias → confirma (con PIN o
   biometría si tienes el bloqueo de la app activado).
3. La app se registra en tu relay, avisa a todos tus contactos de tu nueva
   dirección (dentro del canal cifrado, sin que nadie escanee nada) y cambia.
   Durante **7 días** sigue recibiendo también en el relay anterior; quien no
   abra la app en ese tiempo necesitará tu enlace nuevo.

Tu enlace/QR pasa a ser `aegislink://v2/<id>/<clave>/<onion>/<root>`: incluye
tu relay y tu buzón, y es lo único que un contacto nuevo necesita.

## Guarda la clave del onion

La dirección `.onion` **es** una clave (ed25519) que vive solo en el volumen
`tor_keys`. Si la pierdes, tu dirección cambia y cada usuario tiene que
volver a apuntar la app. Haz una copia y guárdala fuera de la máquina:

```bash
./backup-onion-key.sh          # → tor_keys-<fecha>.tar.gz (modo 600)
```

Quien tenga ese archivo puede suplantar tu relay: trátalo como una clave
privada. Copia también el volumen `relay_data` (SQLite con las colas
cifradas y las prekeys públicas) si quieres sobrevivir a un disco muerto;
no contiene mensajes en claro ni claves privadas de usuarios.

## Opciones (`.env`)

| Variable | Por defecto | Para qué |
|---|---|---|
| `RELAY_NAME` | `My AegisLink relay` | Nombre que ve el usuario al verificar. |
| `BLOB_SECRET`, `TURN_SECRET` | generados por `up.sh` | Firman tokens de adjuntos y credenciales TURN. Obligatorios. |
| `PUSH_MAILBOX_ENABLED` | `on` | Aviso de "hay correo" por ntfy (sobre Tor) cuando la app está cerrada. |
| `MAILBOX_SUBMIT_POW` | `off` | Exige una pequeña prueba de trabajo por sobre enviado. Actívalo si te spamean: un cliente real la resuelve en milisegundos; un bot paga por cada mensaje. |
| `IDENTITY_LOOKUP` | `on` | `GET /identity/:id`. `off` = tus ids no son consultables; los contactos llegan solo por enlace/QR (que ya lleva la clave). |
| `PUBLIC_CHANNELS` | `off` | Canales públicos (función local del relay). |
| `TURN_HOST` / `TURN_PORT` | vacío | Ver **Llamadas**. |
| `ONION_TORRC` | `torrc.selfhost` | Sabor del onion. `torrc.selfhost` = ubicación oculta (3 saltos servidor). `torrc` = single-onion del relay oficial: mitad de latencia, pero la red Tor ve tu IP — solo si tu máquina ya es pública. Cambiar de modo exige un **onion nuevo** (`docker volume rm selfhost_tor_keys` y `./up.sh`). |

## Llamadas

El audio/vídeo no viaja por Tor (UDP, latencia): la señalización sí (sellada,
por tu relay), pero los medios van de móvil a móvil. Sin un TURN, dos usuarios
detrás de NATs restrictivos no consiguen conectar; el chat no se ve afectado.
Si quieres llamadas fiables para tus usuarios, monta **coturn en una máquina
con IP pública** (`infra/coturn/docker-compose.coturn.yml` es el despliegue de
referencia; el mismo `TURN_SECRET` en ambos lados) y pon `TURN_HOST` en el
`.env` del relay. Cada usuario usa el TURN de *su* relay.

## Qué ve el operador (residuo honesto)

Lo mismo que ve el relay oficial de sus usuarios, ni más ni menos
(`docs/SEALED-SENDER-ARCHITECTURE.md` §6): ids de buzón opacos que rotan a
diario, sobres cifrados, y cuándo se recogen. Nunca IPs (Tor), nunca quién
escribe a quién (sealed sender), nunca contenido. Un sobre que llega desde
otro relay entra por un buzón desechable que no identifica al emisor.

## Actualizar, parar, borrar

```bash
./up.sh                        # actualizar (tras git pull)
docker compose down            # parar (datos y clave se conservan)
docker compose down -v         # BORRAR todo, incluida la dirección .onion
```

## Solución de problemas

- **`up.sh` termina sin dirección**: Tor tarda 1–3 min en publicar el
  servicio la primera vez. `./print-onion.sh` cuando aparezca; `docker
  compose logs tor` para ver el bootstrap.
- **"No se pudo alcanzar ese relay por Tor" al verificar**: comprueba que el
  contenedor `tor` está sano (`docker compose ps`) y que la máquina tiene
  salida a Internet. Un servicio recién publicado puede tardar un minuto en
  ser alcanzable.
- **"Ese relay no soporta buzones o prekeys"**: estás usando una versión del
  relay anterior a F2 — `git pull && ./up.sh`.
- **Las fotos/audios no salen ("no enviado", `upload_http_500`) pero el texto
  sí**: relay levantado con una imagen anterior al 2026-09-20 — el volumen de
  adjuntos quedó propiedad de root y el relay (usuario `aegis`) no podía
  escribir. `git pull && ./up.sh` lo corrige en el sitio (la imagen nueva crea
  el directorio con el dueño correcto y `up.sh` repara los volúmenes viejos).
- **Tras actualizar, la imagen del relay pasa de Alpine a Debian slim** (F-1: el cripto del relay
  es libsodium nativo, que no carga en Alpine/musl). Es transparente: el usuario `aegis` conserva el
  mismo uid/gid (100/101), así que los volúmenes existentes siguen siendo escribibles, y el
  healthcheck usa `node` en vez de `wget`. `git pull && ./up.sh` reconstruye la imagen.
- **`tor` reinicia en bucle tras cambiar `ONION_TORRC`**: Tor no reutiliza el
  directorio de claves entre el modo oculto y el single-onion. Es deliberado
  (protege contra errores de config): `docker compose down && docker volume
  rm selfhost_tor_keys && ./up.sh` — dirección nueva, avisa a tus usuarios.
- **Quiero volver al oficial**: en la app, "Volver al relay oficial" (misma
  migración al revés, con sus 7 días de gracia en tu relay).
