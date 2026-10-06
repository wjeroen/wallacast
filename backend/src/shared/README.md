# Shared frontend modules (byte-identical copies)

The files here are exact copies of `frontend/src/markdown.ts`, `format.ts`, `tags.ts`,
`types.ts` and `turndown-plugin-gfm.d.ts`. They let the backend run the frontend's
"Copy content" conversion unchanged, see `services/markdown-export.ts`.

Why copies and not one shared folder: Railway builds the backend with Root Directory
`backend` and the frontend with Root Directory `frontend`, so neither build can see a
folder outside its own directory.

Never edit these files here. Change the frontend original, then copy it over. From the
repo root:

    cp frontend/src/markdown.ts frontend/src/format.ts frontend/src/tags.ts frontend/src/types.ts frontend/src/turndown-plugin-gfm.d.ts backend/src/shared/

`backend/scripts/test-markdown-export.mts` fails when a copy differs from its original.
