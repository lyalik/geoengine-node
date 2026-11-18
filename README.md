# @geoengine/node — GEO Engine bridge for Node.js

Drop-in bridge that lets [GEO Engine](https://geoengine.pro) manage SEO meta,
JSON-LD, llms.txt, the product catalog and managed files on any Node.js site —
**Express**, **NestJS**, or plain `http`.

## Install

```bash
npm install @geoengine/node
# or vendored: unpack geoengine-node.zip into your project and
# "file:./geoengine-node" in package.json
```

## Express

```js
const express = require("express");
const { mountGeoEngineBridge } = require("@geoengine/node/express");
const { createSeoMiddleware } = require("@geoengine/node/inject");

const app = express();
app.use(express.json({ limit: "5mb" }));
mountGeoEngineBridge(app);            // /api/geo-engine-bridge/*
app.use(createSeoMiddleware());       // inject managed meta into HTML (optional)
```

## NestJS

```ts
// main.ts
import { geoengineMiddleware } from "@geoengine/node/nestjs";
app.use(geoengineMiddleware());

// or idiomatic module:
import { Module } from "@nestjs/common";
import { createGeoEngineModule } from "@geoengine/node/nestjs";
@Module({ imports: [createGeoEngineModule()] })
export class AppModule {}
```

## Plain Node http / other frameworks

```js
const { createGeoEngineHandler } = require("@geoengine/node/http");
const handler = createGeoEngineHandler(); // (req, res) => Promise<boolean>
http.createServer(async (req, res) => {
    if (await handler(req, res)) return;   // bridge handled it
    // ... your app
}).listen(3000);
```

## Configuration (env)

| Var | Purpose |
|---|---|
| `GEO_ENGINE_API_KEY` | Project API key from GEO Engine → Settings → API Keys (`ge_…`). **Required** — authed endpoints fail closed (503) without it. |
| `GEO_BRIDGE_SITE_URL` | Public site URL, e.g. `https://example.com` |
| `GEO_BRIDGE_PAGES` | Comma-separated public routes (default `home`) |
| `GEO_BRIDGE_STORE` | JSON file for SEO overrides (default `./geo_bridge_store.json`) |
| `GEO_BRIDGE_PRODUCTS_STORE` | JSON file for product catalog mirror |
| `GEO_BRIDGE_STATIC_DIR` | Dir where `upload-file` writes (llms.txt, robots.txt, `.well-known/*`) |
| `GEO_BRIDGE_POST_HANDLER` | `module:exportFn` hook for `POST /posts` blog publishing |
| `GEO_ENGINE_API_URL` | GEO Engine API base for `/self-update` package pulls |
| `GEO_BRIDGE_AUTO_RESTART` | `1` → exit process after successful self-update (pm2/systemd restarts) |

All of the above can also be passed as options to `createBridge()` /
`mountGeoEngineBridge()` / `createGeoEngineHandler()`.

## Endpoints

Public: `health`, `recon`, `structured-data`, `page-meta`, `llms-txt`,
`products/{id}`.

Authed (`X-Api-Key`): `pages` list/get/PUT/POST, `apply-fix`, `ai-export`,
`upload-file`/`publish-file`, `posts`, `products` list/upsert/PUT,
`self-update`.

## Notes

- The JSON stores re-read on mtime change — safe under `cluster`/pm2
  multi-process setups.
- `self-update` copies files over the installed package dir with backup +
  rollback. For read-only `node_modules` use `npm install @geoengine/node@latest`
  and restart instead.
- Managed meta is only injected where a stored record exists — customer
  HTML is never touched otherwise.
