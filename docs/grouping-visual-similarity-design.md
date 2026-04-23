# Visual-Similarity Grouping — Design Scope

## Problem

The auto-grouping feature only detects folio-numbered page sequences. Pages
without visible archival numbers (unnumbered loose items, photos, typed
material) are silently skipped. For mixed-type batches, this means a
significant fraction of pages may remain ungrouped.

The current number-based pass is intentionally conservative but does tolerate a
single unreadable page inside an otherwise anchored sequence, including a
one-number jump such as `1, 2, unreadable, 4`.

## Approach Options

### A. Visual embedding + clustering
- Generate CLIP or similar embeddings for each page image.
- Cluster by cosine similarity to detect visually similar page runs.
- Pro: works without any text. Con: expensive, needs a model, may over-cluster.

### B. Layout heuristic (header/footer similarity)
- Compare pixel similarity of cropped strips across consecutive pages.
- Pages with matching headers/footers are likely the same document.
- Pro: cheap, no LLM needed. Con: brittle with scan quality variation.

### C. LLM visual classification
- Ask the vision model to classify each page by document type (letter,
  ledger, photo, form, etc.) alongside the number detection.
- Group consecutive pages of the same type.
- Pro: leverages existing LLM call. Con: adds tokens, classification accuracy
  varies.

## Constraints

- Must not regress cost for folio-numbered material (the common case).
- Should be opt-in or a second pass after number-based grouping.
- Must handle the "single page = standalone document" case that the current
  system discards.

## Open Questions

1. What accuracy threshold makes visual grouping useful vs. noise?
2. Should visual groups be surfaced differently in the UI (lower confidence)?
3. Can this reuse the document embedding infrastructure in `document_embeddings`?

## Next Step

Design and plan the chosen approach as a standalone implementation plan.
