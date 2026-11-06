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

## Lo que falta

- Subir de las conversaciones solo lo que crece por el final (hoy se sube el fichero entero cuando cambia). La sync por fichero del perfil no compensa: lo que sube pesa menos de 1 MB. Ver ADR-041.
- Los conectores de issues son solo el hueco: su lógica llega en su propio trabajo.
- La línea resumen de la cuenta en la columna *Status*.
