"use strict";

// Framework-agnostic implementation of the GEO Engine bridge contract.
//
// DirectApiConnector calls these endpoints (same shape as the FastAPI
// geoengine_bridge and the Laravel agent):
//
//   GET  /api/geo-engine-bridge/health            public
//   GET  /api/geo-engine-bridge/recon             public (Scout probe)
//   GET  /api/geo-engine-bridge/structured-data   public
//   GET  /api/geo-engine-bridge/page-meta         public (?page=...)
//   GET  /api/geo-engine-bridge/llms-txt          public (text)
//   GET  /api/geo-engine-bridge/products/{id}     public (render-time)
//   GET  /api/geo-engine-bridge/pages             x-api-key
//   GET  /api/geo-engine-bridge/pages/{page}      x-api-key
//   PUT  /api/geo-engine-bridge/pages/{page}      x-api-key
//   POST /api/geo-engine-bridge/pages/{page}      x-api-key (upsert)
//   POST /api/geo-engine-bridge/apply-fix         x-api-key
//   GET  /api/geo-engine-bridge/ai-export         x-api-key
//   POST /api/geo-engine-bridge/upload-file       x-api-key
//   POST /api/geo-engine-bridge/publish-file      x-api-key (alias)
//   POST /api/geo-engine-bridge/posts             x-api-key
//   GET  /api/geo-engine-bridge/products          x-api-key
//   POST /api/geo-engine-bridge/products          x-api-key
//   PUT  /api/geo-engine-bridge/products/{id}     x-api-key
//   POST /api/geo-engine-bridge/self-update       x-api-key
//
// The handler is transport-free: adapters (express.js, nestjs.js,
// http.js) translate framework req/res into
//   { method, pathname, query, headers, body, rawBody }
// and write back { status, headers, body }.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { VERSION } = require("./version");
const { createStores } = require("./store");
const { selfUpdate } = require("./selfUpdate");

const PREFIX = "/api/geo-engine-bridge";

const ISSUE_FIELD_MAP = {
    missing_title: "title",
    short_title: "title",
    long_title: "title",
    duplicate_title: "title",
    missing_description: "description",
    missing_meta_description: "description",
    short_description: "description",
    long_description: "description",
    duplicate_description: "description",
    missing_canonical: "canonical_url",
    missing_schema: "structured_data",
    missing_structured_data: "structured_data",
    schema_markup: "structured_data",
    missing_h1: "h1",
};

