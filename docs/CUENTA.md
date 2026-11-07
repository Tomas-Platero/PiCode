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

1. En *Connections*, cada tarjeta (GitHub, Jira) tiene *Connect*. En GitHub, el editor copia un código, abre la página de GitHub y deja el código en la tarjeta por si hace falta de nuevo. Al terminar, si la App de PiCode aún no está instalada en sus repositorios (sin instalar no se ve ninguno), abre sola la página para instalarla y las issues salen en cuanto se instala; si luego falta, el panel lo dice con un botón *Install on GitHub*. En Jira se abre la página de Atlassian y, al aceptar, vuelve solo al editor. Conectada, la tarjeta dice *Connected* (en Jira, a qué sitio) y tiene *Disconnect*. Un intento fallido lo dice en una frase.
2. En *Status* aparece un panel por servicio conectado (*GitHub issues*, *Jira issues*): las 5 issues abiertas más recientes, con *Show N more*, y *Refresh*. Las del proyecto abierto van primero; en GitHub, hasta 15 repos. Sin conectar, el panel dice *Not connected* y su botón *Connect* abre la ventana Account. Sin plan Pro o sin identificadores registrados, el panel no sale.
3. Pulsar una issue abre el visor (ver abajo). Cada issue ocupa dos líneas: el título entero (hasta dos líneas) y debajo, en pequeño, su etiqueta (si el título empieza por `[algo]`, sale como etiqueta y no come espacio), la clave, la antigüedad y *Outside report* si la escribió alguien ajeno al equipo. A la derecha, *Fix with pi* es un botón solo de icono (el texto sale al pasar el ratón). El título del panel lleva el total de issues abiertas.
4. *Fix with pi* abre un chat nuevo y **escribe** la issue sin enviarla. El usuario la lee y envía. Sin carpeta abierta, con la carpeta sin confianza o con una issue de otro repo, el botón sale apagado con su motivo.
5. Sin red se enseña la última lista, avisando de que es la última. La lista se vuelve a leer cada 5 minutos mientras la columna está abierta.

**Qué proyecto enseña cada panel de Status**

> *"sería factible que solo se vean los issues del proyecto en el que estamos"* — 2026-11-07

Cada panel se limita a **la carpeta abierta**, y la elección se recuerda por carpeta. **GitHub:** solo el repositorio de la carpeta (se sabe por su `origin`); un desplegable pegado al botón del título (con la opción actual marcada) cambia entre *This repository* y *All repositories*, y solo sale si la carpeta es un repositorio de GitHub. Si la App no está instalada en **la cuenta dueña de ese repositorio** (instalarla en otra cuenta tuya no sirve: cada cuenta u organización tiene su propia instalación), lo dice y ofrece instalarla. **Jira:** una carpeta no está ligada a ningún espacio, así que se **vincula una vez**: el botón del título (*All projects*) abre un desplegable con los espacios del sitio de Jira, pegado al propio botón y con el elegido marcado; elegir uno lo recuerda para esa carpeta y el panel solo enseña sus issues. Si la rama actual se llama como una issue (`feature/ATW-52-…`) y ese espacio existe, se vincula solo la primera vez. El último elemento del desplegable, *Create a space in Jira…*, abre la página de espacios de Jira para crear uno; crearlo desde PiCode pediría permisos de administrador de Jira que no se han comprobado. Al volver, se elige en el mismo desplegable.

**El visor de issues**

> *"Me gustaría que cuando le des a una issue se abra un visualizador. Dependiendo si es de github o jira se verán x cosas."* — 2026-11-07

Pulsar una issue de *Status* abre una pestaña del editor con el proyecto entero y la issue pulsada en una **ventana flotante** en el centro (se cierra con la X, `Esc` o pulsando fuera): resumen, descripción, estado, tipo, prioridad, asignado, informador, etiquetas y fechas, con *Fix with pi* y *Open in browser*. Pulsar otra issue del mismo proyecto reutiliza la pestaña.

**Editar una issue:** en la ventana todo se cambia en el sitio y cada cambio se guarda al hacerlo, se ve al instante y, si el servicio lo rechaza, vuelve atrás y lo dice. **Jira:** resumen, descripción, tipo, prioridad, asignado, informador y etiquetas. **GitHub:** título, descripción, etiquetas (con las del repositorio como sugerencia) y asignado. El asignado y el informador de Jira se eligen en una lista que ya trae a las personas del proyecto y busca en Jira a quien se escriba (pide un permiso aparte, ver abajo). La descripción de Jira solo se edita si es texto sin formato; si trae listas, enlaces, código o menciones se muestra tal cual y se dice que se edita en Jira, para no aplanarla al guardar. En Jira se pide el mismo permiso de escritura que arrastrar tarjetas (*Allow* la primera vez); en GitHub, que la App tenga permiso de escritura de issues (ver abajo).

| | Jira | GitHub |
|---|---|---|
| Qué se abre | El proyecto (*Space*) de la issue | El repositorio de la issue |
| Vista | **Board** (Kanban) para espacios de software, **List** para el resto; un interruptor cambia de una a otra | **List**, con *Open* y *Closed* y su recuento |
| Columnas | Las del tablero de Jira, en su orden y con las vacías también (se lee la configuración del tablero; pide un permiso aparte, ver abajo) | — |
| Tarjeta / fila | Título, etiquetas, tipo, clave, prioridad y asignado | Número, título, etiquetas, asignado, comentarios y antigüedad |
| Búsqueda | Por clave, título, estado, asignado, tipo o etiqueta | Igual |

