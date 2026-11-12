# Contributing

Use Node.js 24.9 or newer. There are no runtime dependencies to install.

```sh
npm test
npm pack --dry-run
```

Keep changes small and include a reproducible example for bug fixes. Tests use a fake upstream; never add a real provider key. Explain which DSH version and protocol you checked. The current desktop compatibility target is DSH 0.2.1-rc.5.

`client.js` contains the native client bundle. `dashboard.css` and `dashboard-components.js` are included in that file: when editing either design source, update the embedded copy too. Keep the UI dependent on DSH's native theme variables and preserve Chinese and English labels.

Useful contributions: pricing/calendar maintenance, safer receipt accounting, accessibility, documented DSH compatibility checks and installation improvements. Please discuss additional upstream providers first; this project currently serves DeepSeek only.

Optional GitHub Actions template: copy `docs/ci.example.yml` to `.github/workflows/ci.yml` when your publishing credentials allow workflow changes.
