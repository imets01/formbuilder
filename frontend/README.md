# FormBuilder frontend

Angular 21 client. See [../README.md](../README.md) and
[../docs/architecture.md](../docs/architecture.md).

| Command | Does |
|---|---|
| `npm start` | Dev server on http://localhost:4200 |
| `npm run build` | Production build into `dist/` |
| `npx ng test --watch=false --browsers=ChromeHeadless` | Unit tests |

Expects the backend on http://localhost:5000 — see `src/environments/environment.ts`.
