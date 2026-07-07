# Template modernization context

## Step 5 — classification: no editable zone

> Added by the Migration Flywheel from comparison `before-migration -> after-migration` (D-8).

**Gap:** No 'no editable zone' classification for root-only templates

SiteRoot's page component states 'Components are not allowed on this page', but the skill unconditionally emits an editable responsivegrid (editable="{Boolean}true"), exposing an author zone that should be locked.

**Rule to apply:** Add a classification: when the source page component has no cq:include/data-sly-resource editable area, emit a LOCKED <root> in structure/ (no editable="{Boolean}true") and an empty initial/.
