# Lisfranc interval review for OHIF

`@msk/extension-lisfranc` 0.2.0 adds **Clinical** and **Demo** tabs to OHIF's Lisfranc panel. The source folders are `workspaces/clinical` and `workspaces/demo`.

- **Clinical** reviews the active OHIF stack using the host DICOM viewer and saves to a shared hospital PostgreSQL service. A complete manual review moves its frame to **Corrected** for all authorized reviewers on approval. Reopening returns it to **To review**. **Shared Corrected** lists approved counts across enrolled studies. The folders below the list show the active study's frames.
- **Demo** opens the offline review app with ten generated AP/lateral pairs and hand-authored starter landmarks and calipers. An approved change to a measurement or finding moves the case to **Corrected**. An unchanged approval moves to **Reviewed**. Editing a draft keeps it in **To review** until approval.

Demo saves reviews in its own browser-local storage. Clinical uses the shared database and the host's existing DICOM data source. Closing Demo returns to the clinical viewport. [Hospital service setup](deployment/README.md)

## Clinical review

1. Open **Lisfranc** in the viewer's right panel. AP/DP metadata enables editing. If the view is unknown, confirm it manually. Confirmation is saved with the first review action. Explicit lateral, oblique, and other recognized non-AP views keep landmark editing disabled. [DICOM DX view codes](https://dicom.nema.org/medical/dicom/current/output/chtml/part16/sect_CID_4010.html)
2. Choose **Edit landmarks**. Place C1 proximal, C1 distal and M2 tangent for the primary parallel-tangent measurement. Add both M2 corners for the optional four-corner midpoint proxy, which reuses the two C1 points. Select a landmark to reposition or remove it, or drag its handle. Choose **Finish editing** to use the host mouse tools.
3. Set the cortex relation to assign the primary result's sign. Approval requires a valid tangent, a selected relation, and distinct M2 corners if the proxy was started. Skip, reject and reopen are available. Approved and rejected reviews are locked until reopened. Older approved reviews with coincident M2 corners can be reopened and corrected. Their exports mark the proxy invalid.
4. Select **Sign in to Clinical** if needed, then **Open Clinical reviews**. Editing reserves the study for one reviewer at a time. The reservation expires when it stops renewing. The database also rejects saves against old revisions.
5. **History** shows the current frame's saved revisions and the reviewer and time of each change. **Export JSON** and **Export CSV** download saved reviews for the current study, including source-pixel coordinates, status and distances.

