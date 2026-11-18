# GEO Engine Node.js Bridge — установка

Интеграция Node.js-сайтов (Express / NestJS / plain http) с geoengine.pro:
SEO-мета, JSON-LD, llms.txt, каталог товаров, managed-файлы, self-update.

## Требования

- Node.js 16+
- Express 4+ / NestJS 9+ — или любой фреймворк на plain `http`
- Записываемая директория для JSON-store и `GEO_BRIDGE_STATIC_DIR`
- API-ключ проекта в GEO Engine (Settings → API Keys, `ge_…`)

## Установка

```bash
npm install github:lyalik/geoengine-node#v1.0.1
```

или vendored-вариант (zip с geoengine.pro):

```bash
unzip geoengine-node.zip -d vendor/
# package.json: "@geoengine/node": "file:./vendor/geoengine-node"
npm install
```

## Подключение

Express — в `app.js` после `express.json()`:

```js
const { mountGeoEngineBridge } = require("@geoengine/node/express");
mountGeoEngineBridge(app);
```

NestJS — `main.ts`:

```ts
import { geoengineMiddleware } from "@geoengine/node/nestjs";
app.use(geoengineMiddleware());
```

Plain http:

```js
const { createGeoEngineHandler } = require("@geoengine/node/http");
const handler = createGeoEngineHandler();
http.createServer(async (req, res) => {
    if (await handler(req, res)) return;
    // ваш код
}).listen(3000);
```

## Env (.env)

```env
GEO_ENGINE_API_KEY=ge_ВАШ_КЛЮЧ
GEO_BRIDGE_SITE_URL=https://example.com
GEO_BRIDGE_STATIC_DIR=./public
GEO_ENGINE_API_URL=https://geoengine.pro
```

`GEO_BRIDGE_STATIC_DIR` — каталог, куда `upload-file` пишет llms.txt,
robots.txt, `.well-known/*` (обычно `public/` или `dist/`).

## Проверка

```bash
curl https://example.com/api/geo-engine-bridge/health
# {"status":"ok","service":"geo-engine-bridge","version":"1.0.0",...}
```

Затем в GEO Engine: Integrations → New → preset **Node.js Bridge** →
base_url = `https://example.com` → Test connection.

## Обновление

- npm-установка: `npm install @geoengine/node@latest` + restart.
- vendored/self-update: платформа пушит `POST /self-update` — пакет
  перезаписывается с backup+rollback; `GEO_BRIDGE_AUTO_RESTART=1`
  перезапустит процесс через supervisor (pm2/systemd/docker).