function cleanFixValue(field, raw) {
    if (typeof raw !== "string") return raw;
    const text = raw.trim();
    if (field === "title") {
        const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text);
        return m ? m[1].trim() : text;
    }
    if (field === "description") {
        const m = /content=["']([\s\S]*?)["']/i.exec(text);
        return m && /<meta/i.test(text) ? m[1].trim() : text;
    }
    if (field === "canonical_url") {
        const m = /href=["']([^"']+)["']/i.exec(text);
        return m && /<link/i.test(text) ? m[1].trim() : text;
    }
    if (field === "h1") {
        const m = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(text);
        return m ? m[1].trim() : text;
    }
    if (field === "structured_data") {
        const scripts = [...text.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
        if (scripts.length) {
            const parsed = [];
            for (const s of scripts) {
                try { parsed.push(JSON.parse(s[1].trim())); } catch { /* ignore */ }
            }
            if (parsed.length) return parsed.length === 1 ? parsed[0] : parsed;
        }
        try {
            return JSON.parse(text);
        } catch {
            return { "@context": "https://schema.org", raw: text };
        }
    }
    return text;
}

const ALLOWED_UPLOAD_NAMES = /^(?:\.well-known\/[A-Za-z0-9._-]+|[A-Za-z0-9][A-Za-z0-9._-]{0,120})$/;
const PAGE_ID_RE = /^[A-Za-z0-9_\-/]{1,200}$/;
const PRODUCT_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

function envBool(name) {
    return ["1", "true", "yes"].includes(String(process.env[name] || "").toLowerCase());
}

function createBridge(options = {}) {
    const env = options.env || process.env;
    const apiKey = options.apiKey !== undefined ? options.apiKey : env.GEO_ENGINE_API_KEY || "";
    const siteUrl = String(options.siteUrl !== undefined ? options.siteUrl : env.GEO_BRIDGE_SITE_URL || "").replace(/\/+$/, "");
    const staticDir = options.staticDir !== undefined ? options.staticDir : env.GEO_BRIDGE_STATIC_DIR || "";
    const configuredPages = String(env.GEO_BRIDGE_PAGES || "home");
    const autoRestart = options.autoRestart !== undefined ? options.autoRestart : envBool("GEO_BRIDGE_AUTO_RESTART");
    const postHandler = options.postHandler !== undefined ? options.postHandler : env.GEO_BRIDGE_POST_HANDLER || "";
    const { seo: store, products: productStore } = createStores(env);

    function allPages() {
        const pages = configuredPages
            .split(",")
            .map((p) => p.trim().replace(/^\/+|\/+$/g, "") || "home")
            .filter(Boolean);
        for (const slug of Object.keys(store.all())) {
            if (!pages.includes(slug)) pages.push(slug);
        }
        return pages;
    }

    function normalizePageId(pageId) {
        return String(pageId || "").replace(/^\/+|\/+$/g, "") || "home";
    }

    function pageUrl(page) {
        return page === "home" ? siteUrl : `${siteUrl}/${page}`;
    }

    function findPage(pageId) {
        // Tolerate percent-encoded and nested slugs.
        let slug = normalizePageId(decodeURIComponentSafe(String(pageId || "")));
        return allPages().includes(slug) ? slug : null;
    }

    function decodeURIComponentSafe(s) {
        try {
            return decodeURIComponent(s);
        } catch {
            return s;
        }
    }

    function publicView(page) {
        const rec = store.get(page) || {};
        return {
            id: page,
            page,
            url: pageUrl(page),
            title: rec.title ?? null,
            description: rec.description ?? null,
            structuredData: rec.structured_data ?? null,
        };
    }

    function fullView(page) {
        const rec = store.get(page) || {};
        return {
            ...publicView(page),
            keywords: rec.keywords ?? null,
            og_title: rec.og_title ?? null,
            og_description: rec.og_description ?? null,
            og_image: rec.og_image ?? null,
            twitter_title: rec.twitter_title ?? null,
            twitter_description: rec.twitter_description ?? null,
            canonical_url: rec.canonical_url ?? null,
            indexable: rec.indexable !== false,
            custom_meta: rec.custom_meta ?? null,
        };
    }

    const SEO_FIELD_ALIASES = {
        title: ["title"],
        description: ["description"],
        keywords: ["keywords"],
        og_title: ["og_title", "ogTitle"],
        og_description: ["og_description", "ogDescription"],
        og_image: ["og_image", "ogImage"],
        twitter_title: ["twitter_title", "twitterTitle"],
        twitter_description: ["twitter_description", "twitterDescription"],
        twitter_image: ["twitter_image", "twitterImage"],
        canonical_url: ["canonical_url", "canonicalUrl", "canonical"],
        structured_data: ["structured_data", "structuredData"],
        indexable: ["indexable"],
        h1: ["h1"],
    };

    function seoFieldsFromBody(body) {
        const fields = {};
        for (const [field, aliases] of Object.entries(SEO_FIELD_ALIASES)) {
            for (const alias of aliases) {
                if (body && body[alias] !== undefined) {
                    let value = body[alias];
                    if (field === "keywords" && Array.isArray(value)) {
                        value = value.map(String).join(", ");
                    }
                    fields[field] = value;
                    break;
                }
            }
        }
        return fields;
    }

    function authed(headers) {
        if (!apiKey) {
            return { status: 503, body: { detail: "GEO_ENGINE_API_KEY is not configured" } };
        }
        const provided = String(headers["x-api-key"] || "");
        const a = Buffer.from(provided);
        const b = Buffer.from(apiKey);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
            return { status: 401, body: { detail: "Invalid or missing API key" } };
        }
        return null;
    }

    function json(status, body) {
        return { status, headers: { "content-type": "application/json; charset=utf-8" }, body };
    }

    function err(status, detail) {
        return json(status, { detail });
    }

    async function fetchMediaToStatic(productId, key, url, ext) {
        if (!staticDir || !/^https?:\/\//i.test(url)) return "";
        try {
            const resp = await fetch(url, {
                headers: { "user-agent": "geoengine-bridge" },
                signal: AbortSignal.timeout(60000),
            });
            if (!resp.ok) return "";
            const buf = Buffer.from(await resp.arrayBuffer());
            if (!buf.length || buf.length > 50 * 1024 * 1024) return "";
            const mediaDir = path.join(staticDir, "media");
            fs.mkdirSync(mediaDir, { recursive: true });
            const name = `${productId}-${key[0]}-${Date.now()}.${ext}`;
            fs.writeFileSync(path.join(mediaDir, name), buf);
            return `media/${name}`;
        } catch {
            return "";
        }
    }

    async function handle(req) {
        const { method, pathname, query = {}, headers = {}, body = null } = req;
        const rel = pathname.startsWith(PREFIX) ? pathname.slice(PREFIX.length) || "/" : null;
        if (rel === null) return null; // not ours — let the app handle it

        const m = method.toUpperCase();

        // ---------------- public ----------------
        if (m === "GET" && rel === "/health") {
            let writable = false;
            try {
                fs.accessSync(__dirname, fs.constants.W_OK);
                writable = true;
            } catch {
                writable = false;
            }
            return json(200, {
                status: "ok",
                service: "geo-engine-bridge",
                framework: "nodejs",
                version: VERSION,
                module_dir_writable: writable,
            });
        }
        if (m === "GET" && rel === "/recon") {
            return json(200, {
                bridge: "geo-engine",
                version: VERSION,
                platform: "custom",
                framework: "nodejs",
                auth: { type: "header", key: "x-api-key" },
                capabilities: [
                    "pages.list", "pages.read", "pages.upsert", "seo.apply",
                    "fix.apply", "ai_export", "file.upload", "self_update",
                    "products.list", "products.read", "products.upsert",
                    "posts.create",
                ],
                endpoints: {
                    health: `${PREFIX}/health`,
                    pages: `${PREFIX}/pages`,
                    apply_seo: `${PREFIX}/pages/{page}`,
                    apply_fix: `${PREFIX}/apply-fix`,
                    ai_export: `${PREFIX}/ai-export`,
                    upload_file: `${PREFIX}/upload-file`,
                    self_update: `${PREFIX}/self-update`,
                },
            });
        }
        if (m === "GET" && rel === "/structured-data") {
            const out = {};
            for (const page of allPages()) {
                const rec = store.get(page) || {};
                if (rec.structured_data) out[page] = rec.structured_data;
            }
            return json(200, out);
        }
        if (m === "GET" && rel === "/page-meta") {
            const rec = store.get(normalizePageId(query.page || "home")) || {};
            return json(200, {
                title: rec.title ?? null,
                description: rec.description ?? null,
                keywords: rec.keywords ?? null,
                canonical_url: rec.canonical_url ?? null,
                indexable: rec.indexable !== false,
                og_title: rec.og_title ?? null,
                og_description: rec.og_description ?? null,
                og_image: rec.og_image ?? null,
            });
        }
        if (m === "GET" && rel === "/llms-txt") {
            if (staticDir) {
                const candidate = path.join(staticDir, "llms.txt");
                try {
                    if (fs.existsSync(candidate)) {
                        return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: fs.readFileSync(candidate, "utf8") };
                    }
                } catch { /* fall through to generated */ }
            }
            const lines = [`# ${siteUrl || "site"}`, ""];
            for (const page of allPages()) {
                const rec = store.get(page) || {};
                const title = rec.title || page;
                const desc = rec.description || "";
                lines.push(`- [${title}](${pageUrl(page)})` + (desc ? `: ${desc}` : ""));
            }
            return { status: 200, headers: { "content-type": "text/plain; charset=utf-8" }, body: lines.join("\n") + "\n" };
        }

        // products/{id} is public (render-time read)
        const prodPub = rel.match(/^\/products\/([^/]+)$/);
        if (m === "GET" && prodPub) {
            const rec = productStore.get(decodeURIComponentSafe(prodPub[1]));
            if (rec === null) return err(404, "Product not found");
            return json(200, { product_id: prodPub[1], fields: rec });
        }

        // ---------------- authed ----------------
        const deny = authed(headers);
        if (deny) return deny;

        if (m === "GET" && rel === "/pages") {
            return json(200, { pages: allPages().map(publicView) });
        }

        const pageMatch = rel.match(/^\/pages\/(.+)$/);
        if (pageMatch) {
            const pageId = decodeURIComponentSafe(pageMatch[1]);
            if (m === "GET") {
                const page = findPage(pageId);
                if (page === null) return err(404, "Page not found");
                return json(200, fullView(page));
            }
            if (m === "PUT") {
                let page = findPage(pageId);
                if (page === null) {
                    const cand = normalizePageId(pageId);
                    if (!PAGE_ID_RE.test(cand)) return err(422, "Invalid page slug");
                    page = cand;
                }
                const fields = seoFieldsFromBody(body || {});
                store.update(page, fields);
                return json(200, { ok: true, page_id: pageId, page });
            }
            if (m === "POST") {
                const page = normalizePageId(pageId);
                if (!PAGE_ID_RE.test(page)) return err(422, "Invalid page slug");
                const fields = seoFieldsFromBody(body || {});
                const created = !allPages().includes(page);
                store.update(page, fields);
                return json(200, { ok: true, page_id: pageId, page, created });
            }
        }

        if (m === "POST" && rel === "/apply-fix") {
            const b = body || {};
            const pageId = String(b.page_id || b.page || "");
            let page = findPage(pageId);
            if (page === null && pageId) {
                const cand = normalizePageId(decodeURIComponentSafe(pageId));
                if (PAGE_ID_RE.test(cand)) page = cand;
            }
            if (page === null) {
                return json(200, { success: false, applied: false, message: `Unknown page: ${pageId || "(empty)"}` });
            }
            const issueType = String(b.issue_type || "").trim();
            const fixContent = b.fix_content;
            let fields = {};
            if (issueType) {
                const field = ISSUE_FIELD_MAP[issueType];
                if (!field || fixContent === undefined || fixContent === null) {
                    return json(200, { success: false, applied: false, message: `Unsupported issue_type '${issueType}' for bridge meta store` });
                }
                fields = { [field]: cleanFixValue(field, fixContent) };
            } else {
                fields = seoFieldsFromBody(b);
                if (!Object.keys(fields).length && fixContent !== undefined && fixContent !== null) {
                    fields = { description: String(fixContent) };
                }
            }
            if (Object.keys(fields).length) store.update(page, fields);
            return json(200, { success: true, page, applied: Object.keys(fields) });
        }

        if (m === "GET" && rel === "/ai-export") {
            const pages = allPages().map((page) => {
                const rec = store.get(page) || {};
                return {
                    page,
                    url: pageUrl(page),
                    title: rec.title || page,
                    description: rec.description ?? null,
                    content_markdown: rec.content_markdown || "",
                };
            });
            return json(200, { pages, count: pages.length });
        }

        if ((m === "POST") && (rel === "/upload-file" || rel === "/publish-file")) {
            if (!staticDir) return err(503, "GEO_BRIDGE_STATIC_DIR is not configured");
            const b = body || {};
            const filename = String(b.filename || b.path || b.file_path || "").replace(/^\/+/, "");
            const content = b.content ?? b.data ?? "";
            const encoding = String(b.encoding || "utf-8");
            if (!filename || !ALLOWED_UPLOAD_NAMES.test(filename) || filename.includes("..")) {
                return err(422, "Disallowed filename");
            }
            const target = path.join(staticDir, filename);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (encoding === "base64") {
                fs.writeFileSync(target, Buffer.from(String(content), "base64"));
            } else {
                fs.writeFileSync(target, String(content), "utf8");
            }
            return json(200, { ok: true, filename, url: `${siteUrl}/${filename}` });
        }

        if (m === "POST" && rel === "/posts") {
            if (!postHandler) {
                return err(501, "Blog publishing is not configured (set GEO_BRIDGE_POST_HANDLER)");
            }
            try {
                const [mod, fn] = String(postHandler).split(":");
                const handler = require(mod)[fn];
                const result = await handler(body || {});
                return json(200, result && typeof result === "object" ? result : { ok: true, result });
            } catch (exc) {
                return err(502, `Post handler failed: ${exc && exc.message ? exc.message : exc}`);
            }
        }

        if (m === "GET" && rel === "/products") {
            const offset = Math.max(0, parseInt(query.offset, 10) || 0);
            const limit = Math.min(500, Math.max(1, parseInt(query.limit, 10) || 200));
            const all = productStore.all();
            const ids = Object.keys(all).sort();
            const slice = ids.slice(offset, offset + limit);
            const items = slice.map((pid) => ({ external_id: pid, kind: "product", ...all[pid] }));
            return json(200, {
                items,
                total: ids.length,
                has_more: offset + slice.length < ids.length,
                next_offset: offset + slice.length,
            });
        }
        if (m === "POST" && rel === "/products") {
            const items = (body || {}).items;
            if (!Array.isArray(items)) return err(422, "items must be a list");
            let upserted = 0;
            for (const item of items.slice(0, 1000)) {
                if (!item || typeof item !== "object") continue;
                const pid = String(item.id ?? item.external_id ?? "").trim();
                if (!pid) continue;
                const fields = {};
                for (const [k, v] of Object.entries(item)) {
                    if (k !== "id" && k !== "external_id") fields[k] = v;
                }
                productStore.upsert(pid, fields);
                upserted++;
            }
            return json(200, { ok: true, upserted });
        }

        const prodMatch = rel.match(/^\/products\/([^/]+)$/);
        if (prodMatch && m === "PUT") {
            const productId = decodeURIComponentSafe(prodMatch[1]);
            if (!PRODUCT_ID_RE.test(productId)) return err(422, "Invalid product_id");
            const b = body || {};
            let fields = b.fields && typeof b.fields === "object" ? { ...b.fields } : { ...b };
            delete fields.product_id;
            delete fields.external_id;
            delete fields.id;
            delete fields.url;
            const before = productStore.get(productId) || {};
            const snapshot = {};
            for (const k of ["name", "description", "short_description", "meta_title", "meta_description", "attributes"]) {
                if (k in before) snapshot[k] = before[k];
            }
            const allowName = Boolean(fields._allow_name || b._allow_name);
            const restoreName = Boolean(fields._restore_name || b._restore_name);
            delete fields._allow_name;
            delete fields._restore_name;
            const skippedFields = [];
            if ("name" in fields && before.name && !(allowName || restoreName)) {
                delete fields.name;
                skippedFields.push("name:protected");
            }
            const mediaWarnings = [];
            for (const [key, ext] of [["photo_url", "png"], ["video_url", "mp4"]]) {
                const url = String(fields[key] || "");
                if (!url) continue;
                delete fields[key];
                const local = await fetchMediaToStatic(productId, key, url, ext);
                if (local) fields["media_" + key] = local;
                else {
                    mediaWarnings.push(`${key}: download failed`);
                    skippedFields.push(`${key}: download failed`);
                }
            }
            const rec = productStore.upsert(productId, fields);
            const result = { ok: true, product_id: productId, result_data: { before: snapshot, product: rec } };
            if (mediaWarnings.length) result.result_data.warnings = mediaWarnings;
            if (skippedFields.length) result.result_data.skipped_fields = skippedFields;
            return json(200, result);
        }

        if (m === "POST" && rel === "/self-update") {
            return selfUpdate({ body: body || {}, headers, apiKey, autoRestart, packageName: "@geoengine/node" });
        }

        return err(404, "Not found");
    }

    return { handle, store, productStore, allPages, siteUrl, staticDir, apiKey };
}

module.exports = { createBridge, PREFIX, VERSION };
