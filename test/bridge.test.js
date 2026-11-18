"use strict";

const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createGeoEngineHandler } = require("../src/http");

function tmpdir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "geo-test-"));
}

async function withServer(handler, fn) {
    const server = http.createServer(async (req, res) => {
        const handled = await handler(req, res);
        if (!handled) {
            res.statusCode = 404;
            res.end("app 404");
        }
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;
    try {
        await fn(port);
    } finally {
        server.close();
    }
}

function req(port, method, p, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const r = http.request(
            {
                host: "127.0.0.1",
                port,
                path: p,
                method,
                headers: {
                    ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}),
                    ...headers,
                },
            },
            (res) => {
                const chunks = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    const text = Buffer.concat(chunks).toString("utf8");
                    let json = null;
                    try { json = JSON.parse(text); } catch { /* text */ }
                    resolve({ status: res.statusCode, json, text, headers: res.headers });
                });
            }
        );
        r.on("error", reject);
        if (data) r.write(data);
        r.end();
    });
}

function makeHandler(env) {
    return createGeoEngineHandler({
        apiKey: "test-key-123",
        siteUrl: "https://example.test",
        env: {
            GEO_BRIDGE_STORE: path.join(tmpdir(), "seo.json"),
            GEO_BRIDGE_PRODUCTS_STORE: path.join(tmpdir(), "products.json"),
            GEO_BRIDGE_STATIC_DIR: tmpdir(),
            ...env,
        },
    });
}

test("health + recon are public", async () => {
    await withServer(makeHandler(), async (port) => {
        const h = await req(port, "GET", "/api/geo-engine-bridge/health");
        assert.equal(h.status, 200);
        assert.equal(h.json.service, "geo-engine-bridge");
        assert.equal(h.json.framework, "nodejs");
        assert.equal(h.json.version, "1.0.1");

        const r = await req(port, "GET", "/api/geo-engine-bridge/recon");
        assert.equal(r.status, 200);
        assert.equal(r.json.bridge, "geo-engine");
        assert.ok(r.json.capabilities.includes("self_update"));
    });
});

test("authed endpoints fail closed", async () => {
    await withServer(makeHandler(), async (port) => {
        const noKey = await req(port, "GET", "/api/geo-engine-bridge/pages");
        assert.equal(noKey.status, 401);
        const badKey = await req(port, "GET", "/api/geo-engine-bridge/pages", { headers: { "x-api-key": "wrong" } });
        assert.equal(badKey.status, 401);
        const ok = await req(port, "GET", "/api/geo-engine-bridge/pages", { headers: { "x-api-key": "test-key-123" } });
        assert.equal(ok.status, 200);
        assert.ok(Array.isArray(ok.json.pages));
    });
});

test("missing api key config → 503", async () => {
    const handler = createGeoEngineHandler({ apiKey: "", env: { GEO_ENGINE_API_KEY: "" } });
    await withServer(handler, async (port) => {
        const r = await req(port, "GET", "/api/geo-engine-bridge/pages", { headers: { "x-api-key": "anything" } });
        assert.equal(r.status, 503);
    });
});

test("page upsert → get → page-meta → apply-fix", async () => {
    await withServer(makeHandler(), async (port) => {
        const auth = { "x-api-key": "test-key-123" };
        const up = await req(port, "POST", "/api/geo-engine-bridge/pages/about", {
            headers: auth,
            body: { title: "About", description: "About us", keywords: ["a", "b"], structuredData: { "@type": "WebPage" } },
        });
        assert.equal(up.status, 200);
        assert.equal(up.json.created, true);

        const get = await req(port, "GET", "/api/geo-engine-bridge/pages/about", { headers: auth });
        assert.equal(get.status, 200);
        assert.equal(get.json.title, "About");
        assert.deepEqual(get.json.structuredData, { "@type": "WebPage" });

        const meta = await req(port, "GET", "/api/geo-engine-bridge/page-meta?page=/about");
        assert.equal(meta.json.title, "About");
        assert.equal(meta.json.indexable, true);

        const sd = await req(port, "GET", "/api/geo-engine-bridge/structured-data");
        assert.deepEqual(sd.json.about, { "@type": "WebPage" });

        const fix = await req(port, "POST", "/api/geo-engine-bridge/apply-fix", {
            headers: auth,
            body: {
                page: "about",
                issue_type: "missing_description",
                title: "ISSUE LABEL — DO NOT WRITE TO TITLE",
                description: "ISSUE DESC — DO NOT WRITE",
                fix_content: '<meta name="description" content="New desc">',
            },
        });
        assert.equal(fix.json.success, true);
        const get2 = await req(port, "GET", "/api/geo-engine-bridge/pages/about", { headers: auth });
        assert.equal(get2.json.title, "About");
        assert.equal(get2.json.description, "New desc");

        // Unmapped issue_type must refuse honestly without corrupting title/description
        const unmapped = await req(port, "POST", "/api/geo-engine-bridge/apply-fix", {
            headers: auth,
            body: {
                page: "about",
                issue_type: "thin_content",
                title: "Thin content issue",
                description: "Too short",
                fix_content: "<p>More text</p>",
            },
        });
        assert.equal(unmapped.json.success, false);
        const get3 = await req(port, "GET", "/api/geo-engine-bridge/pages/about", { headers: auth });
        assert.equal(get3.json.title, "About");
        assert.equal(get3.json.description, "New desc");

        // PUT on crawler-discovered page not in GEO_BRIDGE_PAGES upserts cleanly
        const putNew = await req(port, "PUT", "/api/geo-engine-bridge/pages/pricing", {
            headers: auth,
            body: { title: "Pricing Page" },
        });
        assert.equal(putNew.status, 200);
        const getPricing = await req(port, "GET", "/api/geo-engine-bridge/pages/pricing", { headers: auth });
        assert.equal(getPricing.json.title, "Pricing Page");

        const ai = await req(port, "GET", "/api/geo-engine-bridge/ai-export", { headers: auth });
        assert.equal(ai.json.count >= 1, true);
    });
});

