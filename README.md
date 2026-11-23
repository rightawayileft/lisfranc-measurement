# Lisfranc measurement review

## Offline demo

Download or clone this repository, then open `demo/Lisfranc-Review.html` from disk in a browser. The demo includes ten synthetic AP/lateral pairs. It runs offline and supports three-point C1–M2 tangent measurement, the optional four-corner proxy, landmark corrections, and browser-local review and export. See the [demo guide](demo/README.md) for the workflow and how to open a separately approved original demo locally.

## Choose the extension for your OHIF viewer

Match the commit in **About OHIF Viewer**. Each directory contains a complete alternative package named `@msk/extension-lisfranc`. Install one per viewer build.

| OHIF viewer | Extension | Installation and rollback |
| --- | --- | --- |
| About **3.7.0**, commit `5ddf8a16027255d28dc01c1740099cf85bbcf458` (upstream `3.7.0-beta.110`) | `0.2.1-ohif3.7.0` · React 17.0.2 · Cornerstone 1.20.3 | [3.7 staging guide](ohif-extension-3.7/README.md) |
| **v3.11.0**, commit `522531cc5c97ed05470f55a7a8f6571d9a512bd4` | `0.2.0` · React 18.3.1 · Cornerstone 3.32.5 | [3.11 staging guide](ohif-extension/README.md) |

The 3.7 backport blocks Lisfranc measurement on multiframe local files and WADO-URI because the pinned loader can display the wrong frame. Use WADO-RS for multiframe studies. Single-frame radiograph series can use the local viewer.

Both packages open the same synthetic Demo and use the same Clinical API and database schema for study claims, corrected reviews, revision history and CSV enrollment. See the [service deployment guide](ohif-extension/deployment/README.md).

Both pinned OHIF hosts include dependencies with published security advisories, including dcmjs and Swiper. Review the site's dependency patches, mode, authentication and data source before deployment. [dcmjs advisory](https://github.com/advisories/GHSA-px68-xx5g-48q5) · [Swiper advisory](https://github.com/advisories/GHSA-hmx5-qpq5-p643)
