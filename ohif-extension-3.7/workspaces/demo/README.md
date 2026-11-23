# Demo workspace

Run `npm run prepare:demo` at the extension root to copy the verified [canonical synthetic Demo](../../../demo/Lisfranc-Review.html) and its [third-party notices](../../../demo/THIRD-PARTY-NOTICES.txt) into this directory. The same step runs before packaging.

- **To review** contains unstarted cases, drafts, and reopened reviews.
- **Corrected** contains approvals whose saved landmarks, cortex relation, measurements, or fracture finding differ from the applied starter landmarks.
- **Reviewed** contains unchanged approvals and manual approvals without a sample.

Edits in progress stay available in To review. A note or viewport adjustment alone keeps an approval in Reviewed. Review export, import, and reset use Demo's browser-local data.

Run `node --test workspaces/demo/folders.test.mjs` from the extension root to exercise the folder rules.
