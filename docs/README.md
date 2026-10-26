# Índice de documentación interna

Los papeles que deciden **cómo se junta todo**. Las palabras del dueño viven en
[`AGENTS.md`](../AGENTS.md); la cara pública (README, wiki) se escribe desde aquí, no al revés.

| Documento | De qué habla | Idioma |
| --- | --- | --- |
| [VISION.md](VISION.md) | 🌱 La visión del dueño: qué quiere que PiCode llegue a ser | ES |
| [DISENO.md](DISENO.md) | 🧱 Cómo se junta todo hoy: capas, núcleo, perfil, reglas de diseño | ES |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 🏗️ El modelo de 4 capas, la capa de agente, el SDK de pi, testing | EN |
| [DECISIONS.md](DECISIONS.md) | ⚖️ Los ADR (001–021): qué se decidió, por qué, y qué lo revertiría | EN |
| [DISTRIBUTION.md](DISTRIBUTION.md) | 📦 El árbol propio: delta de producto, perfil portable, verificación | EN |
| [howto-build.md](howto-build.md) | 🔨 Compilar desde la fuente: dependencias, fases, reparación, verificación | ES |
| [CI.md](CI.md) | 🧪 La build y las releases en GitHub: workflows, cachés, política de urgencia | ES |
| [HARNESS.md](HARNESS.md) | 🤖 Cómo está integrado hoy el harness de agentes: las capas de pi | ES |
| [TAREAS.md](TAREAS.md) | 📋 **La única lista de qué queda.** Si otro papel dice otra cosa, gana este | ES |
| [SETTINGS.md](SETTINGS.md) | ⚙️ El inventario de **todas** las opciones: clave, para qué, dónde aparece y dónde debe aparecer, con lo que se oculta y lo que no se toca | ES |
| [ENGRAM.md](ENGRAM.md) | 📚 La memoria del producto: pi y engram, decisiones y tareas punto por punto | ES |
| [MAPA.md](MAPA.md) | 🗺️ **Qué hace cada carpeta y cada fichero de la raíz** — generado a partir de los README de cada carpeta | ES |

## Cómo se lee esto sin perderse

0. ¿**Qué está pasando ahora mismo**? → `TAREAS.md` (qué queda); el historial de git y las páginas de release cuentan cómo se llegó.

1. ¿**Qué es PiCode** y por qué existe? → `VISION.md`, luego el README.
2. ¿**Cómo está montado** hoy? → `DISENO.md` (capas) y `ARCHITECTURE.md` (mecánica).
3. ¿**Por qué así y no de otra forma**? → `DECISIONS.md`. Cada ADR lleva su estado (qué lo
   sustituye) y su condición de reversión: cuándo deja de pagar la decisión.
4. ¿**Cómo lo compilo yo**? → `howto-build.md`. ¿Por qué falla CI? → `CI.md`.
5. ¿**Qué queda por hacer**? → `TAREAS.md`. Nada más. El historial de git y las páginas de
   release son el *cómo se llegó aquí*, con sus errores incluidos; útiles antes de re-decidir
   algo que ya se decidió, no para saber el estado.

## Orden de precedencia (por si dos papeles discuten)

```text
AGENTS.md (dueño)  >  TAREAS.md (lista)  >  DECISIONS.md (porqués)  >  DISENO/ARCHITECTURE
(dónde va cada cosa)  >  DISTRIBUTION / howto-build / CI (mecánica)  >  git / release notes (historia)
```

## Mantenimiento

- Un cambio de decisión **exige** ADR nuevo o enmienda, con la frase del dueño si la hay.
- Un cambio de mecanismo exige tocar el papel de mecánica **y** el README/wiki si afecta a
  lo que ve quien colabora.
- El detalle de cada feature **no** sube aquí: se queda en su papel dentro de `docs/`.
- **Documentación por carpeta:** cada carpeta lleva su `README.md` al lado (una frase de qué
  hace, qué hay dentro). De ahí sale el árbol de [`MAPA.md`](MAPA.md), que se regenera con
  `node build/docs.mjs map`; las carpetas nuevas sin ficha las ve CI (`node build/docs.mjs check`,
  con la lista de excepciones en `.docsignore`).
