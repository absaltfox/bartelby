# Curator Correction UX Static Prototypes

These static prototypes capture the intended direction for curator-facing
correction workflows before a larger UI implementation. They follow the
existing admin workspace shell, shared toolbar/table classes, shared
typeahead-picker pattern, and no inline script/style rule from
`docs/ui-template-standards.md`.

## Entity Edit

Goal: make high-risk entity changes feel deliberate, auditable, and reversible
through existing workflows.

```html
<section class="settings-section correction-workspace">
  <div class="review-extractions-panel-header">
    <div>
      <p class="kg-panel-eyebrow">Correction</p>
      <h2>Edit Entity</h2>
      <p class="subtitle">Update the document-scoped entity record while keeping citations attached.</p>
    </div>
  </div>

  <div class="alert alert-warning">
    Changing entity type may unlink the current authority when the authority type no longer matches.
  </div>

  <form class="edit-form">
    <!-- entity_type, canonical_name, description, properties JSON, aliases -->
    <div class="edit-actions">
      <button class="btn-primary">Save entity</button>
      <a class="btn-secondary">Cancel</a>
    </div>
  </form>

  <section class="graph-shell-card knowledge-card">
    <div class="graph-sidebar-header">
      <p class="kg-panel-eyebrow">Audit</p>
      <h2>Recent changes</h2>
    </div>
    <div class="graph-sidebar-body">
      <!-- entity_changes rows: field, old value, new value, user, timestamp, note -->
    </div>
  </section>
</section>
```

## Entity Split

Goal: let curators separate conflated identities by moving selected evidence,
not by guessing hidden side effects.

```html
<section class="settings-section correction-workspace">
  <div class="review-extractions-panel-header">
    <div>
      <p class="kg-panel-eyebrow">Correction</p>
      <h2>Split Entity</h2>
      <p class="subtitle">Everything stays on the original unless selected for the new entity.</p>
    </div>
  </div>

  <form class="edit-form">
    <!-- new entity type, canonical name, description, required split note -->
    <label class="checkbox-row">
      <input type="checkbox">
      Link new entity to the same authority
    </label>

    <div class="knowledge-detail-grid">
      <section class="graph-shell-card knowledge-card">
        <div class="graph-sidebar-header">
          <h2>Citations</h2>
        </div>
        <div class="graph-sidebar-body">
          <!-- checklist with passage text and document links -->
        </div>
      </section>
      <section class="graph-shell-card knowledge-card">
        <div class="graph-sidebar-header">
          <h2>Relationships</h2>
        </div>
        <div class="graph-sidebar-body">
          <!-- checklist with source, type, target, and deprecated badge if needed -->
        </div>
      </section>
    </div>
  </form>
</section>
```

## Phrase Target Reconciliation

Goal: keep curators in the same reconciliation context while promoting or
suppressing phrases.

```html
<section class="settings-section">
  <form class="knowledge-toolbar knowledge-toolbar--spaced">
    <!-- search, collection, polarity, frequency filters -->
  </form>

  <div class="workflows-table-wrap">
    <table class="workflows-table">
      <!-- phrase, total frequency, polarity distribution, samples, suggested type -->
      <td class="col-actions">
        <details class="toolbar-details">
          <summary class="btn-primary btn-sm">Promote</summary>
          <div class="toolbar-details-menu">
            <form class="edit-form phrase-target-action-form">
              <!-- create new entity, preserving list context in hidden fields -->
            </form>
            <form class="edit-form phrase-target-action-form">
              <!-- promote to existing entity via shared typeahead picker -->
            </form>
          </div>
        </details>
      </td>
    </table>
  </div>
</section>
```

## Relationship Authoring

Goal: type constraints should prevent invalid links without erasing valid
curator context.

```html
<form class="edit-form relationship-new-form">
  <!-- source and target use shared typeahead-picker with selectedType metadata -->
  <!-- relationship type carries source_type and target_type constraints -->
  <!-- changing type clears only invalid selected entities -->
</form>
```
