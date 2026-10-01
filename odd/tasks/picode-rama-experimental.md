# Feature: la rama `experimental`

## Goal

> «vamos a hacer una cosa, por ahora dejémoslo, pero planifica una rama "experimental"»
> «Esta rama créala cuando (como te pedí en la otra sesión) borremos todo el repo y dejemos todo
> lo actual en una rama Master y con 1 solo commit»

Planificar una línea de trabajo aparte para lo que **no toca el producto**, y hacerla nacer del
`master` limpio. **Estado: hecho el 2026-10-01** — local y publicado.

## Decisión

- **Pi Durable queda aparcado.** No se implementa ahora: es experimental, salió el mismo día que
  pi 1.0.0, no resuelve ningún problema que el editor tenga hoy, y cambiar el motor del chat
  dejaría a **gentle-ai sin dónde engancharse** (ver «Por qué no ahora»).
- El camino barato sigue siendo el de siempre: **subir el pin de pi**. Ellos mismos dicen que las
  lecciones de Durable volverán al agente de código, y eso llega gratis por esa vía.
- La rama **`experimental`** nace del commit raíz de `master`. Es el vehículo para probar esto — y
  lo que venga — sin ensuciar `master`.

## Por qué no ahora (lo medido, para no re-litigarlo)

| Dato | Valor |
| --- | --- |
| Paquete | `@earendil-works/pi-durable@1.0.0`, publicado el **2026-10-01** (el mismo día que pi 1.0.0) |
| Estado | **Experimental**: ellos avisan de que la API puede cambiar |
| ¿Viene con pi? | **No**: comprobado dentro del paquete de pi 1.0.0, no hay ni rastro |
| ¿Depende del agente de código? | **No**: trae su propio motor de modelos y herramientas (deps: `pi-ai`, `chord`, `typebox`, `diff`) |
| Lo que reutiliza de PiCode | **Nada** de lo ya montado: proveedores, perfiles, MCP, credenciales y ajustes habría que rehacerlos sobre su API |
| Choque con gentle-ai | **Sí, por capa**: gentle-ai se engancha a la superficie de extensiones de **pi**; Durable tiene la suya (`defineExtension`, `defineTask`, `defineTool`). Una conversación corre sobre **un** motor, no sobre dos |

Y el detalle que lo resume: el ejemplo que enseñan (el planificador de vacaciones) son ~1.300
líneas y **la mayoría es interfaz**. Poner el chat del editor encima de esto es reescribir el motor
del chat, no enchufar una pieza.

## Por qué una rama aparte y no una rama de feature

Una rama de feature se abre para llevar algo a `master`. Esta no: es un **banco de pruebas**. La
diferencia importa porque PiCode tiene una regla que no se rompe desde una rama — **un solo Pi
dentro del editor, con agents, skills y gentle-ai**. Un experimento que cambia el motor es una
línea paralela, no una tarea.

## El reset del repositorio

### Local: hecho el 2026-10-01

- `master` es **un único commit raíz** («initial commit»), sin padres.
- Su árbol (`6018bd16`) es **idéntico al que había**, incluida la obra que estaba sin commitear en
  `cloud/sync-api`. Comprobado antes de firmar: el diff contra el tip anterior son exactamente esos
  6 ficheros, ni uno más.
- `experimental` nace de ese commit.
- Se borraron las ramas absorbidas (`docs/github-docs-wiki`, `feat/picode-distribution`,
  `feat/picode-foundation`, `feat/source-in-repo`).
- Red de seguridad intacta y **local**: ramas `backup-before-squash` (`fc15cb50`), `backup-final`
  (`a815a86e`), `backup-pre-reset` (`227a5ff9`), `backup-reset-2026-10-01` (`36b19e19`) y
  `.scratch/pre-reset-history-full.bundle` (43 MB, «records a complete history»).

### Remoto: hecho, con una salvedad

- Las tres ramas viejas se borraron: del remoto cuelga solo `master`.
- `origin/master` es **el mismo commit raíz** (un solo commit, 11.974 ficheros).
- El force-push necesitó levantar un *ruleset* que protegía la rama por defecto. GitHub lo rechazaba
  con «push declined due to repository rule violations», que **no** era falta de permisos sino una
  regla del repositorio.
- ⚠️ **Salvedad**: GitHub conserva además las referencias de sus *pull requests*
  (`refs/pull/*/head`: 15, todas **cerradas** y casi todas de Dependabot), y apuntan a commits
  viejos. No se borran desde `git`; solo desaparecen recreando el repositorio, o pidiéndolo a soporte
  de GitHub. Mientras estén, la historia vieja sigue siendo *alcanzable* aunque no haya ramas que la
  nombren.

## La rama

```bash
# ya hecha
git branch experimental master
# ¿subirla? decisión del dueño: por defecto NO (los experimentos no ensucian el remoto público)
```

## Contrato de la rama

1. 🚫 **Nunca se fusiona entera en `master`.** Si un experimento madura, se rehace como unidades de
   trabajo sobre una rama de feature desde `master`, con sus tests y su revisión (ODD).
2. 🧪 **Puede romperse** y seguir la API experimental de Durable: aquí el pin puede ir flojo y
   actualizarse a menudo; en `master` no.
3. 1️⃣ **No cambia la regla del único Pi.** Que un experimento funcione no convierte a Durable en el
   motor del editor: eso sería una decisión de producto, no un resultado de rama.
4. 🧩 **No exige gentle-ai.** Si un experimento necesita agents, skills o memoria de gentle, portarlos
   es trabajo del propio experimento, no un requisito de la rama.
5. 🧼 **No toca el perfil interno del producto** (`data/pi-agent`) salvo que sea el objetivo del
   experimento; lo normal es un perfil propio para no contaminar el del dueño.
6. ✅ `master` siempre construye; `experimental` **no tiene por qué**.

## El primer experimento

Un **programa aparte**, no el chat del editor: reutilizar la demo de ellos (el agente pequeño o el
planificador) y comprobar en la máquina del dueño las tres promesas que justifican todo esto:

1. una conversación **sobrevive al cierre del proceso** y sigue donde estaba,
2. un **subagente** es una tarea en segundo plano que no bloquea,
3. **dos clientes** se enganchan a la misma conversación en vivo.

Si eso no se sostiene en la práctica, la rama se borra y no se perdió nada.

## Qué decidiría si esto alguna vez importa

El umbral no es «me gusta». Es tener un producto donde el agente **corre solo y lejos del editor**:
agentes en la nube, varias personas sobre las mismas conversaciones, o algo que deba aguantar
caídas de verdad. Ahí Durable encaja y **no choca con nada**, porque sería **otra superficie**, no
el chat del editor. Antes de eso, este documento es la respuesta.
