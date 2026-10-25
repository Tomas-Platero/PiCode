# Tabler icon set (outline)

The Activity Bar stops using the Codicon glyph font and paints these outline
drawings instead. They are used as CSS masks, so the visible colour always comes
from the theme (`activityBar.foreground` / `activityBar.inactiveForeground`), the
same as every other icon in the workbench.

| File               | Activity Bar item            |
|--------------------|------------------------------|
| `folders.svg`      | Explorer                     |
| `search.svg`       | Search                       |
| `git-branch.svg`   | Source Control               |
| `bug.svg`          | Run and Debug                |
| `puzzle.svg`       | Extensions                   |
| `settings.svg`     | Manage / Settings (bottom)   |

## Geometry

- `viewBox="0 0 24 24"`, `fill="none"`, `stroke-width="2"`, round caps and joins:
  the upstream Tabler drawing, unmodified.
- Rendered at the Activity Bar's 24 px icon size (`--activity-bar-icon-size`), so the
  visible stroke is exactly 2 px — the same weight as the PiCode mark, which was re-stroked
  for that size.
- The stroke colour is opaque black on purpose. A mask only reads the alpha
  channel, so the value never reaches the screen; it is set explicitly to keep
  the files readable outside the editor.

## Source and licence

Icons from [Tabler Icons](https://tabler.io/icons) v3, `icons/outline/`.

```
MIT License

Copyright (c) 2020-2024 Paweł Kuna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
