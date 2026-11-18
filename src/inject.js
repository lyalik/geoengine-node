"use strict";

// HTML <head> injection of managed SEO meta — the Node equivalent of
// geoengine_bridge/spa.py inject_seo. Use as Express/NestJS middleware
// in front of SSR or static HTML responses, or call injectSeo() directly.

const { createStores } = require("./store");

const GEO_MARK = "geoengine:injected";

function escapeHtml(v) {
    return String(v)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function pageFromPath(pathname) {
    const slug = String(pathname || "").replace(/^\/+|\/+$/g, "");
    return slug || "home";
}

function metaTags(rec, siteUrl, page) {
    const tags = [];
    const desc = rec.description;
    if (desc) tags.push(`<meta name="description" content="${escapeHtml(desc)}">`);
    if (rec.keywords) tags.push(`<meta name="keywords" content="${escapeHtml(rec.keywords)}">`);
    const robots = rec.indexable === false ? "noindex, nofollow" : "index, follow";
    tags.push(`<meta name="robots" content="${robots}">`);
    if (rec.canonical_url) tags.push(`<link rel="canonical" href="${escapeHtml(rec.canonical_url)}">`);
    const ogTitle = rec.og_title || rec.title;
    const ogDesc = rec.og_description || desc;
    const ogImage = rec.og_image;
    if (ogTitle) tags.push(`<meta property="og:title" content="${escapeHtml(ogTitle)}">`);
    if (ogDesc) tags.push(`<meta property="og:description" content="${escapeHtml(ogDesc)}">`);
    if (ogImage) tags.push(`<meta property="og:image" content="${escapeHtml(ogImage)}">`);
    tags.push('<meta property="og:type" content="website">');
    if (siteUrl) {
        const url = page === "home" ? siteUrl : `${siteUrl}/${page}`;
        tags.push(`<meta property="og:url" content="${escapeHtml(url)}">`);
    }
    const twTitle = rec.twitter_title || ogTitle;
    const twDesc = rec.twitter_description || ogDesc;
    if (twTitle) tags.push(`<meta name="twitter:title" content="${escapeHtml(twTitle)}">`);
    if (twDesc) tags.push(`<meta name="twitter:description" content="${escapeHtml(twDesc)}">`);
    const twImage = rec.twitter_image || ogImage;
    if (twImage) tags.push(`<meta name="twitter:image" content="${escapeHtml(twImage)}">`);
    tags.push('<meta name="twitter:card" content="summary_large_image">');
    return tags.join("\n    ");
}

function jsonLdTags(rec) {
    const sd = rec.structured_data;
    if (!sd) return "";
    const blocks = Array.isArray(sd) ? sd : [sd];
    const out = [];
    for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        const payload = JSON.stringify(block).replace(/<\//g, "<\\/");
        out.push(`<script type="application/ld+json" data-geoengine="1">${payload}</script>`);
    }
    return out.join("\n    ");
}

const TITLE_RE = /<title[^>]*>[\s\S]*?<\/title>/i;
const TAG_RE = /<(?:meta|link)\s[^>]*>/gi;
const ATTR_KEY_RE = /(?:name|property)=["']([^"']+)["']/i;
const CANON_LINK_RE = /<link\s+rel=["']canonical["'][^>]*>/i;

function emittedKeys(tagsHtml) {
    const keys = new Set();
    for (const m of tagsHtml.matchAll(TAG_RE)) {
        const tag = m[0];
        const km = ATTR_KEY_RE.exec(tag);
        if (km) keys.add(km[1].toLowerCase());
        else if (/rel=["']canonical["']/i.test(tag)) keys.add("canonical");
    }
    return keys;
}

function stripKeys(html, keys) {
    for (const key of keys) {
        if (key === "canonical") {
            html = html.replace(CANON_LINK_RE, "");
        } else {
            const re = new RegExp(
                `<meta\\s+(?:name|property)=["']${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*>`,
                "i"
            );
            html = html.replace(re, "");
        }
    }
    return html;
}

function injectSeo(indexHtml, page, store, siteUrl) {
    const rec = store.get(page);
    if (!rec) return indexHtml;

    let out = indexHtml;
    if (rec.title) {
        const newTitle = `<title>${escapeHtml(rec.title)}</title>`;
        out = TITLE_RE.test(out)
            ? out.replace(TITLE_RE, newTitle)
            : out.replace("<head>", `<head>\n    ${newTitle}`);
    }

    const tags = metaTags(rec, siteUrl || "", page);
    out = stripKeys(out, emittedKeys(tags));

    const block =
        `    <!-- ${GEO_MARK} page=${escapeHtml(page)} -->\n` +
        `    ${tags}\n` +
        `    ${jsonLdTags(rec)}\n` +
        `    <!-- /${GEO_MARK} -->`;
    out = out.includes("</head>")
        ? out.replace("</head>", `${block}\n</head>`)
        : out + block;
    return out;
}

/**
 * Express/NestJS-style middleware: buffers text/html responses for
 * managed paths and injects stored SEO meta. Mount BEFORE your routes
 * or wrap res.send — see README for both patterns.
 */
function createSeoMiddleware(options = {}) {
    const env = options.env || process.env;
    const { seo: store } = createStores(env);
    const siteUrl = String(options.siteUrl || env.GEO_BRIDGE_SITE_URL || "").replace(/\/+$/, "");

    return function geoengineSeoMiddleware(req, res, next) {
        const originalSend = res.send;
        const originalEnd = res.end;
        let intercepted = false;

        function maybeInject(chunk, encoding, callback) {
            const contentType = String(res.getHeader("content-type") || "");
            const isHtml = contentType.includes("text/html") || /\.html?$/i.test(req.path || "");
            if (!isHtml || typeof chunk !== "string" && !Buffer.isBuffer(chunk)) {
                return false;
            }
            const html = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
            if (!html.includes("<head")) return false;
            const page = pageFromPath(req.path || "/");
            const injected = injectSeo(html, page, store, siteUrl);
            if (injected === html) return false;
            const buf = Buffer.from(injected, "utf8");
            try {
                res.setHeader("content-length", buf.length);
            } catch { /* headers may be sent */ }
            intercepted = true;
            return buf;
        }

        res.send = function (body) {
            if (!intercepted) {
                const replaced = maybeInject(body, null, null);
                if (replaced !== false) {
                    return originalSend.call(this, replaced);
                }
            }
            return originalSend.apply(this, arguments);
        };

        res.end = function (chunk, encoding, callback) {
            if (chunk && !intercepted) {
                const replaced = maybeInject(chunk, encoding, callback);
                if (replaced !== false) {
                    return originalEnd.call(this, replaced, encoding, callback);
                }
            }
            return originalEnd.apply(this, arguments);
        };

        next();
    };
}

module.exports = { injectSeo, createSeoMiddleware, pageFromPath };
