# extensions/ — 🧩 Extensiones built-in (upstream) + la nuestra

**Casi todo lo que hay aquí es upstream**: las extensiones que VS Code trae de serie (`git`, `json`, `markdown`, `typescript-language-features`…), tal como descienden de `upstream/stable.json`. El empaquetador las recoge tal cual.

## ✅ La única nuestra

| Carpeta | Qué es |
| --- | --- |
| [`picode/`](picode/README.md) | **El conector de PiCode**: habla con pi (proveedores, modelos, MCP, agentes, durable) y es la mitad de código que hace que el chat exista. Aquí sí hay ficha por fichero. |

## 📌 Regla para el resto

No se documenta ni se refactoriza lo upstream. Si algo de una built-in tiene que cambiar, el porqué va en el commit y se anota en `docs/DECISIONS.md` si es una decisión.

## 📄 Ficheros de la raíz

| Fichero | Qué hace |
| --- | --- |
| `package.json` / `package-lock.json` | Dependencias y lista de extensiones del monorepo. |
| `esbuild-*.mts` | La configuración de esbuild que todas las built-in comparten. |
| `postinstall.mjs` | Pasos tras `npm ci` (enlaces y ajustes de las built-in). |
| `CONTRIBUTING.md`, `cgmanifest.json` | Reglas upstream de contribución e inventario de terceros. |
