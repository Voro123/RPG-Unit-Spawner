# AGENTS.md

## Project overview

This repository is a small Node/Express + static vanilla HTML/CSS/JS app for generating RPG pixel-game materials with the Minimax image API.

Current scope:

- Keep the sprite/tile material generator.
- Walking sheet generation has been removed. Do not reintroduce `walk.html`, `/api/walks`, or `server/walks.js` unless the user explicitly asks for walking sheets again.
- Runtime project data is stored under `data/projects` and is not meant to be committed.
- Minimax API configuration is stored server-side only. Never expose API keys to browser code.

## Run commands

- Install dependencies with `npm install` or `yarn`.
- Start the app with `npm run dev` or `yarn dev`.
- `predev` runs `git pull`; be aware of this when testing local changes.
- There is no build step and no automated test suite at the moment.

## Main files

- `server/index.js`: Express API, Minimax generation routes, sprite/tile prompt handling.
- `server/minimax.js`: Minimax image and text helper functions. Keep request bodies debuggable but redact large base64 references and never log API keys.
- `server/tilePrompt.js`: Model-translated tile prompt slot builder for tile/material generation.
- `server/projectSprites.js`: Project-scoped sprite sheet storage and cell image/tag operations.
- `server/projects.js`: Project index and project directory management.
- `public/sprite.html`: Sprite/tile sheet UI and page-specific generation logic.
- `public/project.js`: Shared front-end project selector, generation request wrapper, prompt preview, generated-cell pixel-size postprocessing, and pixel editor.
- `public/config.html`: Minimax configuration UI.
- `public/index.html`: Home page.

## Behavior to preserve

### Projects

- Every API call that reads or writes project assets must stay project-scoped through `projectId` query/body or `x-project-id`.
- New projects only need a `sprites` directory. Do not create `walks` directories unless walking sheets return.

### Sprite/tile generation

- Asset kind matters:
  - `sprite`: standalone object/item/plant on a plain white background, with optional edge-connected background-to-transparent processing.
  - `tile`: seamless RPG TileMap material/terrain texture.
- Tile prompts must be all-English before sending to Minimax.
- Tile prompts should use `server/tilePrompt.js`, which translates user input into slots such as `SUBJECT`, `SUBJECT_DETAIL`, `STYLE`, `COLOR_PALETTE`, and `STYLE_EXCLUDE`, then fills the positive/negative prompt template.
- Tile generation should not automatically reference old tile images because previous tile edges can get copied into new tiles.
- The final prompt preview is editable in the front end. If the user edits it, generation should send that edited final prompt instead of regenerating a new one.

### Generated-cell postprocessing

- After a single-cell sprite/tile generation or replacement, the front end must resize the generated image to the active sheet cell size, such as `32x32`, and save it back to the cell.
- Use nearest-neighbor style canvas drawing (`imageSmoothingEnabled = false`) for pixel art.
- Preserve the cell tag while rewriting the resized image.

### Pixel editor

- The sprite page includes a pixel editor for the selected cell.
- It must support:
  - loading the selected cell image,
  - editing individual pixels,
  - changing color,
  - changing alpha,
  - drawing fully transparent pixels,
  - right-click color picking,
  - saving the edited PNG back to the same cell.

### Generation target locking

- When a single-cell generation starts, the target cell must stay fixed.
- If the user clicks another cell while AI generation is running, the generated image must still be written to the original cell.
- After generation finishes, it is acceptable to move the UI selection to the cell the user clicked during generation.

## Style and implementation notes

- Keep the app dependency-light. It currently uses Express and browser-native APIs.
- Prefer small, direct changes over introducing frameworks or build tools.
- Keep code compatible with CommonJS on the server.
- Do not commit runtime data from `data/` or API key files.
- Avoid adding AGENT/AGENTS files in other directories unless the user explicitly asks.

## Known caveats

- Minimax may still generate imperfect seamless tiles even with strong prompts. Do not assume prompt wording alone fully solves tile edge artifacts.
- The app currently exposes a sanitized `minimaxRequest` in generation responses for debugging. Keep reference image base64 redacted.
