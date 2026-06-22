// Shared DOM-side renderer for sentiment annotation cards and chipsets.
// Used by /sentiment, the document Sentiment tab, and (in later slices)
// entity/authority sentiment panels and the graph drawer. Mirrors the
// EJS partial views/partials/sentiment-card.ejs structure exactly so
// SSR'd and client-rendered cards are visually identical.
//
// Public API:
//   window.SentimentCard.render(row)      → HTMLElement (an <article>)
//   window.SentimentCard.renderChipset(row, opts) → HTMLSpanElement
//   window.SentimentCard.escape(value)    → string (safe text)
//   window.SentimentCard.el(tag, attrs, children) → HTMLElement
(function () {
  'use strict';

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'dataset') {
          Object.keys(attrs.dataset).forEach(function (d) {
            node.dataset[d] = attrs.dataset[d];
          });
        } else if (k === 'html') node.innerHTML = attrs[k];
        else if (k.indexOf('aria-') === 0 || k === 'role' || k === 'hidden' || k === 'title') {
          if (k === 'hidden') {
            if (attrs[k]) node.setAttribute('hidden', '');
          } else {
            node.setAttribute(k, attrs[k]);
          }
        } else {
          node[k] = attrs[k];
        }
      });
    }
    (children || []).forEach(function (c) {
      if (c == null) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }

  function escapeText(s) {
    return String(s == null ? '' : s);
  }

  function renderChipset(row, opts) {
    var options = opts || {};
    var span = el('span', { class: 's-chipset' + (options.compact ? ' s-chipset--compact' : '') });
    if (options.showLabel !== false) {
      span.appendChild(el('span', {
        class: 's-chip s-chip--label s-chip--label-' + (row.label_name ? 'set' : 'unset'),
        textContent: row.label_name || 'Unlabeled'
      }));
    }
    span.appendChild(el('span', {
      class: 's-chip s-chip--polarity s-chip--polarity-' + (row.polarity || 'neutral'),
      textContent: row.polarity || 'neutral'
    }));
    span.appendChild(el('span', {
      class: 's-chip s-chip--intensity s-chip--intensity-' + (row.intensity || 'low'),
      textContent: row.intensity || 'low'
    }));
    var voiceRole = row.voice_role || 'author';
    var voiceTitle = voiceRole === 'author'
      ? "Writer's own feeling"
      : voiceRole === 'speaker'
        ? 'Feeling reported by someone the writer quotes'
        : "Feeling the writer ascribes to a third party";
    span.appendChild(el('span', {
      class: 's-chip s-chip--voice s-chip--voice-' + voiceRole,
      textContent: voiceRole.replace('_', ' '),
      title: voiceTitle
    }));
    return span;
  }

  function renderCard(row, opts) {
    var options = opts || {};
    var showDoc = options.showDocument !== false;

    var article = el('article', {
      class: 's-card s-card--' + (row.voice_role || 'author'),
      dataset: { annotationId: String(row.id) }
    });

    // Head — chipset + research date.
    var head = el('header', { class: 's-card-head' });
    head.appendChild(renderChipset(row));
    var dateClass = row.research_date
      ? (row.emotion_about_earliest ? 's-card-date--retrospective' : '')
      : 's-card-date--undated';
    head.appendChild(el('span', {
      class: 's-card-date ' + dateClass,
      textContent: row.research_date ? escapeText(row.research_date) : 'Undated'
    }));
    article.appendChild(head);

    // Evidence — clickable so consumers can hook span-highlighting.
    var evidence = el('blockquote', {
      class: 's-card-evidence',
      dataset: {
        sentimentEvidence: '1',
        documentId: String(row.document_id),
        transcriptId: String(row.transcript_id || ''),
        spanStart: row.span_start != null ? String(row.span_start) : '',
        spanEnd: row.span_end != null ? String(row.span_end) : '',
        verbatim: escapeText(row.emotion_phrase_verbatim || '')
      }
    });
    evidence.appendChild(el('span', { class: 's-card-evidence-mark', 'aria-hidden': 'true', textContent: '“' }));
    evidence.appendChild(el('span', { class: 's-card-evidence-text', textContent: escapeText(row.evidence_excerpt) }));
    evidence.appendChild(el('span', { class: 's-card-evidence-mark', 'aria-hidden': 'true', textContent: '”' }));
    article.appendChild(evidence);

    // Attribution: verbatim → target, plus voice qualifier when applicable.
    var target = row.target_kind === 'entity'
      ? (row.target_entity_name || 'Unnamed entity')
      : (row.target_phrase || '—');
    var attribution = el('p', { class: 's-card-attribution' });
    attribution.appendChild(el('span', { class: 's-card-verbatim', textContent: escapeText(row.emotion_phrase_verbatim) }));
    attribution.appendChild(el('span', { class: 's-card-arrow', 'aria-hidden': 'true', textContent: ' → ' }));
    attribution.appendChild(el('span', {
      class: 's-card-target s-card-target--' + (row.target_kind || 'phrase'),
      textContent: escapeText(target)
    }));
    if (row.voice_role === 'speaker' && row.expressed_by_entity_name) {
      attribution.appendChild(el('span', {
        class: 's-card-voice-qual',
        textContent: ' as quoted by ' + escapeText(row.expressed_by_entity_name)
      }));
    } else if (row.voice_role === 'described_subject' && row.described_subject_entity_name) {
      attribution.appendChild(el('span', {
        class: 's-card-voice-qual',
        textContent: ' about ' + escapeText(row.described_subject_entity_name)
      }));
    }
    article.appendChild(attribution);

    // Footer: source link + paradata toggle (omitted when showDocument=false).
    var foot = el('footer', { class: 's-card-foot' });
    if (showDoc) {
      var transcriptHref = '/documents/' + row.document_id +
        (row.transcript_id ? '?transcript=' + row.transcript_id : '') +
        (row.span_start != null ? '#span-' + row.span_start : '');
      var source = el('a', { class: 's-card-source', href: transcriptHref });
      source.appendChild(el('span', { class: 's-card-source-label', textContent: 'in ' }));
      source.appendChild(el('cite', { class: 's-card-source-title', textContent: escapeText(row.document_title) }));
      if (row.document_author) {
        source.appendChild(el('span', {
          class: 's-card-source-author',
          textContent: ' by ' + escapeText(row.document_author)
        }));
      }
      foot.appendChild(source);
    } else {
      // Reserve flex-space for the paradata toggle's right alignment.
      foot.appendChild(el('span', { class: 's-card-source' }));
    }

    var hasParadata = (row.notes && String(row.notes).trim()) ||
                      (row.emotion_about_phrase_verbatim && String(row.emotion_about_phrase_verbatim).trim());
    if (hasParadata) {
      var paradataId = 's-card-para-' + row.id;
      var toggle = el('button', {
        type: 'button',
        class: 's-card-paradata-toggle',
        dataset: { sentimentParadataToggle: '1' },
        'aria-controls': paradataId,
        'aria-expanded': 'false'
      });
      toggle.appendChild(el('span', { class: 's-card-paradata-label', textContent: 'paradata' }));
      toggle.appendChild(el('span', { class: 's-card-paradata-icon', 'aria-hidden': 'true', textContent: '+' }));
      foot.appendChild(toggle);
      article.appendChild(foot);

      var paradata = el('section', { id: paradataId, class: 's-card-paradata', hidden: true });
      if (row.notes && String(row.notes).trim()) {
        var b1 = el('div', { class: 's-card-paradata-block' });
        b1.appendChild(el('h4', { class: 's-card-paradata-h', textContent: 'Extractor notes' }));
        b1.appendChild(el('p', { class: 's-card-paradata-body', textContent: escapeText(row.notes) }));
        paradata.appendChild(b1);
      }
      if (row.emotion_about_phrase_verbatim && String(row.emotion_about_phrase_verbatim).trim()) {
        // Mirror SSR partial: 'Refers to <q>verbatim</q> (earliest – latest, precision)'.
        var b2 = el('div', { class: 's-card-paradata-block' });
        b2.appendChild(el('h4', { class: 's-card-paradata-h', textContent: 'Temporal scope' }));
        var p = el('p', { class: 's-card-paradata-body' });
        p.appendChild(document.createTextNode('Refers to '));
        p.appendChild(el('q', { textContent: escapeText(row.emotion_about_phrase_verbatim) }));
        if (row.emotion_about_earliest) {
          var suffix = ' (' + row.emotion_about_earliest;
          if (row.emotion_about_latest && row.emotion_about_latest !== row.emotion_about_earliest) {
            suffix += ' – ' + row.emotion_about_latest;
          }
          if (row.emotion_about_precision) suffix += ', ' + row.emotion_about_precision + ' precision';
          suffix += ')';
          p.appendChild(document.createTextNode(suffix));
        }
        b2.appendChild(p);
        paradata.appendChild(b2);
      }
      article.appendChild(paradata);
    } else {
      article.appendChild(foot);
    }
    return article;
  }

  // Shared JSON-fetch helper. Used by all three sentiment client modules
  // (workbench, document tab, graph drawer) so retry / 401-redirect / error
  // shape stay consistent across surfaces.
  function fetchJson(url) {
    return fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' }
    }).then(function (r) {
      if (!r.ok) {
        return r.json().then(function (body) {
          var err = new Error(body && body.error ? body.error : 'Request failed');
          err.status = r.status;
          throw err;
        }, function () {
          var err = new Error('Request failed (' + r.status + ')');
          err.status = r.status;
          throw err;
        });
      }
      return r.json();
    });
  }

  window.SentimentCard = {
    render: renderCard,
    renderChipset: renderChipset,
    escape: escapeText,
    el: el,
    fetchJson: fetchJson
  };
})();
