---
name: romanum-ui-workflow
description: Build Roblox interfaces by finding reusable UI, reviewing a visual concept, separating its assets, and assembling editable native controls. Use for UI library reuse, asset manifests and authorised Studio implementation.
license: "Romanum Source-Available License 1.0; see LICENSE or https://github.com/lachydotmcg/Romanum/blob/main/LICENSE. Commercial project outputs are permitted."
---

# Roblox UI workflow

Start with the player's task, device and reading needs. Carry the project's art direction and existing conventions through the work. Keep labels short and actions clear.

## Find before generating

Search an available UI library for the screen or component, using its function and visual style. Inspect the actual layout, assets, supported devices, licence and attribution. Similar tags alone do not establish suitability. Reuse appropriate pieces and create only the missing ones.

If library access is unavailable, work from assets the developer supplied. Do not invent search results or claim a local folder is a connected marketplace. Permission to use a pack in a game does not necessarily allow sharing it or its edited images.

## Review a concept

Plan a few distinct compositions with a main action, information hierarchy and asset list. Where authorised generation is available, render the full interface concept before making separate production assets. A written prompt is not a rendered concept.

Review the actual image at the intended device size. Check legible labels, touch targets, hierarchy, state changes and whether the next action is obvious. Ask for a choice unless the developer delegated visual selection; delegated review still needs a recorded decision tied to that render. Stay within the authorised budget.

## Separate and assemble

Use the approved concept as the visual reference for each asset. Request one named asset at a time, preserving colour, perspective and shape. Use transparency for cutouts. Keep text and interactive states editable in Roblox instead of baking the interface into a picture.

Make a manifest mapping stable keys to images and native components. Include dimensions, anchors, parent relationships and states. A library layout is structured data, not permission to execute uploaded scripts. Validate its hierarchy and reject unknown properties or executable content.

Use native `Frame`, `TextLabel`, `TextButton`, `ImageLabel` and `ImageButton` elements where appropriate. Supply real authorised Roblox asset IDs; do not invent IDs or report uploads before they succeed. A static Luau export is an artifact, not proof that Studio applied or tested it.

Use connected Studio tools only within granted permissions. Inspect the result on relevant screen sizes and check interaction, clipping, text fit and navigation. Publishing and destructive edits remain separate authorised actions. Distinguish what was created, applied and tested.

## Sharing

Private creation, analytics contributions and UI publication are separate choices. Never publish because someone enabled an unrelated data toggle. Show the selected licence and attribution, confirm rights for every source and derivative, and get explicit consent. Share only approved layouts and assets, not prompts, credentials, private statistics or source contracts.

Removing a listing stops new access through Romanum and may withdraw dependent listings. It does not undo licences already received or erase outside copies. Preserve attribution when reusing or exporting components.

## References

Roblox's [ScreenGui](https://create.roblox.com/docs/reference/engine/classes/ScreenGui) and [ImageLabel](https://create.roblox.com/docs/reference/engine/classes/ImageLabel) references define native objects. [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) describes the optional community asset licence; it does not license Romanum's platform source or skill text. Verify the actual component's terms.
