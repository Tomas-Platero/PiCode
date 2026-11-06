# 👤 La ventana Account

> *"Quiero un panel a parte solo para «Account» como el que tenemos de «Chat Settings» donde poder ver todo lo que se sincroniza bien, a parte todo lo «pro» de la app que quiero añadir debería ir ahí no solo la sync."* — 2026-11-06

**Una ventana, un sitio para todo lo de la cuenta.** Se abre con *PiCode: Open Account* y desde el menú de cuentas. Es un editor modal aparte de Chat Settings.

## Qué hay dentro

| Página | Para qué |
|---|---|
| 👤 **Overview** | Correo, plan (Free / Pro), iniciar sesión, *Upgrade* o *Manage plan*, cerrar sesión. |
| ☁️ **Cloud sync** | Estado (al día, sincronizando, necesita atención, apagada), última sincronización, *Sync now*, *Turn on / off* y un interruptor por categoría y una fila *Chats* (los de los últimos 7 días) con su interruptor y *Restore*. Con el interruptor puesto, la extensión los copia sola en segundo plano cada 10 minutos (ajuste `picode.sync.chats`, apagado de serie). Sin Pro, la página lo explica. |
| 🔌 **Connections** | Los servicios Pro que traen trabajo al chat (issues de GitHub, Jira…). Cada uno dice si está incluido, bloqueado o próximo. |
| ⭐ **Pro features** | Todo lo que incluye el plan Pro, de un vistazo. |

## Cómo se añade una función Pro nueva

1. Se declara con `registerProFeature` (`picodeProEntitlement.ts`): nombre, frase, icono y si ya está disponible.
2. Si necesita su propia página, se registra con `registerAccountSection` (`picodeAccountSections.ts`).
3. Si es un conector, se declara además en `picodeConnectors.ts` y aparece solo en *Connections*.
4. Antes de actuar, pregunta a `IPicodeProEntitlement`: una sola respuesta para «¿esta cuenta es Pro?».

## La puerta Pro

`IPicodeProEntitlement` lee el correo y el plan que el inicio de sesión dejó guardados. **Es un reflejo para la pantalla, no un cerrojo:** el plan es una foto del último inicio de sesión y quien manda es el servidor, que contesta `402` a cualquier cuenta que no sea Pro (ADR-017). **Si no se conoce el plan** (una sesión que dejó la ventana de primer arranque no lo trae hasta el siguiente inicio de sesión), nada se bloquea: la pantalla queda abierta y el servidor decide, para no enseñar una puerta cerrada a quien sí paga. Si alguien manipulara el valor local, solo vería una pantalla distinta: el servidor seguiría negando el servicio.

## Issues de GitHub y Jira (solo Pro)

> *"que se conectara a github y te mostrara que fallos te han reportado de tus repos y desde ahi le pudieras pedir a tu sistema agentico que te lo solucionara?"* — 2026-11-06
>
> *"OAuth en los dos"* — 2026-11-06

> *"no me gusta como está eso de github issues y jira issues en el de la izq, lo quiero en connections. Luego quiero un panel para cada uno visible en status. El login que sea en connections"* — 2026-11-06

El login vive en las tarjetas de *Connections* y las issues se ven en la columna *Status*: no hay páginas propias en la lista lateral. Con una cuenta gratis la tarjeta sale bloqueada con un único botón, *Upgrade to Pro*.

**Qué ve el usuario**

1. En *Connections*, cada tarjeta (GitHub, Jira) tiene *Connect*. En GitHub, el editor copia un código, abre la página de GitHub y deja el código en la tarjeta por si hace falta de nuevo. En Jira se abre la página de Atlassian y, al aceptar, vuelve solo al editor. Conectada, la tarjeta dice *Connected* (en Jira, a qué sitio) y tiene *Disconnect*. Un intento fallido lo dice en una frase.
2. En *Status* aparece un panel por servicio conectado (*GitHub issues*, *Jira issues*): las 5 issues abiertas más recientes, con *Show N more*, y *Refresh*. Las del proyecto abierto van primero; en GitHub, hasta 15 repos. Sin conectar, el panel dice *Not connected* y su botón *Connect* abre la ventana Account. Sin plan Pro o sin identificadores registrados, el panel no sale.
3. Cada fila: título, clave (o *Outside report* si la escribió alguien ajeno al equipo) y el botón *Fix with pi*. Pulsar la fila abre la issue en el navegador.
4. *Fix with pi* abre un chat nuevo y **escribe** la issue sin enviarla. El usuario la lee y envía. Sin carpeta abierta, con la carpeta sin confianza o con una issue de otro repo, el botón sale apagado con su motivo.
5. Sin red se enseña la última lista, avisando de que es la última. La lista se vuelve a leer cada 5 minutos mientras la columna está abierta.

