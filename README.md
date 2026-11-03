# GuiAR — Backend

API REST + WebSocket para GuiAR: cuentas, grupos y ubicaciones en vivo de los dispositivos (ESP32 + GPS + magnetómetro + acelerómetro + LoRa).

```
ESP32 ──BLE/WiFi──► App móvil ──WebSocket / REST──► Backend ──WebSocket──► Web (mapa)
                                                       │
                                                  Postgres (Prisma)
```

## Puesta en marcha

Requisitos: Node.js 22 o superior y una base Postgres (por ejemplo, un proyecto gratis en [Neon](https://neon.tech)).

```bash
npm install
cp .env.example .env          # completar DATABASE_URL, DIRECT_URL, FIREBASE_WEB_API_KEY y ADMIN_EMAILS
# copiar serviceAccountKey.json (Firebase → Configuración → Cuentas de servicio) a la raíz
npm run db:migrate            # aplica las migraciones en la base
npm run dev
```

`DATABASE_URL` es la conexión que usa el backend (en Neon, la *pooled*) y `DIRECT_URL` la que usa Prisma para migrar (en Neon, la directa). Con otro Postgres sin pooler, pueden ser la misma URL.

## Deploy en Render

El repo incluye [`render.yaml`](render.yaml): en Render, **New → Blueprint** y elegí este repositorio.

Crea un web service en el plan **Free**. Los datos viven en Postgres (Neon), así que no se pierden cuando el servicio se reinicia.

Al crear el Blueprint, Render pide estos valores:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | Connection string *pooled* de Neon (host con `-pooler`) |
| `DIRECT_URL` | Connection string directa de Neon |
| `FIREBASE_WEB_API_KEY` | Web API Key del proyecto de Firebase |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | El contenido completo de `serviceAccountKey.json` |
| `ADMIN_EMAILS` | Emails de los administradores, separados por coma |
| `CORS_ORIGINS` | URL de la web (ej: `https://guiar.example.com`). Vacío acepta cualquier origen |

`PORT` lo define Render. Las migraciones se aplican solas en cada deploy (`npx prisma migrate deploy`, durante el build).

En el plan Free, el servicio se duerme tras 15 minutos sin tráfico y tarda alrededor de 1 minuto en despertar. Para mantenerlo despierto, configurá un monitor como [UptimeRobot](https://uptimerobot.com) que llame a `/api/health` cada 10 minutos.

Usá una sola instancia: las conexiones WebSocket se guardan en memoria.

### Hacerse admin

Agregá tu email a `ADMIN_EMAILS` en `.env` (se aplica al iniciar sesión), o:

```bash
npm run admin:grant -- tu@email.com
```

## Autenticación

Todas las rutas protegidas usan `Authorization: Bearer <idToken>` (token de Firebase, dura 1 h).

- **Web**: usa el SDK de Firebase y manda el token que este genera.
- **App móvil**: puede usar el SDK de Firebase igual que la web, o solo HTTP con estos endpoints:

| Método | Ruta | Body | Respuesta |
|---|---|---|---|
| POST | `/api/auth/register` | `{ email, password, displayName? }` | `{ idToken, refreshToken, expiresIn, uid, email, user }` |
| POST | `/api/auth/login` | `{ email, password }` | igual que register |
| POST | `/api/auth/refresh` | `{ refreshToken }` | `{ idToken, refreshToken, expiresIn, uid }` |
| POST | `/api/auth/password-reset` | `{ email }` | `{ ok: true }` (manda un email de Firebase) |
| GET | `/api/auth/me` | — | `{ user }` |
| PATCH | `/api/auth/me` | `{ displayName }` | `{ user }` |

Cuando el token vence, las rutas devuelven `401` con `code: "TOKEN_EXPIRED"`: llamá a `/api/auth/refresh` y reintentá.

## Grupos

Reglas: una persona está **en un solo grupo** a la vez. Quien crea el grupo es el *owner*. Si el owner sale, el miembro más antiguo pasa a ser owner; si sale el último, el grupo se elimina. Al salir de un grupo se borran tus ubicaciones en él.

Cada grupo tiene tres datos distintos:

| Campo | Para qué | Quién lo ve |
|---|---|---|
| `id` | ID público. Va en cada mensaje del WebSocket (`groupId`). | Miembros y admin |
| `inviteCode` | Código corto (8 caracteres, sin 0/O/1/I/L) para invitar. El owner puede regenerarlo. | Miembros |
| `encryption` | Clave AES-256 compartida para que la app y las pulseras cifren lo que se mandan por LoRa. | **Solo miembros** |

| Método | Ruta | Body | Notas |
|---|---|---|---|
| POST | `/api/groups` | `{ name }` | Crea el grupo → `{ group }`. `409 ALREADY_IN_GROUP` si ya estás en uno. |
| POST | `/api/groups/join` | `{ code }` | Acepta minúsculas, espacios y guiones → `{ group }`. |
| GET | `/api/groups/me` | — | **Respuesta plana** con la clave (ver abajo). Sin grupo → `404 NO_GROUP`. |
| PATCH | `/api/groups/me` | `{ name }` | Solo owner |
| POST | `/api/groups/me/leave` | — | `{ ok, groupDeleted }` |
| POST | `/api/groups/me/invite-code` | — | Nuevo código (solo owner). El anterior deja de servir. |
| POST | `/api/groups/me/encryption/rotate` | — | Clave nueva a mano (solo owner) → `{ group }` |
| DELETE | `/api/groups/me/members/:userId` | — | Expulsar (solo owner) |
| GET | `/api/groups/me/locations` | — | `{ groupId, locations[], devices[] }`: última ubicación y pulsera de cada miembro |

Todas las respuestas de `/api/groups` llevan `Cache-Control: no-store`.

### GET /api/groups/me (ID del grupo y clave para la app)

El usuario sale del token de Firebase; la clave solo se entrega si es miembro del grupo.

```json
{
  "id": "cmvzsmctk0006k21r18bknjed",
  "name": "Cosquín Rock",
  "encryption": {
    "algorithm": "AES-256",
    "key": "q83vEjRWeJASNFZ4kBI0VniQEjRWeJASNFZ4kBI0Vng=",
    "encoding": "base64",
    "keyVersion": 1,
    "rotatedAt": null
  },
  "inviteCode": "K7P3QX9M",
  "ownerId": "…",
  "owner": { "id": "…", "displayName": "Ana" },
  "createdAt": "…",
  "memberCount": 2,
  "members": [{ "id": "…", "displayName": "Ana", "email": "…", "joinedAt": "…", "isOwner": true, "online": true }]
}
```

`key` son 32 bytes en base64. La clave nunca viaja por el WebSocket ni se escribe en los logs (`src/utils/log.js` tapa claves y tokens en todo lo que se loguea).

### Renovación de la clave

- **Cuándo**: automáticamente cuando un miembro sale, es expulsado o un admin borra su cuenta (quien se va conocía la clave). El owner también puede renovarla a mano.
- **Qué pasa**: el backend genera una clave nueva y sube `keyVersion` en 1. A los miembros conectados les llega por WebSocket `{ "type": "key_rotated", "keyVersion": 3, "reason": "member_left" | "manual" }`, **sin la clave**.
- **Qué hace la app**: al recibir `key_rotated` (o si `snapshot.group.keyVersion` no coincide con la que tiene guardada al reconectar) pide `GET /api/groups/me` y le pasa a la pulsera la clave nueva junto con `keyVersion`.
- **Qué hace la pulsera** (a implementar en el firmware): manda `keyVersion` en cada paquete LoRa; guarda la clave nueva y conserva la anterior unos minutos para poder leer los paquetes de pulseras que todavía no se actualizaron. Un paquete con una versión que no conoce se descarta.

## Pulseras

Cada usuario tiene **como máximo una pulsera** y cada pulsera pertenece a **un solo usuario**. La pulsera se vincula sola con el primer mensaje que manda la app con su `esp.deviceId`.

| Caso | Respuesta |
|---|---|
| Llega otro `deviceId` desde una cuenta que ya tiene pulsera | `409 DEVICE_MISMATCH` (hay que desvincular la actual) |
| Llega un `deviceId` que está vinculado a otra cuenta | `409 DEVICE_IN_USE` |
| Falta `esp.deviceId` | `400 MISSING_DEVICE_ID` |
| `deviceId` con caracteres fuera de `A-Z a-z 0-9 . _ : -` o más de 64 | `400 INVALID_DEVICE_ID` |

| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/devices/me` | `{ device: { deviceId, name, firmware, lastSeenAt, telemetry } }` o `{ device: null }` |
| DELETE | `/api/devices/me` | Desvincula la pulsera para poder usar otra. `404 NO_DEVICE` si no tenía. |

## WebSocket de ubicaciones

```
ws://HOST:3001/ws/<groupId>?token=<idToken>
```

- `<groupId>` es opcional (`/ws?token=...` también funciona); si va, tiene que ser tu grupo.
- Apps nativas pueden mandar el token en el header `Authorization: Bearer ...`, o como primer mensaje `{ "type": "auth", "token": "..." }` (hay 10 s para hacerlo).
- Cada mensaje puede pesar hasta 32 KB.

### Mensaje de la app → servidor

```json
{
  "type": "location",
  "ref": 42,
  "groupId": "cmh1x7…",
  "email": "usuario@example.com",
  "esp": {
    "deviceId": "device-001",
    "latitude": -31.425,
    "longitude": -62.084,
    "timestamp": 1793656799500,
    "telemetry": {
      "schemaVersion": 1,
      "appVersion": 4,
      "transport": "ble",
      "sentAt": 1793656800000,
      "simulatedLocation": false,
      "sensors": {
        "identity":     { "receivedAt": 1793656799500, "ageMs": 500, "stale": false, "data": { "name": "Pulsera", "id": "device-001", "fw": "0.1", "wifi": false } },
        "imu":          { "receivedAt": 1793656799500, "ageMs": 500, "stale": false, "data": { "accel_g": [0.01, -0.02, 0.98], "gyro_dps": [1.2, -0.4, 0.1], "temp_c": 26.5 } },
        "gps":          { "receivedAt": 1793656799500, "ageMs": 500, "stale": false, "data": { "connected": true, "fix": true, "lat": -31.425, "lon": -62.084, "sats": 9, "hdop": 1.2, "age_s": 0 } },
        "magnetometer": { "receivedAt": 1793656799500, "ageMs": 500, "stale": false, "data": { "chip": "QMC5883P", "raw_xyz": [120, -35, 208] } },
        "diagnostics":  { "receivedAt": 1793656799500, "ageMs": 500, "stale": false, "data": { "uptime_s": 120, "i2c": ["0x2c", "0x68"], "errors": [] } }
      }
    },
    "satellites": 9,
    "gpsHdop": 1.2,
    "accel": { "x": 0.01, "y": -0.02, "z": 0.98 }
  }
}
```

| Campo | Obligatorio | Validación / uso |
|---|---|---|
| `groupId` | sí | Debe ser el grupo del usuario del token (`GROUP_MISMATCH`). |
| `email` | no | Si viene, debe ser el del token (`EMAIL_MISMATCH`). |
| `groupCode` | no | Si no coincide con el código vigente, se acepta igual con un `warning` en el ack. |
| `esp.deviceId` | **sí** | La pulsera del usuario (ver **Pulseras**). |
| `esp.latitude` / `esp.longitude` | sí, salvo que venga `telemetry` | También `lat`, `lng`/`lon`, o `telemetry.sensors.gps.data.lat/lon`. Sin coordenadas pero con `telemetry`, se acepta: se actualiza el estado de la pulsera y no se guarda punto (`device_update`). |
| `esp.satellites` | no | También `sats` o `telemetry...gps.data.sats`. Entero 0–255. |
| `esp.gpsHdop` | no | También `hdop` o `telemetry...gps.data.hdop`. 0–100. |
| `esp.telemetry` | no | Objeto de hasta 12 KB. Se guarda **solo la última** por pulsera (no por punto) y se reenvía a los miembros. Si no es un objeto o es más grande, se descarta con un `warning` y el resto del mensaje se procesa igual. `telemetry.sensors.gps.data.fix` se guarda en el punto (`gpsFix`) y `simulatedLocation` como `simulated`. |
| `esp.*` | no | `altitude/alt`, `speed` (m/s), `heading` (0–360), `accuracy` (m), `battery` (0–100), `signal/rssi`, `timestamp/time` (s, ms o ISO). Cualquier otro campo (ej: `accel`) se guarda en `extra` (máx 4 KB). |
| `ref` | no | Se devuelve en el `ack` / `error` para emparejar respuestas. |

Respuestas: `{ "type": "ack", "saved": true, "locationId": "…", "deviceId": "device-001", "warnings": [], "ref": 42 }` o `{ "type": "error", "error": "…", "code": "…", "ref": 42 }`.

Los mensajes tienen que ser objetos JSON: si no se puede parsear llega `INVALID_JSON`, y si es JSON válido pero no un objeto (`null`, un número, un array) llega `INVALID_MESSAGE`. En ambos casos la conexión sigue abierta.

Todas las ubicaciones se retransmiten en vivo; en la base se guarda como máximo una cada `LOCATION_MIN_INTERVAL_MS` por usuario, y el historial se borra pasadas `LOCATION_RETENTION_HOURS`. El estado de la pulsera se escribe como máximo cada 5 s (lo último siempre queda guardado).

Mismo formato por REST: `POST /api/locations` (útil si se corta el WS o para probar con Postman).

### Mensajes servidor → clientes

| `type` | Cuándo | Contenido |
|---|---|---|
| `connected` | Al conectar | `groupId, userId, displayName` |
| `snapshot` | Al conectar | `group { id, name, ownerId, keyVersion, members[] }`, `locations[]`, `devices[]` |
| `location_update` | Alguien mandó ubicación | `location { userId, latitude, longitude, heading, satellites, hdop, gpsFix, simulated, battery, … }` + `device { userId, deviceId, name, firmware, lastSeenAt, telemetry }` |
| `device_update` | Llegó telemetría sin coordenadas, o alguien desvinculó su pulsera | `userId`, `device` (o `null`) |
| `key_rotated` | Se renovó la clave del grupo | `keyVersion`, `reason`: pedir la clave con `GET /api/groups/me` |
| `presence` | Alguien se conectó/desconectó | `userId, online` |
| `member_joined` / `member_left` | Cambió el grupo | `member` / `userId, newOwnerId` |
| `group_renamed` | El owner cambió el nombre | `name` |
| `group_left` / `group_deleted` | Te sacaron / se eliminó el grupo | `reason` (luego se cierra el socket) |
| `pong` | Respuesta a `{ "type": "ping" }` | `t` |

Códigos de cierre: `4001` token inválido · `4003` sin grupo o `groupId` ajeno · `4004` saliste/te expulsaron · `4005` grupo eliminado. El servidor manda ping cada 30 s y corta conexiones muertas.

## Panel de administración (`/api/admin`, solo rol ADMIN)

Ningún endpoint de admin devuelve coordenadas ni la clave de cifrado.

| Método | Ruta | Notas |
|---|---|---|
| GET | `/api/admin/stats` | Totales y conexiones en vivo |
| GET | `/api/admin/groups?search=` | Nombre, creador, miembros, en línea, última actividad |
| GET | `/api/admin/groups/:id` | Detalle con miembros |
| DELETE | `/api/admin/groups/:id` | Los miembros quedan sin grupo |
| GET | `/api/admin/users?search=` | |
| PATCH | `/api/admin/users/:id` | `{ role: "ADMIN" \| "USER" }` |
| DELETE | `/api/admin/users/:id` | Borra también la cuenta de Firebase |

## Errores

Siempre `{ "error": "mensaje para mostrar", "code": "CODIGO" }` con el status HTTP correspondiente.

| Status | `code` | Cuándo |
|---|---|---|
| 400 | `INVALID_ROLE` | `role` no es `ADMIN` ni `USER` |
| 400 | `CANNOT_DEMOTE_SELF` | Un admin intenta quitarse el rol |
| 400 | `CANNOT_DELETE_SELF` | Un admin intenta borrar su propia cuenta |
| 400 | `CANNOT_KICK_SELF` | El owner intenta expulsarse (tiene que usar `/leave`) |
| 400 | `BAD_REQUEST` | Otro error de la solicitud sin código propio |
| 404 | `GROUP_NOT_FOUND` / `USER_NOT_FOUND` | El grupo o usuario no existe (admin) |
| 404 | `NOT_A_MEMBER` | Se intenta expulsar a alguien que no es del grupo |
| 413 | `PAYLOAD_TOO_LARGE` | El cuerpo supera los 32 KB |

Los demás códigos están en la sección de cada endpoint.
