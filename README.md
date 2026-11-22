# Lisfranc measurement review

## Offline demo

Download or clone this private repository, then open `demo/Lisfranc-Review.html` from disk in a browser. The demo includes ten synthetic AP/lateral pairs. It runs offline and supports three-point C1–M2 tangent measurement, the optional four-corner proxy, landmark corrections, and browser-local review and export. See the [demo guide](demo/README.md) for the workflow and how to open a separately approved original demo locally.

## OHIF extension

`ohif-extension/` contains v0.2.0 of the OHIF extension. Its Demo workspace uses the same synthetic examples. Its Clinical workspace uses a private PostgreSQL service for the shared Corrected queue, study claims, revision history and CSV enrollment. Follow the [extension staging and rollback guide](ohif-extension/README.md) and [service deployment guide](ohif-extension/deployment/README.md). The local viewer target is OHIF v3.11.0. Verify the site's viewer revision, authentication and data source in staging.