**Permisos de Jira que se piden aparte (solo cuando hacen falta):** leer el tablero, para pintar sus columnas (*Allow* en el aviso del tablero: `read:board-scope:jira-software`, `read:board-scope.admin:jira-software`, `read:project:jira`), y cambiar issues (`write:jira-work`) junto con buscar personas (`read:jira-user`), la primera vez que se arrastra una tarjeta o se edita un campo. Un nuevo *Allow* mantiene lo ya permitido. Los nombres vienen de las listas de la propia consola de Atlassian y de su especificación; `read:jira-user` para buscar usuarios no se pudo confirmar en su documentación, así que si Atlassian lo rechazara, el visor lo diría.

**Mover tarjetas (solo Jira):** en el tablero, arrastrar una tarjeta a otra columna cambia el estado de la issue en Jira. La primera vez el visor pide permiso para cambiar issues (*Allow*, vuelve a abrir la página de Atlassian) y reintenta el movimiento al aceptarlo. La tarjeta se mueve al instante; si Jira no permite ese paso desde el estado actual, vuelve a su columna y lo dice. Solo cambia de estado: no comenta, no edita, no crea.

Límites: hasta 300 issues por proyecto (lo avisa); sin el permiso de tableros el visor lo dice y usa los estados del proyecto, sin hacerlos pasar por las columnas de Jira; la descripción de GitHub se edita como Markdown sin vista previa.

**Cómo funciona por dentro**

| Pieza | Dónde |
|---|---|
| Servicio (conectar, renovar, leer) | `account/issues/picodeConnectorService.ts` |
| Login (tarjetas de Connections) | `account/picodeConnectionsSection.ts` |
| Paneles de Status y *Fix with pi* | `account/issues/picodeStatusIssues.ts`, `picodeIssueActions.ts` |
| Visor (pestaña del editor) | `account/issues/picodeIssuesEditor.ts`, `picodeIssuesEditorInput.ts`, `picodeIssues.contribution.ts` (comando `picode.issues.open`) |
| Lógica pura con pruebas | `picodeConnectorAuth.ts`, `picodeIssueSources.ts`, `picodeIssueBoard.ts`, `picodeIssuePrompt.ts` |
| Servidor (secretos de Atlassian y renovación) | `host/cloud/sync-api`: `POST /api/v1/connect/token`, `POST /api/v1/connect/github`, `GET /api/v1/connect/atlassian/callback` |
| Identificadores públicos | `product.json` → `picode.connectors` |

- **GitHub:** GitHub App con inicio por código de un solo uso. Las páginas de login de GitHub no admiten llamadas desde la ventana del editor (sin permiso entre orígenes: «Failed to fetch», visto el 2026-11-06), así que el editor pide el código y la espera por el servidor (`connect/github`), que no guarda nada. Permisos mínimos: *Issues: lectura*. Los repos son los que el usuario eligió al instalarla (`/user/installations`).
- **Jira:** OAuth 2.0 (3LO) con el permiso `read:jira-work` y `offline_access`. El secreto lo guarda el servidor; el editor nunca lo ve. El token se renueva solo (y cambia en cada renovación).
- **Servidor:** exige sesión y plan Pro (`402` si no). No guarda tokens.
- **Tokens del usuario:** cifrados en el almacén de secretos del editor.

**Para activarlo (lo hace el dueño, una vez)**

1. Registrar una **GitHub App** (*Settings → Developer settings*): permiso *Issues: Read and write* (*Read-only* basta para ver las issues; para editarlas desde el visor hace falta escritura, y el dueño de cada instalación debe aceptar el cambio), activar *Device flow* (y dejar los tokens con caducidad). **Hacerla pública** (*Advanced → Make public*), porque si no solo la puede instalar su dueño. Copiar el *Client ID* a `product.json` → `picode.connectors.github.clientId` y el nombre de su dirección pública (`github.com/apps/<nombre>`) a `appSlug` (hoy `picode-editor`), que es a donde se manda a instalarla y, para renovar, el *Client secret* a la variable `GITHUB_CLIENT_SECRET` del servidor (junto con `GITHUB_CLIENT_ID`).
2. Registrar una app **OAuth 2.0 (3LO)** en la consola de Atlassian. En *Permissions → Jira API → Configure*: en **Classic scopes** `read:jira-work`, `write:jira-work` y `read:jira-user`; en **Granular scopes** `read:board-scope:jira-software`, `read:board-scope.admin:jira-software` y `read:project:jira`. Como *Callback URL* `https://www.getpicode.app/api/v1/connect/atlassian/callback`. Copiar el *Client ID* a `product.json` → `picode.connectors.atlassian.clientId`, y en el servidor `ATLASSIAN_CLIENT_ID`, `ATLASSIAN_CLIENT_SECRET` y `ATLASSIAN_REDIRECT_URI`. Los permisos de escribir, de buscar personas y de tableros solo se piden al usuario cuando los necesita (ADR-042, adendas 4 a 7).
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
- Pi no comenta ni cierra issues. Lo único que se escribe en Jira es el cambio de estado al arrastrar una tarjeta, y solo con el permiso que el usuario da la primera vez.

## Lo que falta

- Subir de las conversaciones solo lo que crece por el final (hoy se sube el fichero entero cuando cambia). La sync por fichero del perfil no compensa: lo que sube pesa menos de 1 MB. Ver ADR-041.
- La línea resumen de la cuenta en la columna *Status*.
- Elegir sitio de Jira cuando la cuenta tiene varios.
