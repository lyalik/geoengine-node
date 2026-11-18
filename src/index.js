"use strict";

// @geoengine/node — GEO Engine bridge for Node.js.
//
//   const { createBridge } = require("@geoengine/node");
//   const bridge = createBridge();
//   const out = await bridge.handle({ method, pathname, query, headers, body });
//
// Framework adapters:
//   require("@geoengine/node/express")  → mountGeoEngineBridge(app, opts)
//   require("@geoengine/node/nestjs")   → geoengineMiddleware(), createGeoEngineModule()
//   require("@geoengine/node/http")     → createGeoEngineHandler()
//   require("@geoengine/node/inject")   → createSeoMiddleware() (HTML <head> injection)
//
// Configuration via env (or createBridge options):
//   GEO_ENGINE_API_KEY      — project API key from GEO Engine (required,
//                             fail-closed: authed endpoints 503 without it)
//   GEO_BRIDGE_SITE_URL     — public site URL, e.g. https://example.com
//   GEO_BRIDGE_PAGES        — comma-separated public routes (default "home")
//   GEO_BRIDGE_STORE        — JSON file for SEO overrides
//                             (default ./geo_bridge_store.json)
//   GEO_BRIDGE_PRODUCTS_STORE — JSON file for the product catalog mirror
//                             (default ./geo_bridge_products.json)
//   GEO_BRIDGE_STATIC_DIR   — dir where upload-file writes
//                             (llms.txt, robots.txt, .well-known/*)
//   GEO_BRIDGE_POST_HANDLER — "module:exportFn" for POST /posts blog hook
//   GEO_ENGINE_API_URL      — GEO Engine API base for /self-update package
//                             pulls (e.g. https://geoengine.pro)
//   GEO_BRIDGE_AUTO_RESTART — "1" to exit the process after a successful
//                             self-update (pm2/systemd/docker restarts it)

const { createBridge, PREFIX, VERSION } = require("./contract");
const { createStores, JsonStore } = require("./store");
const { injectSeo, createSeoMiddleware, pageFromPath } = require("./inject");

module.exports = {
    createBridge,
    createStores,
    JsonStore,
    injectSeo,
    createSeoMiddleware,
    pageFromPath,
    PREFIX,
    VERSION,
};
