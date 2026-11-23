# Lisfranc standalone demo

Open `Lisfranc-Review.html` from your checkout with **Open File** in Chrome or Edge. It runs offline and includes ten UNIFESP AP/lateral pairs and five HVAngleEst AP radiographs. The Demo tab in either OHIF extension opens the same app. The radiograph attribution appears under **Guide → Image sources**.

## Open approved local images

Use **Add local images** and select up to 25 AP radiographs in JPEG or PNG format. Each AP becomes a separate case. For a paired review, select a single AP and its corresponding lateral image. The labels record the views you selected. Choose the AP and lateral from the same study when pairing. The app measures pixels because a raster export supplies no verified physical calibration.

The browser keeps selected pixels in memory for the current tab. It saves review annotations in browser-local storage for that specific ordered image set. Reload the same files in the same order to resume a saved review. **Open bundled examples** returns to the public examples. **Export reviews** saves annotations and image hashes in JSON. The worklist also offers JSON and CSV reports. Keep review exports in your approved local folder.

If you have a separately approved original portable HTML and want to use its original image set, save and open that file from an approved folder outside the repository. Browser **Open File** opens the whole portable file. **Import reviews** reads review JSON for the currently open image set.

## Offline check

Use an installed Playwright module and its Chromium browser. Use `LISFRANC_PLAYWRIGHT` and `LISFRANC_BROWSER_EXECUTABLE` to select existing installs.

```text
node demo/smoke.mjs
```

The smoke checks the bundled radiographs and exercises local selection with temporary in-memory test inputs. The bundled fonts and runtime libraries have [third-party notices](THIRD-PARTY-NOTICES.txt).
