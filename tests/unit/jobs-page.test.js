'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadJobsPageScript(context) {
  const source = fs.readFileSync(path.join(__dirname, '../../public/js/jobs-page.js'), 'utf8');
  vm.runInNewContext(source, context, { filename: 'public/js/jobs-page.js' });
}

function flushPending(pending) {
  return pending.reduce(
    (chain, promise) => chain.then(() => Promise.resolve(promise)),
    Promise.resolve()
  );
}

describe('jobs-page.js', () => {
  it('loads manage transcription logs lazily from the collection jobs API root', async () => {
    const logElement = { textContent: '(no log yet)', dataset: {} };
    const toggleBtn = {
      dataset: { id: '17', type: 'transcription' },
      addEventListener: jest.fn((event, handler) => {
        if (event === 'click') toggleBtn._click = handler;
      }),
      closest: jest.fn(() => ({ dataset: { type: 'transcription' } }))
    };
    const logRow = {
      classList: {
        _hidden: true,
        contains: jest.fn(() => logRow.classList._hidden),
        toggle: jest.fn(() => {
          logRow.classList._hidden = !logRow.classList._hidden;
        })
      }
    };
    const tbody = { querySelector: jest.fn() };
    const pending = [];
    const fetchMock = jest.fn(async (url) => {
      expect(url).toBe('/manage/collections/9/jobs/api/17');
      return {
        ok: true,
        json: async () => ({ log: 'worker log line' })
      };
    });

    const context = {
      console,
      JSON,
      Date,
      Math,
      String,
      Number,
      Boolean,
      Array,
      Object,
      RegExp,
      Promise,
      window: {
        confirm: jest.fn(() => true),
        location: { reload: jest.fn() },
        setTimeout(fn) {
          pending.push(fn());
          return pending.length;
        },
        setInterval(fn) {
          pending.push(fn());
          return pending.length;
        }
      },
      document: {
        addEventListener: jest.fn(),
        querySelector: jest.fn(() => null),
        querySelectorAll: jest.fn((selector) => {
          if (selector === '.import-progress-bar[data-progress]') return [];
          if (selector === '.toggle-log-btn') return [toggleBtn];
          if (selector === '.retry-btn') return [];
          if (selector === '.delete-job-btn') return [];
          if (selector === '.job-cb') return [];
          if (selector === '.filter-tab') return [];
          return [];
        }),
        getElementById: jest.fn((id) => {
          if (id === 'jobs-page-config') {
            return {
              textContent: JSON.stringify({
                mode: 'manage',
                apiBase: '/manage/collections/9/jobs/api',
                filter: 'all',
                typeFilter: 'all'
              })
            };
          }
          if (id === 'jobs-tbody') return tbody;
          if (id === 'job-log-17') return logElement;
          if (id === 'log-row-17') return logRow;
          return null;
        })
      },
      fetch: fetchMock,
      setTimeout: function(fn) {
        pending.push(fn());
        return pending.length;
      },
      clearTimeout: () => {},
      setInterval: function(fn) {
        pending.push(fn());
        return pending.length;
      },
      clearInterval: () => {}
    };
    context.window.window = context.window;
    context.window.document = context.document;
    context.window.fetch = fetchMock;

    loadJobsPageScript(context);
    await toggleBtn._click();
    await flushPending(pending);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logElement.textContent).toBe('worker log line');
  });

  it('updates the manage import subject cell without touching the provider cell', async () => {
    const subjectCell = { innerHTML: '<span>Old subject</span>' };
    const providerCell = { innerHTML: '—' };
    const statusBadge = {
      textContent: 'queued',
      className: 'status-badge status-queued'
    };
    const timeCell = {
      querySelector: jest.fn(() => null),
      insertAdjacentHTML: jest.fn()
    };
    const row = {
      dataset: { id: '42', type: 'import', status: 'queued' },
      querySelector: jest.fn((selector) => {
        if (selector === '.status-badge') return statusBadge;
        if (selector === '[data-job-cell="subject"]') return subjectCell;
        if (selector === '.job-subject-cell') return subjectCell;
        if (selector === '.job-time-cell') return timeCell;
        return null;
      })
    };
    const tbody = {
      querySelector: jest.fn((selector) => {
        if (selector.indexOf('data-id="42"') !== -1 && selector.indexOf('data-type="import"') !== -1) {
          return row;
        }
        return null;
      })
    };
    const pending = [];
    const fetchMock = jest.fn(async (url) => {
      expect(url).toBe('/manage/collections/9/jobs/api');
      return {
        ok: true,
        json: async () => ({
          counts: { total: 1, queued: 0, running: 1, done: 0, failed: 0 },
          jobs: [{
            id: 42,
            job_type: 'import',
            job_kind: 'submit',
            status: 'done',
            original_name: 'scan.pdf',
            page_count: 10,
            pages_rendered: 2,
            created_at: '2026-04-12T10:00:00.000Z'
          }]
        })
      };
    });

    const context = {
      console,
      JSON,
      Date,
      Math,
      String,
      Number,
      Boolean,
      Array,
      Object,
      RegExp,
      Promise,
      window: {
        confirm: jest.fn(() => true),
        location: { reload: jest.fn() },
        setTimeout(fn) {
          pending.push(fn());
          return pending.length;
        },
        setInterval(fn) {
          pending.push(fn());
          return pending.length;
        }
      },
      document: {
        addEventListener: jest.fn((event, handler) => {
          if (event === 'DOMContentLoaded') handler();
        }),
        querySelector: jest.fn((selector) => {
          if (selector === '.status-queued, .status-running, .status-processing') {
            return {};
          }
          return null;
        }),
        querySelectorAll: jest.fn((selector) => {
          if (selector === '.import-progress-bar[data-progress]') return [];
          if (selector === '.toggle-log-btn') return [];
          if (selector === '.retry-btn') return [];
          if (selector === '.delete-job-btn') return [];
          if (selector === '.job-cb') return [];
          if (selector === '.filter-tab') return [];
          if (selector === 'form[data-filter-sidebar="1"]') return [];
          if (selector === '.job-row[data-status="running"][data-type="transcription"], .job-row[data-status="running"][data-type="extraction"]') {
            return [];
          }
          return [];
        }),
        getElementById: jest.fn((id) => {
          if (id === 'jobs-page-config') {
            return {
              textContent: JSON.stringify({
                mode: 'manage',
                apiBase: '/manage/collections/9/jobs/api',
                pollUrl: '/manage/collections/9/jobs/api',
                filter: 'all',
                typeFilter: 'all'
              })
            };
          }
          if (id === 'jobs-tbody') return tbody;
          return null;
        })
      },
      fetch: fetchMock,
      setTimeout: function(fn) {
        pending.push(fn());
        return pending.length;
      },
      clearTimeout: () => {},
      setInterval: function(fn) {
        pending.push(fn());
        return pending.length;
      },
      clearInterval: () => {}
    };
    context.window.window = context.window;
    context.window.document = context.document;
    context.window.fetch = fetchMock;

    loadJobsPageScript(context);
    await flushPending(pending);

    expect(subjectCell.innerHTML).toContain('scan.pdf');
    expect(subjectCell.innerHTML).toContain('10 documents');
    expect(providerCell.innerHTML).toBe('—');
    expect(statusBadge.textContent).toBe('done');
    expect(statusBadge.className).toBe('status-badge status-done');
  });
});