test("products catalog flow", async () => {
    await withServer(makeHandler(), async (port) => {
        const auth = { "x-api-key": "test-key-123" };
        const up = await req(port, "POST", "/api/geo-engine-bridge/products", {
            headers: auth,
            body: { items: [{ external_id: "sku-1", name: "Widget", price: 100 }] },
        });
        assert.equal(up.json.upserted, 1);

        const list = await req(port, "GET", "/api/geo-engine-bridge/products", { headers: auth });
        assert.equal(list.json.total, 1);
        assert.equal(list.json.items[0].external_id, "sku-1");

        const pub = await req(port, "GET", "/api/geo-engine-bridge/products/sku-1");
        assert.equal(pub.status, 200);
        assert.equal(pub.json.fields.name, "Widget");

        const upd = await req(port, "PUT", "/api/geo-engine-bridge/products/sku-1", {
            headers: auth,
            body: { fields: { name: "Rewritten Name", description: "AI description" } },
        });
        assert.equal(upd.json.ok, true);
        assert.deepEqual(upd.json.result_data.skipped_fields, ["name:protected"]);
        const pub2 = await req(port, "GET", "/api/geo-engine-bridge/products/sku-1");
        assert.equal(pub2.json.fields.name, "Widget");
        assert.equal(pub2.json.fields.description, "AI description");

        const updAllow = await req(port, "PUT", "/api/geo-engine-bridge/products/sku-1", {
            headers: auth,
            body: { fields: { name: "Allowed Name", _allow_name: true } },
        });
        assert.equal(updAllow.json.ok, true);
        const pub3 = await req(port, "GET", "/api/geo-engine-bridge/products/sku-1");
        assert.equal(pub3.json.fields.name, "Allowed Name");
    });
});

test("upload-file writes into static dir", async () => {
    const staticDir = tmpdir();
    const handler = createGeoEngineHandler({
        apiKey: "k",
        siteUrl: "https://example.test",
        env: {
            GEO_BRIDGE_STATIC_DIR: staticDir,
            GEO_BRIDGE_STORE: path.join(tmpdir(), "s.json"),
            GEO_BRIDGE_PRODUCTS_STORE: path.join(tmpdir(), "p.json"),
        },
    });
    await withServer(handler, async (port) => {
        const r = await req(port, "POST", "/api/geo-engine-bridge/upload-file", {
            headers: { "x-api-key": "k" },
            body: { filename: "llms.txt", content: "# Hello" },
        });
        assert.equal(r.status, 200);
        assert.equal(fs.readFileSync(path.join(staticDir, "llms.txt"), "utf8"), "# Hello");

        const bad = await req(port, "POST", "/api/geo-engine-bridge/upload-file", {
            headers: { "x-api-key": "k" },
            body: { filename: "../evil.txt", content: "x" },
        });
        assert.equal(bad.status, 422);
    });
});

test("non-bridge paths pass through", async () => {
    await withServer(makeHandler(), async (port) => {
        const r = await req(port, "GET", "/api/other");
        assert.equal(r.status, 404);
        assert.equal(r.text, "app 404");
    });
});
