# Lisfranc standalone demo

Open `Lisfranc-Review.html` with **Open File** in a current Chrome or Edge browser. The file runs offline and uses browser-local storage. Ten paired synthetic cases contain generated AP and lateral foot schematics and hand-authored starting landmarks. Distances are in pixels.

The interface uses the November 18, 2026 standalone workspace build packaged with Lisfranc OHIF 0.2.0. It includes the To review, Corrected, and Reviewed folders, assisted and blind demo modes, AP and lateral tools, and local review export and import. The synthetic images and starter points exercise the workflow. They provide no clinical evidence.

The bundled fonts and runtime libraries carry their own [third-party notices](THIRD-PARTY-NOTICES.txt).

## Use an approved original locally

If you already have the original portable HTML and your organization has approved your use of its contents, save it in an approved local folder **outside this repository checkout**. Open it from Chrome or Edge with **Open File** (`Ctrl+O` on Windows or `Command+O` on macOS) and select the approved HTML. Leave that file and any review exports in the approved folder. The synthetic and original datasets use separate review keys. The portable viewer opens images embedded during its build. **Import reviews** reads review JSON for the same dataset.

## Build and test

Use Node.js 24 to regenerate the synthetic payload from the checked-in file. Back up local edits to the HTML before regenerating.

```text
node demo/make-synthetic-demo.mjs
```

The generator also accepts an explicit input and output HTML path. It recognizes the locally held, hash-pinned November 18 source and requires a different output path when converting that source. The released HTML SHA-256 is `f1f5bb16343420a45b36dadf8d3dd35ba4cd968943efed4d9a08e3b6ed2a8fca`.

To run the browser smoke, make Playwright available locally and install its Chromium browser, or point `LISFRANC_PLAYWRIGHT` and `LISFRANC_BROWSER_EXECUTABLE` at an existing Playwright module and Chrome or Edge binary.

```text
node demo/smoke.mjs
```
