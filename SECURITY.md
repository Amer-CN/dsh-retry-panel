# Security

## Reporting

If you believe this plugin has a security issue, please open a private report via
GitHub Security Advisories on
<https://github.com/Amer-CN/dsh-retry-panel/security/advisories/new>
or email the maintainer listed in `package.json`. Please do not open a public
issue for a vulnerability before it is triaged.

## Runtime boundary

- Host code lives in `lib/index.js`; browser code lives in `lib/client.js`.
- The plugin writes only DSH settings (`llm-pi-ai`, `llm-deepseek`, `auto-retry`)
  through the official settings service.
- The browser panel requests only same-origin routes:
  - `POST /api/auto-retry/apply`
  - `GET /api/auto-retry/catalog`
- No external hosts, no model-provider calls, no file or credential access,
  no lifecycle scripts, no native artifacts.
- The bundle patch only inserts the plugin's own `auto-retry` entry and declares
  `network: true`, `storage: false`.

## Supply chain

`@deepseek-ai/schemastery` is pinned to `3.18.4` and committed with
`pnpm-lock.yaml`. The repository has no build step; `lib/*.js` is the published
artifact.
