"use strict";

// Plain Node http adapter — for apps not built on Express/NestJS
// (Fastify via middie, Koa via koa-mount, raw http.createServer, etc.).
//
//   const { createGeoEngineHandler } = require("@geoengine/node/http");
//   const handler = createGeoEngineHandler();
//   http.createServer((req, res) => {
//       if (handler(req, res)) return;      // handled by bridge
//       // ... your app
//   }).listen(3000);
//
// Returns a function (req, res) => boolean — true when the request was
// handled (bridge path matched), false to pass through to your app.

const { createBridge, PREFIX } = require("./contract");

function readBody(req) {
    return new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            if (size > 5 * 1024 * 1024) {
                req.destroy();
                resolve(null);
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (!chunks.length) return resolve(null);
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                resolve(null);
            }
        });
        req.on("error", () => resolve(null));
    });
}

function createGeoEngineHandler(options = {}) {
    const bridge = createBridge(options);

    return async function geoengineHandler(req, res) {
        const rawUrl = req.url || "/";
        const qIndex = rawUrl.indexOf("?");
        const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
        if (!pathname.startsWith(PREFIX)) {
            return false;
        }
        const query = {};
        if (qIndex !== -1) {
            for (const pair of rawUrl.slice(qIndex + 1).split("&")) {
                const eq = pair.indexOf("=");
                const k = eq === -1 ? pair : pair.slice(0, eq);
                const v = eq === -1 ? "" : pair.slice(eq + 1);
                if (k) query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
            }
        }
        const body = ["POST", "PUT", "PATCH"].includes(req.method) ? await readBody(req) : null;
        const out = await bridge.handle({
            method: req.method,
            pathname,
            query,
            headers: req.headers || {},
            body,
        });
        if (out === null) {
            res.statusCode = 404;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.end(JSON.stringify({ detail: "Not found" }));
            return true;
        }
        for (const [k, v] of Object.entries(out.headers || {})) {
            res.setHeader(k, v);
        }
        res.statusCode = out.status;
        res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
        return true;
    };
}

module.exports = { createGeoEngineHandler };
