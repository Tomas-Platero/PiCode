# Feature: pi 1.0.2 en el pin

**Estado:** cerrada · **Rama:** `master` · **Abierta:** 2026-10-04

## Intención del dueño

> «he tenido que reiniciarte por que ha salido pi 1.0.1, toma esto en cuenta y actualiza»

Subir el pi que PiCode se lleva dentro (`distribution/runtime.json`) a la última publicada y
decidir, con el changelog delante, si ese escalón obliga a tocar algo de la app. Es el mismo
trabajo que `picode-pi-101.md` (1.0.1) y `picode-pi-1000.md` (1.0.0).

**Matiz medido antes de tocar nada:** el repositorio **ya estaba en 1.0.1** (pin del 2026-10-03,
`picode-pi-101.md`). La última publicada en npm es **1.0.2** (`dist-tags.latest`), publicada el
2026-10-04, y es la que trae el propio harness del dueño
(`…/.pi/agent/install/releases/1.0.2`). Así que el escalón de esta tarea es **1.0.1 → 1.0.2**.

## Lo que se midió antes de tocar nada (2026-10-04)

Medido contra el paquete real `@earendil-works/pi-coding-agent@1.0.2` (el instalado por el
harness), no contra una nota.

| Dato | Valor |
| --- | --- |
| Última publicada | **1.0.2** (`npm registry`, `dist-tags.latest`) |
| Pin del repositorio | **1.0.1** |
| Las 7 entradas del SDK que resuelve el conector | presentes (`createAgentSessionServices`, `createAgentSessionFromServices`, `createMcpExtension`, `createCodemodeExtension`, `createToolSearchExtension`, `SessionManager`, `main`) |
| `dist/cli.js` | presente |

### El changelog de 1.0.2, punto por punto

Solo trae una novedad:

> **Sampling by thinking level** — `samplingParamsByThinkingLevel` en `models.json` fija parámetros
> de muestreo (`temperature`, `top_p`) por nivel de pensamiento en APIs compatibles con OpenAI.

No hay cambios de contrato del SDK, ni de la TUI que el chat use, ni de MCP. El validador de MCP de
1.0.2 se pasa por los **12** escritores de PiCode y sigue **rechazando** las dos grafías heredadas
que el check usa como control (`dev/check-mcp-entries.mjs`, medido contra 1.0.2).

## Decisión

### 1. El pin sube a 1.0.2

`distribution/runtime.json` → `1.0.2`. El runtime del pack se refresca con el paso real del build
(`dev/pi-runtime.sh`), que compara la versión instalada con el pin y reinstala cuando no coincide.

### 2. El único cambio de la app: un campo por modelo sobrevive a la proyección

`mergeModelsFile` (`declarations.ts`) es lo único en PiCode que reescribe el `models.json` de pi.
Reemplazaba la lista `models` del proveedor por lo que la fila de ajustes nombraba —`id` y, si
acaso, `name`—, así que **cualquier campo por modelo que el dueño hubiera escrito a mano se
perdía** en la siguiente conexión. Con 1.0.2 eso deja de ser teórico: `samplingParamsByThinkingLevel`
es exactamente un campo así, y también lo son `contextWindow`, `reasoning` o los `samplingParams`
que pi ya admitía.

Ahora la entrada del modelo **en disco es la base** y el borrador solo pisa lo que nombra:

```ts
models: models.map(model => ({
	...(previousModelById.get(model.id) ?? {}),
	id: model.id,
	...(model.name === undefined ? {} : { name: model.name }),
})),
```

Un modelo que el borrador **ya no nombra** sí se va: la lista del proveedor manda sobre qué
modelos expone. Es la misma regla que ya se aplicaba a `apiKey`/`authHeader` del proveedor.

Pruebas: `test/declarations.test.ts`.

### 3. Exponer `samplingParamsByThinkingLevel` en la interfaz queda fuera

Sería una función de producto (un formulario por modelo), no una actualización del pin. Se deja
anotado como posible siguiente paso; lo que sí era obligatorio —no borrarlo— está hecho.

## Verificación

- Las 7 entradas del SDK y `dist/cli.js` de 1.0.2: presentes.
- MCP: 12/12 escritores aceptados, 2/2 controles rechazados por el validador de 1.0.2.
- Tests del conector: todos en verde (incluidos los 3 nuevos de `mergeModelsFile`).
- `tsc -p extensions/picode/tsconfig.json --noEmit` y el typecheck de tests: en verde.
