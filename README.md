# Figma → Affinity (beta 0.2.0)

Converts Figma designs into **editable** Affinity documents. Artboards, text, shapes, curves, images, masks, gradients, shadows and guides become native Affinity objects, not flattened images.

Hướng dẫn tiếng Việt: see [HUONG-DAN.md](HUONG-DAN.md). The plugin and script interfaces are currently in Vietnamese; this file explains every step in English.

Two parts:

- `figma-plugin/`: a Figma plugin that exports the selected frames to a `.figaf` file.
- `affinity-script/figaf-import.js`: a script for **Affinity 3.3 or later** that reads the `.figaf` file and rebuilds it as an Affinity document.

> This is a beta. Compare the result with Figma before handing files to a client, and report issues as described below.

## 1. Install (once)

### Figma plugin

1. Unzip the package and keep `manifest.json`, `code.js` and `ui.html` together in `figma-plugin`.
2. Open the **Figma desktop app**. Plugins imported from a manifest only run in the desktop app.
3. In any file, go to **Plugins → Development → Import plugin from manifest…** and pick `manifest.json`.
4. The plugin appears under **Plugins → Development → Figma to Affinity (beta)**.

### Affinity script

1. Open Affinity and switch to **Scripting Studio**.
2. Create a new script, paste the whole content of `figaf-import.js`, and save it to your script library.
3. Grant file access. Without both steps the script fails with `PERMISSION_DENIED`:
   - **Settings → Scripting → File System access**: add the folder where you will put `.figaf` files (for example your Desktop). The list is empty by default.
   - In Scripting Studio, click the script's **gear icon** and enable **File System** permission.

## 2. Use

1. In Figma, select one or more frames. Each frame becomes an artboard.
2. Run the plugin and click the export button ("Xuất frame đang chọn"). Move the downloaded `.figaf` file into the folder you granted access to.
3. In Affinity, run the script and pick the `.figaf` file. A new document is created.
4. Check the result and save it with **File → Save As** as `.af`.

The script writes a report, `… - bao cao chuyen doi.txt`, to your Desktop. It lists missing fonts, failed layers, and anything skipped or simplified, with layer names so you can fix them by hand.

## 3. What converts

| Figma | Affinity |
|---|---|
| Top-level frame | Artboard with background |
| Nested frame | Clipping shape (when Clip content is on) or a group with a background |
| Group | Group |
| Rectangle, ellipse | Native shape with per-corner radius (editable) |
| Vector, star, polygon, boolean | Curves, editable node by node |
| Text | Editable text with font, size, colour, letter spacing, line height, paragraph spacing, alignment and mixed styles. Auto-width single lines become Artistic Text, the rest Frame Text at the Figma width |
| Image fills (fill / fit / crop) | Original image (up to 4096 px on the long side), placed whole inside its frame so it can be re-cropped |
| Masks | Affinity mask layers |
| Multiple fills on one shape | A group of stacked shapes, one per fill |
| Linear / radial / angular gradients | Linear / radial / conical gradients |
| Drop shadow, inner shadow, layer blur | Layer effects. Extra drop shadows and zero-blur shadows are built as shape copies underneath, named with "bóng" |
| Strokes | Strokes with weight, alignment, caps and joins |
| Column/row layout grids, guides | Guides |

## 4. Known limitations

- **Auto layout** becomes fixed positions. Components, variants and instances become plain groups. Variables and prototypes are not converted.
- **Not converted** (listed in the report): background blur, blend modes, square grids, text underline, more than one inner shadow on a layer.
- **Simplified:** dashed strokes become solid. Corner smoothing (iOS-style corners) becomes plain rounded corners. UPPER/lower text case is applied to the characters. Luminance masks become shape masks.
- **Fonts:** the machine opening the file needs the same fonts as in Figma. CJK characters set in a font that lacks them (such as Inter) render differently in each app. Pick a CJK font or outline the text.
- Text can sit 1–2 px off vertically because the two apps compute line height differently.
- Two shapes with exactly matching edges can show a sub-pixel hairline when zoomed in. It usually disappears in exports at actual size; enlarging the lower shape by about 1 px removes it.

## 5. Options

At the top of `figaf-import.js`:

| Option | Default | Meaning |
|---|---|---|
| `ROUND_TO_PIXEL` | `true` | Round positions and sizes to whole pixels. Shapes may move up to 0.5 px |
| `MASK_AS_LAYER` | `true` | Build masks as mask layers. `false` clips content into the shape instead |
| `ADD_GUIDES` | `true` | Turn layout grids and guides into guides |
| `SHADOW_BLUR_SCALE` | `1.0` | Shadow blur multiplier |
| `DEBUG` | `false` | Print per-layer details to the console, for bug reports |

## 6. Reporting issues

When the result differs from Figma, please send:

1. **Side-by-side screenshots** of Figma and Affinity for the same area.
2. **The report file** `… - bao cao chuyen doi.txt` from your Desktop. Its first line shows the plugin and script versions.
3. **The detailed log:** set `DEBUG = true` at the top of the script, run it again, and copy the whole Scripting Studio console.
4. If possible, the `.figaf` file or the Figma file (just the broken part).

## License

MIT, see [LICENSE](LICENSE).
