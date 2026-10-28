# resources/picode/ — 🎨 La marca del repositorio

**Las imágenes del propio repositorio** (no las del producto): lo que se ve en el README público y en la cabecera de GitHub.

| Fichero | Qué hace |
| --- | --- |
| `picode-banner.png` | La cabecera del README (en inglés). Se genera con `python resources/picode/banner.py`; no se retoca a mano. |
| `banner.py` | El generador de esa cabecera: texto, colores y marca en un solo sitio. |
| `pi.svg` | La marca de pi, cuando hay que citarla. |
| `vscodium.svg` | La marca de VSCodium, de la que procede el árbol. |

⚠️ **Los iconos del producto no viven aquí**: están en [`build/distribution/`](../../build/distribution/README.md) (`picode.ico`, `picode.svg`, `picode-icon.svg`) y en `extensions/picode/media/` (marca de la barra de actividad, con su pareja claro/oscuro).

**Cuándo se toca:** al cambiar la imagen del README o añadir una cuenta la marca. Nada de esto entra en la build.
