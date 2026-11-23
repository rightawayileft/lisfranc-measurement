# Lisfranc interval review for OHIF 3.7

`@msk/extension-lisfranc` `0.2.2-ohif3.7.0` adds **Clinical** and **Demo** tabs to OHIF's Lisfranc panel. The source folders are `workspaces/clinical` and `workspaces/demo`.

- **Clinical** reviews the active OHIF stack using the host DICOM viewer and saves to a shared hospital PostgreSQL service. A complete manual review moves its frame to **Corrected** for all authorized reviewers on approval. Reopening returns it to **To review**. **Shared Corrected** lists approved counts across enrolled studies. The folders below the list show the active study's frames.
- **Demo** opens the offline review app with 25 real radiographs in 15 cases. Place the interval landmarks manually or choose **Add local images** to open approved JPEG or PNG radiographs from your device.

Demo saves reviews in its own browser-local storage. Clinical uses the shared database and the host's existing DICOM data source. Closing Demo returns to the clinical viewport. [Hospital service setup](deployment/README.md)

## Clinical review

**3.7 multiframe images.** Single-frame instances can be reviewed individually or as a stack. Use a WADO-RS data source with explicit frame retrieval for a multiframe instance. The 3.7 backport disables Lisfranc review for multiframe local files and WADO-URI. The pinned loader can decode the wrong pixels for the requested frame on its first read. This guard applies to the Lisfranc panel. [Cornerstone 1.20.3 loader](https://github.com/cornerstonejs/cornerstone3D/blob/v1.20.3/packages/dicomImageLoader/src/imageLoader/wadouri/loadImage.ts#L172-L204)

1. Open **Lisfranc** in the viewer's right panel. AP/DP metadata enables editing. If the view is unknown, confirm it manually. Confirmation is saved with the first review action. Explicit lateral, oblique, and other recognized non-AP views keep landmark editing disabled. [DICOM DX view codes](https://dicom.nema.org/medical/dicom/current/output/chtml/part16/sect_CID_4010.html)
2. Choose **Edit landmarks**. Place C1 proximal, C1 distal and M2 tangent for the primary parallel-tangent measurement. Add both M2 corners for the optional four-corner midpoint proxy, which reuses the two C1 points. Select a landmark to reposition or remove it, or drag its handle. Choose **Finish editing** to use the host mouse tools.
3. Set the cortex relation to assign the primary result's sign. Approval requires a valid tangent, a selected relation, and distinct M2 corners if the proxy was started. Skip, reject and reopen are available. Approved and rejected reviews are locked until reopened. Older approved reviews with coincident M2 corners can be reopened and corrected. Their exports mark the proxy invalid.
4. Select **Sign in to Clinical** if needed, then **Open Clinical reviews**. Editing reserves the study for one reviewer at a time. The reservation expires when it stops renewing. The database also rejects saves against old revisions.
5. **History** shows the current frame's saved revisions and the reviewer and time of each change. **Export JSON** and **Export CSV** download saved reviews for the current study, including source-pixel coordinates, status and distances.

The overlay uses zero-based source pixel centers. The calculations independently scale rows and columns for millimeters when DICOM explicitly supplies positive `PixelSpacing` and a `GEOMETRY` or `FIDUCIAL` calibration type. Missing, invalid, or uncharacterized spacing yields pixels. Existing reviews retain the calibration saved with the review across reopening and edits, even when another data source presents different spacing. For signed results, separated is positive, overlap is negative, and unknown reports the unsigned distance. [DICOM pixel spacing calibration](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_10.7.html)

## Demo review

Use the worklist to switch between **To review**, **Corrected**, and **Reviewed**. To revise an approved case, open it and reopen the review. The app includes a guide, image tools, and review export and import. It loads from a same-origin HTML asset produced by the OHIF build. The **Open demo in a new tab** link provides a full-size view if the host disallows frames. For a standalone demonstration, open [the repo's canonical Demo HTML](../demo/Lisfranc-Review.html) directly.

The 15 bundled cases are ten UNIFESP AP/lateral pairs and five HVAngleEst AP images. UNIFESP image derivatives are available under CC BY-NC-SA 4.0 for noncommercial use and HVAngleEst images under CC BY 4.0. Use **Add local images** inside the Demo to open approved AP images and an optional lateral. The browser holds selected pixels in memory and saves review annotations locally for the selected image set. Open the standalone HTML from disk or use an HTTPS viewer to select local files. Measurements in Demo are in pixels. [Image attribution and terms](../demo/THIRD-PARTY-NOTICES.txt) · [Demo guide](../demo/README.md)

## Install in a staging source checkout

The target reports **3.7.0** in About. Its exact upstream revision identifies the viewer as **3.7.0-beta.110**, using React and React DOM **17.0.2** and Cornerstone **1.20.3**. This package adapts the workspace accessibility IDs, viewport subscriptions and stock longitudinal mode to that revision. [Pinned OHIF source](https://github.com/OHIF/Viewers/tree/5ddf8a16027255d28dc01c1740099cf85bbcf458)

Use a clean, disposable viewer checkout and an isolated Yarn Classic 1.22.22 installation or build environment. Keep the prior viewer artifact and site configuration for rollback. These commands use a POSIX shell. Set `EXT` to this package, then run from the OHIF checkout root.

```sh
set -eu
EXT=/absolute/path/to/lisfranc-measurement/ohif-extension-3.7
BASELINE=$(git rev-parse HEAD)
test "$BASELINE" = 5ddf8a16027255d28dc01c1740099cf85bbcf458
test ! -e extensions/lisfranc
git apply --check "$EXT/staging/longitudinal-v3.7.0-beta.110.patch"
(cd "$EXT" && npm run prepare:demo)
yarn install --frozen-lockfile --non-interactive --ignore-scripts
mkdir -p extensions/lisfranc/workspaces/demo
cp -R "$EXT/package.json" "$EXT/src" extensions/lisfranc/
cp -R "$EXT/workspaces/clinical" extensions/lisfranc/workspaces/
cp "$EXT/workspaces/demo/Lisfranc-Review.html" "$EXT/workspaces/demo/THIRD-PARTY-NOTICES.txt" extensions/lisfranc/workspaces/demo/
node ./platform/cli/src/index.js link-extension "$PWD/extensions/lisfranc"
git apply "$EXT/staging/longitudinal-v3.7.0-beta.110.patch"
```

The OHIF CLI registers the package in `platform/app/pluginConfig.json` and writes a local path in `platform/app/.webpack/webpack.pwa.js`. Run the link in each build environment. The supplied patch adds the Lisfranc panel first and opens the stock longitudinal mode's right panel. For a custom mode, register `@msk/extension-lisfranc` version `0.2.2-ohif3.7.0` in the mode's dependencies, add `@msk/extension-lisfranc.panelModule.lisfranc` to `rightPanels` and set `rightPanelDefaultClosed` to `false`.

Build the local staging viewer first. Its local-files configuration opens generated Clinical test DICOMs through `/localbasic`. The Demo uses the licensed radiographs and notices from the canonical HTML.

```sh
cp "$EXT/staging/lisfranc-synthetic.js" platform/app/public/config/
(cd platform/app && NODE_ENV=production APP_CONFIG=config/lisfranc-synthetic.js PUBLIC_URL=/ CI=true \
  node --max_old_space_size=4096 ../../node_modules/webpack/bin/webpack.js --config .webpack/webpack.pwa.js)
cp extensions/lisfranc/workspaces/demo/THIRD-PARTY-NOTICES.txt platform/app/dist/lisfranc-demo-third-party-notices.txt
```

Use Node 24 for the extension tests and a Python environment with the [pinned service dependencies](deployment/requirements.lock), pytest, httpx, pgserver and fasteners. The fixture starts a disposable PostgreSQL database, a loopback proxy and a Chromium browser. Set `LISFRANC_BROWSER_EXECUTABLE` if using an existing Chrome or Edge binary. Run the POSIX fixture as an unprivileged user.

```sh
DIST="$PWD/platform/app/dist"
(cd "$EXT" && npm test)
export LISFRANC_PLAYWRIGHT=/absolute/path/to/installed/playwright
(cd "$EXT" && python -B tests/shared_fixture.py --work-dir /path/to/disposable-test-workspace --dist "$DIST")
```

Exercise the WADO-RS multiframe path with the same browser settings and the viewer checkout's installed dependencies. This harness serves generated DICOMweb metadata and multipart frames on loopback and stubs Clinical reads. It checks both the decoded pixels and the active viewport's pixel values against the expected frame contents.

```sh
(cd "$EXT" && node tests/wadors-frames-smoke.mjs "$DIST")
```

## Site staging and rollback

Build with the site's active mode, `APP_CONFIG` and `PUBLIC_URL`. Use synthetic studies to verify its DICOM data source, same-origin authentication and reviewer identity, two-reviewer claims, history and Demo iframe under its content security policy. Set up proxy access, PostgreSQL roles, enrollment and backups with the [service guide](deployment/README.md). Both viewer packages use the same API and schema. The pinned upstream viewer has known dependency advisories. [Host dependency notes](../README.md)

The pinned OHIF HTML links to a Google Fonts stylesheet and preconnects to its font host. The WADO-RS test blocks external browser requests. For a network-isolated viewer, serve the font locally or remove those links in the site's frontend build.

Restore the preceding frontend artifact and configuration to roll back. If this installation introduced the API proxy route, remove that route while preserving the database volume and history. Discard the disposable checkout or restore its three tracked OHIF files as follows. Run from the OHIF checkout with `BASELINE` set to the recorded pre-install revision and the Yarn link registry used during installation.

```sh
yarn unlink @msk/extension-lisfranc
(cd extensions/lisfranc && yarn unlink)
git restore --source "$BASELINE" -- modes/longitudinal/src/index.js \
  platform/app/pluginConfig.json platform/app/.webpack/webpack.pwa.js
```

## Verification

The backport derives from the 0.2.0 Clinical service and measurement implementation. Both variants use the same interval calculations, calibration rules, shared Clinical service and browser-local Demo. [OHIF 3.11 package](../ohif-extension/README.md)

The original 3.7 backport production build used Node 24.13.0, Yarn Classic 1.22.22 and webpack 5.88.2. That build, `e5735c2e4c188098cec3`, had two bundle-size warnings. The stock Cornerstone loader and OHIF lockfile were used throughout. All 30 JavaScript unit tests passed. The WADO-RS browser smoke checked two fresh browser sessions, each selecting frames 1, 2, 1, 2. The selected and loaded image IDs, Clinical labels, decoded pixels and viewport pixel values matched the source frame on every visit.

The shared-service browser smoke passed with PostgreSQL 16.2. It exercised two reviewers, study claims, approval and reopening, audit history, separate single-frame instances, browser-local Demo edits, and rejection of an unenrolled study. Both the tangent and the four-corner midpoint proxy matched independent calculations on anisotropic calibrated pixels. Uncalibrated images displayed pixels. The blocked local multiframe case exposed no edit controls and generated no review writes. The backend suite passed 12 tests, with the filesystem symlink test skipped on Windows.

Version `0.2.2-ohif3.7.0` passed production build `4de2a6dc035e1626a9da` on the same pinned viewer with two bundle-size warnings. The browser verified that the served Demo matched the canonical HTML and decoded all 25 licensed radiographs. The shared PostgreSQL smoke, local multiframe guard and WADO-RS frame identity all passed again.

OSV checks on November 23, 2026 found no matching advisory for the exact React and React DOM versions, the Cornerstone core/tools/image-loader versions or the 16 pinned Python service packages. The stock 3.7 lockfile had matches for 128 of 2,754 registry package/version pairs, including build and documentation dependencies. The check excluded container images, a Git-sourced dependency and site-specific patches. [Host dependency notes](../README.md)
