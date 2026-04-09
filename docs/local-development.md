# Local Development

For project-wide architecture, principles, and contribution workflow, also see:

- [`docs/architecture.md`](./architecture.md)
- [`docs/development-principles.md`](./development-principles.md)
- [`docs/knowledge-graph-design.md`](./knowledge-graph-design.md)
- [`CONTRIBUTING.md`](../CONTRIBUTING.md)

For UI- and template-layer changes, follow
[`docs/ui-template-standards.md`](./ui-template-standards.md). That document is
the project baseline for EJS, shared partials, CSS organization, and
presentation-layer accessibility/usability conventions.

## Python dependencies for analytics

Collection topic analysis uses the Python BERTopic stack. Install it into a
project-local virtualenv with:

```bash
npm run setup:python
```

This creates `.venv/` and installs the packages from `requirements.txt`.

The analytics runtime will automatically use `.venv/bin/python3` when that
virtualenv exists. If you need to point the app at a different interpreter,
set:

```bash
PYTHON_BIN=/absolute/path/to/python3
```

## Typical startup

```bash
npm install
npm run setup:python
npm start
```
