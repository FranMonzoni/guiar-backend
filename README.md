# GuiAR — Backend

API REST + WebSocket para GuiAR: cuentas, grupos y ubicaciones en vivo de los dispositivos (ESP32 + GPS + magnetómetro + acelerómetro + LoRa).

```
ESP32 ──BLE/WiFi──► App móvil ──WebSocket / REST──► Backend ──WebSocket──► Web (mapa)
                                                       │
                                                   SQLite (Prisma)
```

## Puesta en marcha

Requisitos: Node.js 22 o superior.

```bash
npm install
cp .env.example .env          # completar FIREBASE_WEB_API_KEY y ADMIN_EMAILS
# copiar serviceAccountKey.json (Firebase → Configuración → Cuentas de servicio) a la raíz
npm run db:migrate            # crea prisma/dev.db con el esquema
npm run dev
```

> **Si ya tenías una base de la versión anterior**: el esquema cambió (`joinKey` → `inviteCode` + `encryptionKey`). Borrá `prisma/dev.db` (y `prisma/prisma/dev.db` si existe) antes de `npm run db:migrate`, o aceptá el reset cuando Prisma lo pida.

## Deploy en Render

El repo incluye [`render.yaml`](render.yaml): en Render, **New → Blueprint** y elegí este repositorio.

Crea un web service con plan **Starter** y un disco de 1 GB montado en `/var/data`, donde vive la base SQLite. El plan Free no sirve: no admite discos y la base se perdería en cada reinicio.

Al crear el Blueprint, Render pide estos valores:

| Variable | Valor |
|---|---|
| `FIREBASE_WEB_API_KEY` | Web API Key del proyecto de Firebase |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | El contenido completo de `serviceAccountKey.json` |
| `ADMIN_EMAILS` | Emails de los administradores, separados por coma |
| `CORS_ORIGINS` | URL de la web (ej: `https://guiar.example.com`). Vacío acepta cualquier origen |

`PORT` lo define Render. Las migraciones se aplican solas en cada arranque (`npm run db:deploy`).

Usá una sola instancia: la base está en el disco de ese servidor y las conexiones WebSocket se guardan en memoria.

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
| `encryptionKey` | Clave AES-256 (64 hex) para que la app y las ESP32 cifren lo que se mandan por LoRa. | **Solo miembros** |

| Método | Ruta | Body | Notas |
|---|---|---|---|
| POST | `/api/groups` | `{ name }` | Crea el grupo. `409 ALREADY_IN_GROUP` si ya estás en uno. |
| POST | `/api/groups/join` | `{ code }` | Acepta minúsculas, espacios y guiones. |
| GET | `/api/groups/me` | — | `{ group }` o `{ group: null }` |
| PATCH | `/api/groups/me` | `{ name }` | Solo owner |
| POST | `/api/groups/me/leave` | — | `{ ok, groupDeleted }` |
| POST | `/api/groups/me/invite-code` | — | Nuevo código (solo owner). El anterior deja de servir. |
| DELETE | `/api/groups/me/members/:userId` | — | Expulsar (solo owner) |
| GET | `/api/groups/me/locations` | — | Última ubicación de cada miembro |

## WebSocket de ubicaciones

```
ws://HOST:3001/ws/<groupId>?token=<idToken>
```

- `<groupId>` es opcional (`/ws?token=...` también funciona); si va, tiene que ser tu grupo.
- Apps nativas pueden mandar el token en el header `Authorization: Bearer ...`, o como primer mensaje `{ "type": "auth", "token": "..." }` (hay 10 s para hacerlo).

### Mensaje de la app → servidor

```json
{
  "type": "location",
  "ref": 42,
  "groupId": "cmh1x7…",
  "email": "user@mail.com",
  "groupCode": "K7P3QX9M",
  "esp": {
    "deviceId": "GUIAR-01",
    "latitude": -31.4201,
    "longitude": -64.1888,
    "altitude": 410.2,
    "speed": 1.3,
    "heading": 87,
    "accuracy": 4.5,
    "satellites": 9,
    "battery": 82,
    "signal": -97,
    "timestamp": 1761751200000,
    "accel": { "x": 0.01, "y": -0.02, "z": 0.98 }
  }
}
```

| Campo | Obligatorio | Validación |
|---|---|---|
| `groupId` | sí | Debe ser el grupo del usuario del token (`GROUP_MISMATCH`). |
| `email` | no | Si viene, debe ser el del token (`EMAIL_MISMATCH`). |
| `groupCode` | no | Si no coincide con el código vigente, se acepta igual con un `warning` en el ack. |
| `esp.latitude` / `esp.longitude` | sí | También `lat`, `lng`/`lon`. Rango válido. |
| `esp.*` | no | `altitude/alt`, `speed` (m/s), `heading` (0–360), `accuracy/hdop`, `satellites/sats`, `battery` (0–100), `signal/rssi`, `timestamp/time` (s, ms o ISO). Cualquier otro campo (ej: `accel`) se guarda en `extra` (máx 4 KB). |
| `ref` | no | Se devuelve en el `ack` / `error` para emparejar respuestas. |

Respuestas: `{ "type": "ack", "saved": true, "locationId": "…", "warnings": [], "ref": 42 }` o `{ "type": "error", "error": "…", "code": "…", "ref": 42 }`.

Los mensajes tienen que ser objetos JSON: si no se puede parsear llega `INVALID_JSON`, y si es JSON válido pero no un objeto (`null`, un número, un array) llega `INVALID_MESSAGE`. En ambos casos la conexión sigue abierta.

Todas las ubicaciones se retransmiten en vivo; en la base se guarda como máximo una cada `LOCATION_MIN_INTERVAL_MS` por usuario, y el historial se borra pasadas `LOCATION_RETENTION_HOURS`.

Mismo formato por REST: `POST /api/locations` (útil si se corta el WS o para probar con Postman).

### Mensajes servidor → clientes

| `type` | Cuándo | Contenido |
|---|---|---|
| `connected` | Al conectar | `groupId, userId, displayName` |
| `snapshot` | Al conectar | `group { id, name, ownerId, members[] }`, `locations[]` |
| `location_update` | Alguien mandó ubicación | `location { userId, displayName, latitude, longitude, heading, battery, … }` |
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
