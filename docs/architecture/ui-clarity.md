# UI Clarity

This app should feel like a restrained local engineering/CAD tool.

Use compact labels, helper text, native titles/tooltips, disabled-state explanations, and clear empty states. Avoid large explanatory text blocks in the main workspace.

## Honest State

Always make the current implementation level clear:

- worker pipeline can run;
- strategy configuration is data-driven;
- final ranking is not implemented;
- real nesting placement is not implemented;
- history frames only exist when emitted by the worker.

Do not make the UI look like the algorithm works when it is still a stub.

## Tooltips

Tooltips should explain meaning and domain consequence, not narrate obvious click behavior.

Good: "Exports the exact JSON request sent to the worker for debugging and reproduction."

Bad: "Click to export."

## Renderer Writes

Components may read composable state. Writes should go through named actions such as:

- `hydrateFromProject`;
- `replaceImportedDocuments`;
- `setResult`;
- `setLastHistoryRef`;
- `resetTransientJobState`.

Avoid direct nested mutation from unrelated modules.
