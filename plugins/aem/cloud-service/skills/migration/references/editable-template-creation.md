# Editable template creation

## Thumbnail migration

> Added by the Migration Flywheel from comparison `before-migration -> after-migration` (D-6).

**Gap:** Template thumbnail.png migration is undocumented

The static template dir contains thumbnail.png alongside .content.xml. The skill's editable-template file list is 4 files and never mentions thumbnails, so the thumbnail is lost on migration.

**Rule to apply:** Add a rule: copy thumbnail.png to /conf/<appId>/settings/wcm/templates/<tpl>/thumbnail.png and add it to the vault filter. PNG-only, filename must be thumbnail.png.
