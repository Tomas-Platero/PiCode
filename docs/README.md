# Índice de documentación interna

Los papeles que deciden **cómo se junta todo**. Las palabras del dueño viven en
[`AGENTS.md`](../AGENTS.md); el registro de cada feature, en [`odd/tasks/`](../odd/tasks/);
la cara pública (README, wiki) se escribe desde aquí, no al revés.

| Documento | De qué habla | Idioma |
| --- | --- | --- |
| [VISION.md](VISION.md) | La visión del dueño: qué quiere que PiCode llegue a ser | ES |
| [DISENO.md](DISENO.md) | Cómo se junta todo hoy: capas, núcleo, perfil, reglas de diseño | ES |
| [ARCHITECTURE.md](ARCHITECTURE.md) | El modelo de 4 capas, la capa de agente, el contrato RPC, testing | EN |
| [DECISIONS.md](DECISIONS.md) | Los ADR (001–012): qué se decidió, por qué, y qué lo revertiría | EN |
| [DISTRIBUTION.md](DISTRIBUTION.md) | El árbol propio: delta de producto, perfil portable, verificación | EN |
| [howto-build.md](howto-build.md) | Compilar desde la fuente: pins, parches, reparación, verificación | ES |
| [CI.md](CI.md) | La vigilancia del pin: los tres workflows, cachés, política de urgencia | ES |
| [PI-Y-GENTLE-AI.md](PI-Y-GENTLE-AI.md) | Qué son pi y Gentle-AI por dentro, medido contra la instalación real | ES |
| [TAREAS.md](TAREAS.md) | **La única lista de qué queda.** Si un papel de `odd/tasks/` dice otra cosa, gana este | ES |

## Cómo se lee esto sin perderse

1. ¿**Qué es PiCode** y por qué existe? → `VISION.md`, luego el README.
2. ¿**Cómo está montado** hoy? → `DISENO.md` (capas) y `ARCHITECTURE.md` (mecánica).
3. ¿**Por qué así y no de otra forma**? → `DECISIONS.md`. Cada ADR lleva sugatilla de
   reversión: cuándo deja de pagar la decisión.
4. ¿**Cómo lo compilo yo**? → `howto-build.md`. ¿Por qué falla CI? → `CI.md`.
5. ¿**Qué queda por hacer**? → `TAREAS.md`. Nada más. Los `odd/tasks/*.md` son el *cómo se
   llegó aquí*, con sus errores incluidos; útiles antes de re-decidir algo que ya se
   decidió, no para saber el estado.

## Orden de precedencia (por si dos papeles discuten)

```text
AGENTS.md (dueño)  >  TAREAS.md (lista)  >  DECISIONS.md (porqués)  >  DISENO/ARCHITECTURE
(dónde va cada cosa)  >  DISTRIBUTION / howto-build / CI (mecánica)  >  odd/tasks/* (historia)
```

## Mantenimiento

- Un cambio de decisión **exige** ADR nuevo o enmienda, con la frase del dueño si la hay.
- Un cambio de mecanismo exige tocar el papel de mecánica **y** el README/wiki si afecta a
  lo que ve quien colabora.
- El detalle de cada feature **no** sube aquí: se queda en su papel de `odd/tasks/`.
