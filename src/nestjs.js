"use strict";

// NestJS adapter — two usage styles:
//
//   1) Middleware (simplest, works with any platform):
//        // main.ts
//        import { geoengineMiddleware } from "@geoengine/node/nestjs";
//        app.use(geoengineMiddleware());
//
//   2) Module + middleware consumer (idiomatic, requires @nestjs/common):
//        import { createGeoEngineModule } from "@geoengine/node/nestjs";
//        @Module({ imports: [createGeoEngineModule()] }) ...
//
// The middleware path covers Express AND Fastify platforms because it
// speaks plain Node req/res — Fastify needs middie enabled for app.use().

const { createBridge, PREFIX } = require("./contract");

function parseQuery(rawUrl) {
    const qIndex = rawUrl.indexOf("?");
    const pathname = qIndex === -1 ? rawUrl : rawUrl.slice(0, qIndex);
    const query = {};
    if (qIndex !== -1) {
        for (const pair of rawUrl.slice(qIndex + 1).split("&")) {
            const eq = pair.indexOf("=");
            const k = eq === -1 ? pair : pair.slice(0, eq);
            const v = eq === -1 ? "" : pair.slice(eq + 1);
            if (k) query[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, " "));
        }
    }
    return { pathname, query };
}

function writeResult(res, out) {
    if (out === null) {
        res.statusCode = 404;
        res.setHeader("content-type", "application/json; charset=utf-8");
        res.end(JSON.stringify({ detail: "Not found" }));
        return;
    }
    for (const [k, v] of Object.entries(out.headers || {})) {
        res.setHeader(k, v);
    }
    res.statusCode = out.status;
    res.end(typeof out.body === "string" ? out.body : JSON.stringify(out.body));
}

function geoengineMiddleware(options = {}) {
    const bridge = createBridge(options);
    return function geoengineNestMiddleware(req, res, next) {
        const { pathname, query } = parseQuery(req.originalUrl || req.url || "");
        if (!pathname.startsWith(PREFIX)) {
            return next();
        }
        bridge
            .handle({ method: req.method, pathname, query, headers: req.headers || {}, body: req.body })
            .then((out) => writeResult(res, out))
            .catch((exc) => next(exc));
    };
}

/**
 * Idiomatic NestJS module. Usage:
 *
 *   import { Module } from "@nestjs/common";
 *   import { createGeoEngineModule } from "@geoengine/node/nestjs";
 *   @Module({ imports: [createGeoEngineModule({ apiKey: "ge_..." })] })
 *   export class AppModule {}
 *
 * Requires @nestjs/common at runtime; returns null when absent so the
 * middleware-only path keeps working without it.
 */
function createGeoEngineModule(options = {}) {
    let Module, Injectable;
    try {
        ({ Module, Injectable } = require("@nestjs/common"));
    } catch {
        return null;
    }

    const bridge = createBridge(options);

    class GeoEngineBridgeMiddleware {
        use(req, res, next) {
            const { pathname, query } = parseQuery(req.originalUrl || req.url || "");
            if (!pathname.startsWith(PREFIX)) {
                return next();
            }
            bridge
                .handle({ method: req.method, pathname, query, headers: req.headers || {}, body: req.body })
                .then((out) => writeResult(res, out))
                .catch(next);
        }
    }
    Injectable()(GeoEngineBridgeMiddleware);

    class GeoEngineBridgeNestModule {
        configure(consumer) {
            consumer.apply(GeoEngineBridgeMiddleware).forRoutes("*");
        }
    }
    return Module({ providers: [GeoEngineBridgeMiddleware] })(GeoEngineBridgeNestModule);
}

module.exports = { geoengineMiddleware, createGeoEngineModule, PREFIX };
