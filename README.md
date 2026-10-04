# Figma → Affinity (beta 0.2.0)

Converts Figma designs into **editable** Affinity documents. Artboards, text, shapes, curves, images, masks, gradients, shadows and guides become native Affinity objects, not flattened images.

Hướng dẫn tiếng Việt: see [HUONG-DAN.md](HUONG-DAN.md). The plugin and script interfaces are currently in Vietnamese; this file explains every step in English.

Two parts:

- `figma-plugin/`: a Figma plugin that exports the selected frames to a `.figaf` file.
- `affinity-script/figaf-import.js`: a script for **Affinity 3.3 or later** that reads the `.figaf` file and rebuilds it as an Affinity document.

> This is a beta. Compare the result with Figma before handing files to a client, and report issues as described below.

## 1. Install (once)

Download `figma-to-affinity-0.2.0-beta.zip` from the [Releases](https://github.com/nhaajtasnh/figma-to-affinity/releases) page and unzip it. You get a `figma-plugin` folder and `affinity-script/figaf-import.js`.

### Step 1. Add the plugin to Figma

1. Open the **Figma desktop app**. Plugins imported from a manifest only run in the desktop app, not in the browser.
2. Open any design file.
3. From the menu, choose **Plugins → Development → Import plugin from manifest…**
4. Pick `manifest.json` inside `figma-plugin`. Keep `manifest.json`, `code.js` and `ui.html` together in the same folder.
5. The plugin now lives under **Plugins → Development → Figma to Affinity (beta)**.

### Step 2. Turn on scripting and allow a folder in Affinity

Affinity only lets scripts read files in folders you allow. That list is **empty** by default, so add a folder first or the script fails with `PERMISSION_DENIED`.

This guide uses your **Desktop**, which is also where the plugin tells you to put the file. Any folder works as long as you put the `.figaf` file in that same folder later.

1. Open Affinity's **Settings**: on Mac, **Affinity → Settings…** (`⌘ ,`); on Windows, **Edit → Settings…**
2. Follow the numbers in the screenshot:

![Settings → Scripting in Affinity](docs/images/affinity-settings.png)

| # | What to do |
|---|---|
| 1 | Select **Scripting** in the left column. |
| 2 | Turn on **Enable Affinity Scripting**. |
| 3 | Turn on **Access the file system**. New scripts then get file access by default. |
| 4 | This is the **File System access** list. It starts empty, as in the screenshot. |
| 5 | Click **Add**, choose your **Desktop** folder and click **Open**. Its path (for example `/Users/your-name/Desktop`) appears in list 4. |

3. Close Settings.

### Step 3. Add the script to Affinity

1. In Affinity, switch to **Scripting Studio**.
2. Create a new script. Open `figaf-import.js` in a text editor (TextEdit, Notepad, VS Code…), copy **all** of it and paste it into the script.
3. Save the script to your library so you can run it again later.
4. Check the script's permissions:

![The script's File System permission](docs/images/affinity-gear.png)

| # | What to do |
|---|---|
| 1 | Click the **gear icon** next to Run. |
| 2 | Tick **File System** under *Script permissions*. It is already ticked if you turned on 3 in Step 2. |
| 3 | **Run** starts the script (see Use below). |

## 2. Use

1. **In Figma**, select one or more frames. Each frame becomes an artboard.
2. Open **Plugins → Development → Figma to Affinity (beta)** and click the export button ("Xuất frame đang chọn"). The plugin shows what it exported and downloads a `.figaf` file, usually into Downloads.

   ![The plugin after an export](docs/images/figma-plugin.png)

3. **Move the `.figaf` file to your Desktop**, or to the folder you allowed in Step 2. The script cannot read it from Downloads.
4. **In Affinity**, open Scripting Studio, select the saved script and click **Run**. Pick the `.figaf` file when asked. A new document is created and a summary appears when it is done.
5. Check the result and save it with **File → Save As** as `.af`.

The script writes a report, `… - bao cao chuyen doi.txt`, to your Desktop. It lists missing fonts, failed layers, and anything skipped or simplified, with layer names so you can fix them by hand.

### Troubleshooting

| Message | Fix |
|---|---|
| `PERMISSION_DENIED` or "Affinity không cho script đọc file" | The folder holding the `.figaf` file is not in list 4 from Step 2, or the script lacks **File System** permission (Step 3). Check both and run again. |
| No Scripting section in Settings | Your Affinity is older than 3.3. Update Affinity. |
| No Development menu in Figma | You are using Figma in a browser. Use the desktop app. |

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
