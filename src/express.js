"use strict";

// Express adapter: mounts the whole bridge contract on an Express app.
//
//   const express = require("express");
//   const { mountGeoEngineBridge } = require("@geoengine/node/express");
//   const app = express();
//   app.use(express.json({ limit: "5mb" }));
//   mountGeoEngineBridge(app);
//
// Options override env vars (GEO_ENGINE_API_KEY, GEO_BRIDGE_SITE_URL,
// GEO_BRIDGE_PAGES, GEO_BRIDGE_STORE, GEO_BRIDGE_STATIC_DIR,
// GEO_BRIDGE_POST_HANDLER, GEO_ENGINE_API_URL, GEO_BRIDGE_AUTO_RESTART).

const { createBridge, PREFIX } = require("./contract");

function mountGeoEngineBridge(app, options = {}) {
    const bridge = createBridge(options);

    app.use(PREFIX, async (req, res, next) => {
        try {
            // Inside app.use(PREFIX) req.path is stripped of the mount
            // prefix — rebuild the contract path from req.originalUrl.
            const pathname = PREFIX + (req.path === "/" ? "" : req.path) || PREFIX + "/";
            const out = await bridge.handle({
                method: req.method,
                pathname,
                query: req.query || {},
                headers: req.headers || {},
                body: req.body,
            });
            if (out === null) {
                return res.status(404).json({ detail: "Not found" });
            }
            for (const [k, v] of Object.entries(out.headers || {})) {
                res.setHeader(k, v);
            }
            if (typeof out.body === "string") {
                return res.status(out.status).send(out.body);
            }
            return res.status(out.status).json(out.body);
        } catch (exc) {
            return next(exc);
        }
    });

    return bridge;
}

module.exports = { mountGeoEngineBridge };