**Cómo funciona por dentro**

| Pieza | Dónde |
|---|---|
| Servicio (conectar, renovar, leer) | `account/issues/picodeConnectorService.ts` |
| Login (tarjetas de Connections) | `account/picodeConnectionsSection.ts` |
| Paneles de Status y *Fix with pi* | `account/issues/picodeStatusIssues.ts`, `picodeIssueActions.ts` |
| Lógica pura con pruebas | `picodeConnectorAuth.ts`, `picodeIssueSources.ts`, `picodeIssuePrompt.ts` |
| Servidor (secretos de Atlassian y renovación) | `host/cloud/sync-api`: `POST /api/v1/connect/token`, `GET /api/v1/connect/atlassian/callback` |
| Identificadores públicos | `product.json` → `picode.connectors` |

- **GitHub:** GitHub App con inicio por código de un solo uso. Permisos mínimos: *Issues: lectura*. Los repos son los que el usuario eligió al instalarla (`/user/installations`).
- **Jira:** OAuth 2.0 (3LO) con el permiso `read:jira-work` y `offline_access`. El secreto lo guarda el servidor; el editor nunca lo ve. El token se renueva solo (y cambia en cada renovación).
- **Servidor:** exige sesión y plan Pro (`402` si no). No guarda tokens.
- **Tokens del usuario:** cifrados en el almacén de secretos del editor.

**Para activarlo (lo hace el dueño, una vez)**

1. Registrar una **GitHub App** (*Settings → Developer settings*): permiso *Issues: Read-only*, activar *Device flow* (y dejar los tokens con caducidad). Copiar el *Client ID* a `product.json` → `picode.connectors.github.clientId` y, para renovar, el *Client secret* a la variable `GITHUB_CLIENT_SECRET` del servidor (junto con `GITHUB_CLIENT_ID`).
2. Registrar una app **OAuth 2.0 (3LO)** en la consola de Atlassian: permiso *Jira API → read:jira-work*, y como *Callback URL* `https://www.getpicode.app/api/v1/connect/atlassian/callback`. Copiar el *Client ID* a `product.json` → `picode.connectors.atlassian.clientId`, y en el servidor `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` y `ATLASSIAN_REDIRECT_URI`.
3. Desplegar `host/cloud/sync-api` (`vercel deploy --prod`).

Mientras falte el identificador, el conector sale como *Coming soon*.

**Probado (2026-11-06, build portable `experimental` 1.144.8, diseño con el login en Connections y los paneles en Status)**

- ✅ La lista lateral de la ventana tiene solo *Overview*, *Cloud sync*, *Connections* y *Pro features*.
- ✅ Cuenta Pro, sin identificadores registrados: las dos tarjetas dicen *Coming soon* y *Status* no enseña paneles.
- ✅ Con un identificador falso de GitHub solo en la copia compilada: la tarjeta de GitHub pasa a *Connect*, el panel de *Status* sale con *Not connected* y su botón abre la ventana Account (comprobado con la pestaña *Status* abierta y un clic real). *Connect* en la tarjeta hace la petición real y, al rechazarla GitHub, la tarjeta lo dice en una frase.
- ✅ Sin plan Pro (probado en la versión anterior de la pantalla, perfil vacío): bloqueado con un único botón, *Upgrade to Pro*. La tarjeta usa el mismo componente.
- ✅ Pruebas automáticas: 31 del editor (mapeo de issues, limpieza del texto, callback con `state`, código de un solo uso) y 8 del servidor. Tipos del cliente, traducciones a los 13 idiomas y documentación en verde.
- ❌ **No probado de punta a punta:** conectar de verdad, la lista de issues, *Show N more*, *Fix with pi* (incluido que el chat nuevo reciba el texto), el intercambio y la renovación de Jira. Necesitan las dos apps registradas y el servidor desplegado con sus secretos (ver arriba).

**Límites conocidos**

- No se fuerza confirmación de comandos para los reportes externos (el comando del chat no fija el permiso de la sesión): la defensa es no enviar solo, limpiar el texto y marcarlo como datos de un tercero (ADR-042).
- Jira usa el primer sitio al que tiene acceso la cuenta.
- GitHub: hasta 15 repos por lectura y 30 issues por repo.
- Solo lectura: pi no comenta ni cierra la issue.

## Lo que falta

- Subir de las conversaciones solo lo que crece por el final (hoy se sube el fichero entero cuando cambia). La sync por fichero del perfil no compensa: lo que sube pesa menos de 1 MB. Ver ADR-041.
- La línea resumen de la cuenta en la columna *Status*.
- Elegir sitio de Jira cuando la cuenta tiene varios.
