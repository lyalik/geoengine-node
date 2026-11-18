"use strict";

// JSON-file backed stores for per-page SEO overrides and the product
// catalog mirror. No DB required — small JSON files with atomic writes
// (tmp + rename). The file is re-read when its mtime changes so multiple
// processes (cluster, pm2 instances) stay consistent.

const fs = require("fs");
const path = require("path");

const SEO_FIELDS = new Set([
    "title",
    "description",
    "keywords",
    "og_title",
    "og_description",
    "og_image",
    "twitter_title",
    "twitter_description",
    "twitter_image",
    "canonical_url",
    "structured_data",
    "indexable",
    "h1",
    "content_markdown",
]);

const PRODUCT_FIELDS = new Set([
    "name",
    "description",
    "short_description",
    "meta_title",
    "meta_description",
    "attributes",
    "faq",
    "image_alt",
    "content_html",
    "sku",
    "price",
    "url",
    "image",
    "category",
    "status",
]);

class JsonStore {
    constructor(filePath, allowedFields) {
        this.filePath = filePath;
        this.allowedFields = allowedFields;
        this._cache = null;
        this._mtimeMs = -1;
    }

    _statMtime() {
        try {
            return fs.statSync(this.filePath).mtimeMs;
        } catch {
            return -1;
        }
    }

    _load() {
        const mtime = this._statMtime();
        if (this._cache !== null && mtime === this._mtimeMs) {
            return this._cache;
        }
        let data = {};
        if (mtime !== -1) {
            try {
                const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
                if (raw && typeof raw === "object" && !Array.isArray(raw)) {
                    data = raw;
                }
            } catch {
                data = {};
            }
        }
        this._cache = data;
        this._mtimeMs = mtime;
        return data;
    }

    _save() {
        const dir = path.dirname(path.resolve(this.filePath));
        fs.mkdirSync(dir, { recursive: true });
        const tmp = path.join(dir, `.geo-tmp-${process.pid}-${Date.now()}.json`);
        fs.writeFileSync(tmp, JSON.stringify(this._cache, null, 2), "utf8");
        fs.renameSync(tmp, this.filePath);
        this._mtimeMs = this._statMtime();
    }

    get(id) {
        const rec = this._load()[id];
        return rec && typeof rec === "object" ? rec : null;
    }

    all() {
        return { ...this._load() };
    }

    update(id, fields) {
        const data = this._load();
        const rec = data[id] || {};
        for (const [key, value] of Object.entries(fields || {})) {
            if (this.allowedFields.has(key) && value !== null && value !== undefined) {
                rec[key] = value;
            }
        }
        rec.updated_at = new Date().toISOString();
        data[id] = rec;
        this._save();
        return { ...rec };
    }

    upsert(id, fields) {
        return this.update(id, fields);
    }

    delete(id) {
        const data = this._load();
        const existed = id in data;
        delete data[id];
        this._save();
        return existed;
    }
}

function defaultStorePath(envName, fallback) {
    return process.env[envName] || fallback;
}

function createStores(env = process.env) {
    const seo = new JsonStore(
        env.GEO_BRIDGE_STORE || "./geo_bridge_store.json",
        SEO_FIELDS
    );
    const products = new JsonStore(
        env.GEO_BRIDGE_PRODUCTS_STORE || "./geo_bridge_products.json",
        PRODUCT_FIELDS
    );
    return { seo, products };
}

module.exports = { JsonStore, SEO_FIELDS, PRODUCT_FIELDS, createStores };