The overlay uses zero-based source pixel centers. The calculations independently scale rows and columns for millimeters when DICOM explicitly supplies positive `PixelSpacing` and a `GEOMETRY` or `FIDUCIAL` calibration type. Missing, invalid, or uncharacterized spacing yields pixels. Existing reviews retain the calibration saved with the review across reopening and edits, even when another data source presents different spacing. For signed results, separated is positive, overlap is negative, and unknown reports the unsigned distance. [DICOM pixel spacing calibration](https://dicom.nema.org/medical/dicom/current/output/chtml/part03/sect_10.7.html)

## Demo review

Use the worklist to switch between **To review**, **Corrected**, and **Reviewed**. To revise an approved case, open it and reopen the review. The app includes a guide, image tools, and review export and import. It loads from a same-origin HTML asset produced by the OHIF build. The **Open demo in a new tab** link provides a full-size view if the host disallows frames. For a standalone demonstration, open [the repo's canonical Demo HTML](../demo/Lisfranc-Review.html) directly.

The Demo contains generated projection schematics and hand-authored workflow examples in pixel units. [Demo guide](../demo/README.md)

## Install in a staging source checkout

The target is OHIF **v3.11.0** at `522531cc5c97ed05470f55a7a8f6571d9a512bd4` with Cornerstone **3.32.5**. Use a clean, disposable checkout or build context and retain its baseline artifact and Git revision. The commands below use a POSIX shell and Yarn Classic 1.22.22. `EXT` is the absolute path to this package. Run from the OHIF checkout root. [OHIF source](https://github.com/OHIF/Viewers/tree/v3.11.0), [OHIF 3.11 extension registration](https://docs.ohif.org/3.11/platform/extensions/)

```sh
EXT=/absolute/path/to/ohif-extension
BASELINE=$(git rev-parse HEAD)
(cd "$EXT" && npm run prepare:demo)
yarn install --frozen-lockfile
mkdir -p extensions/lisfranc/workspaces/demo
cp -R "$EXT/package.json" "$EXT/src" extensions/lisfranc/
cp -R "$EXT/workspaces/clinical" extensions/lisfranc/workspaces/
cp "$EXT/workspaces/demo/Lisfranc-Review.html" "$EXT/workspaces/demo/THIRD-PARTY-NOTICES.txt" extensions/lisfranc/workspaces/demo/
node ./platform/cli/src/index.js link-extension "$PWD/extensions/lisfranc"
git apply --check "$EXT/staging/longitudinal-v3.11.0.patch"
git apply "$EXT/staging/longitudinal-v3.11.0.patch"
```

The patch adds the panel to the stock longitudinal viewer mode and opens it by default. For a site-specific mode, add `@msk/extension-lisfranc` version `0.2.0` to its extension dependencies and `@msk/extension-lisfranc.panelModule.lisfranc` to the viewer layout's `rightPanels`. Build in the same checkout as the link. The CLI adds an absolute local module path to webpack configuration. Replicate the link step in each separate build context.

`prepare:demo` verifies the canonical synthetic asset from `../demo/Lisfranc-Review.html` and copies it and its third-party notices into the gitignored package asset directory. It also runs before `npm pack`. A packed extension already contains these files.

For a synthetic-only build, copy the supplied local-files configuration into the checkout and use it explicitly. The same bundle supports the shared-storage smoke through a disposable test proxy and database. The smoke opens `/localbasic`, feeds generated DICOMs in memory, and blocks non-loopback browser requests.

```sh
cp "$EXT/staging/lisfranc-synthetic.js" platform/app/public/config/
APP_CONFIG=config/lisfranc-synthetic.js PUBLIC_URL=/ yarn workspace @ohif/app build:viewer
cp extensions/lisfranc/workspaces/demo/THIRD-PARTY-NOTICES.txt platform/app/dist/lisfranc-demo-third-party-notices.txt
```

Run `npm test` from the extension directory. Use the shared Clinical smoke with the 0.2.0 service and the included synthetic test proxy. The smoke uses Playwright Chromium by default and accepts `LISFRANC_PLAYWRIGHT` and `LISFRANC_BROWSER_EXECUTABLE` overrides.

```sh
# From the extension folder, using a Python environment with the API and test
# dependencies (pytest, httpx, pgserver and fasteners).
export LISFRANC_PLAYWRIGHT=/absolute/path/to/installed/playwright
python -B tests/shared_fixture.py --work-dir /path/to/disposable-test-workspace \
  --dist /absolute/path/to/OHIF/platform/app/dist
```

For site staging, verify the viewer revision, active mode, data source, and build configuration. Apply the equivalent mode wiring and rebuild with the site's `APP_CONFIG` and `PUBLIC_URL`. Include the notices file beside the viewer distribution as shown above. Follow the service setup for the private database, named reviewer accounts, and accession CSV enrollment. Repeat the synthetic smoke through the site's staging configuration.

Check host content security policy for same-origin frame embedding and for the Demo HTML's inline scripts and styles. Its own policy blocks network connections. If the host blocks embedding, the new-tab link can still open the demo when the page's scripts and styles are allowed.

## Rollback

Restore the previous OHIF frontend artifact or container in the staging environment. In the clean staging checkout, unlink the package and restore only the changed OHIF source files from the recorded pre-extension revision. When rebuilding the previous frontend, use its original build configuration. The temporary extension and synthetic configuration can be left in the disposable checkout.

```sh
yarn unlink @msk/extension-lisfranc
(cd extensions/lisfranc && yarn unlink)
git restore --source "$BASELINE" -- modes/longitudinal/src/index.ts \
  platform/app/pluginConfig.json platform/app/.webpack/webpack.pwa.js
```

Demo reviews use the browser key prefix `lisfranc-ohif-demo-reviews/v1/`. The archived 0.1.0 Clinical browser records under `lisfranc-ohif-review/v1/` are retained by the browser and are not loaded by 0.2.0. Preserve the PostgreSQL volume on rollback.

## Source and verification

The extension and Clinical service come from the November 18 v0.2.0 handoff package, SHA-256 `88668a4cd2fb8c61bacd72134ae5add920d81ef7a345bcf4a944859daf834fc1`. This staging copy uses the repository's synthetic Demo and the corresponding browser test case labels.

The synthetic-only production build passed on OHIF v3.11.0 and Cornerstone 3.32.5. Webpack 5.95.0 produced build `d428e4299f9bd0948655` with the baseline runtime-cycle and size warnings. All 28 JavaScript tests and 12 PostgreSQL-backed service tests passed. Windows skipped one DICOM symlink test. The loopback Chromium smoke verified named sign-in, two-reviewer claims, shared approval and reopening, revision attribution, and browser-local Demo edits that stay separate from the shared service. Deployment templates and the target server still need site staging verification.
