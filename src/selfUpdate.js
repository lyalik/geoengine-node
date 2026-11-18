"use strict";

// Self-update: download the bridge package zip from GEO Engine, verify
// sha256 (payload or X-GeoEngine-Sha256 header — server is authoritative
// for what it just served), extract, copy over the installed package
// directory with per-file backup + rollback on failure.
//
// Works for vendored installs (package unpacked into the project) and
// for npm installs where node_modules is writable. For read-only
// node_modules prefer `npm install @geoengine/node@latest` + restart.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { VERSION } = require("./version");

function verTuple(v) {
    return String(v || "0")
        .split(/[.\-+]/)
        .map((c) => {
            const m = /\d+/.exec(c);
            return m ? parseInt(m[0], 10) : 0;
        });
}

function verGte(a, b) {
    const ta = verTuple(a);
    const tb = verTuple(b);
    const len = Math.max(ta.length, tb.length);
    for (let i = 0; i < len; i++) {
        const d = (ta[i] || 0) - (tb[i] || 0);
        if (d !== 0) return d > 0;
    }
    return true;
}

function copyTreeOver(srcDir, dstDir) {
    // Returns { written, backupDir }. Throws after restoring on failure.
    const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), "geoengine-node-backup-"));
    const backups = new Map();
    const created = [];
    let written = 0;
    try {
        const stack = [srcDir];
        while (stack.length) {
            const root = stack.pop();
            for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
                const s = path.join(root, entry.name);
                const rel = path.relative(srcDir, s);
                const d = path.join(dstDir, rel);
                if (entry.isDirectory()) {
                    stack.push(s);
                    continue;
                }
                if (fs.existsSync(d)) {
                    const bak = path.join(backupDir, rel);
                    fs.mkdirSync(path.dirname(bak), { recursive: true });
                    fs.copyFileSync(d, bak);
                    backups.set(d, bak);
                } else {
                    created.push(d);
                }
                fs.mkdirSync(path.dirname(d), { recursive: true });
                fs.copyFileSync(s, d);
                written++;
            }
        }
    } catch (exc) {
        for (const [d, bak] of backups) {
            try { fs.copyFileSync(bak, d); } catch { /* best effort */ }
        }
        for (const f of created) {
            try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch { /* best effort */ }
        }
        fs.rmSync(backupDir, { recursive: true, force: true });
        throw exc;
    }
    return { written, backupDir };
}

async function downloadPackage(url, apiKey, dest) {
    const resp = await fetch(url, {
        headers: { "x-api-key": apiKey || "" },
        signal: AbortSignal.timeout(120000),
    });
    if (!resp.ok) {
        throw new Error(`Package download failed: HTTP ${resp.status}`);
    }
    const servedSha = resp.headers.get("x-geoengine-sha256") || "";
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(dest, buf);
    return servedSha;
}

async function selfUpdate({ body, headers, apiKey, autoRestart, packageName }) {
    const target = String(body.target_version || "");
    const sha256 = String(body.sha256 || "").toLowerCase();
    const apiUrl = (process.env.GEO_ENGINE_API_URL || "").replace(/\/+$/, "");
    const packageUrl = String(
        body.package_url ||
        process.env.GEO_ENGINE_PACKAGE_URL ||
        (apiUrl ? `${apiUrl}/api/v1/cms/agent/package?cms_type=nodejs` : "")
    );
    if (!packageUrl) {
        return { status: 422, body: { detail: "No package_url and GEO_ENGINE_API_URL unset" } };
    }
    if (target && verGte(VERSION, target)) {
        return { status: 200, body: { ok: true, already_up_to_date: true, version: VERSION } };
    }

    const tmpZip = path.join(os.tmpdir(), `geoengine-update-${process.pid}-${Date.now()}.zip`);
    let servedSha = "";
    try {
        servedSha = await downloadPackage(packageUrl, apiKey, tmpZip);
    } catch (exc) {
        return { status: 502, body: { detail: `Package download failed: ${exc.message}` } };
    }

    const check = (servedSha || sha256 || "").toLowerCase();
    if (check) {
        const digest = crypto.createHash("sha256").update(fs.readFileSync(tmpZip)).digest("hex");
        if (digest !== check) {
            fs.unlinkSync(tmpZip);
            return { status: 422, body: { detail: "Package checksum mismatch (download corrupt)" } };
        }
    }

    // Locate package root inside the archive: prefer a dir named after
    // the package, else the first directory containing package.json.
    let AdmZip;
    try {
        AdmZip = require("adm-zip");
    } catch {
        fs.unlinkSync(tmpZip);
        return { status: 503, body: { detail: "adm-zip is required for self-update (npm i adm-zip)" } };
    }
    const zip = new AdmZip(tmpZip);
    const entries = zip.getEntries();
    const pkgJsonEntry = entries.find((e) => /(^|\/)package\.json$/.test(e.entryName) && !e.isDirectory);
    if (!pkgJsonEntry) {
        fs.unlinkSync(tmpZip);
        return { status: 422, body: { detail: "Package layout mismatch (package.json missing)" } };
    }
    const pkgRootInZip = pkgJsonEntry.entryName.slice(0, pkgJsonEntry.entryName.length - "package.json".length);

    const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "geoengine-node-update-"));
    zip.extractAllTo(extractDir, true);
    fs.unlinkSync(tmpZip);

    const srcRoot = path.join(extractDir, pkgRootInZip);
    if (!fs.existsSync(srcRoot) || !fs.statSync(srcRoot).isDirectory()) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        return { status: 422, body: { detail: "Package layout mismatch" } };
    }

    // Install dir = parent of src/ (package root containing package.json).
    const pkgDir = path.resolve(__dirname, "..");
    try {
        const { written, backupDir } = copyTreeOver(srcRoot, pkgDir);
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.rmSync(backupDir, { recursive: true, force: true });

        let newVersion = VERSION;
        try {
            const pj = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
            if (pj.version) newVersion = pj.version;
        } catch { /* keep VERSION */ }

        const result = {
            ok: true,
            version: newVersion,
            files_written: written,
            requires_restart: true,
        };
        if (autoRestart) {
            result.restarting = true;
            // Respond first, then exit — supervisor restarts on new code.
            setImmediate(() => process.exit(0));
        }
        return { status: 200, body: result };
    } catch (exc) {
        fs.rmSync(extractDir, { recursive: true, force: true });
        return { status: 500, body: { detail: `Update rolled back: ${exc.message}` } };
    }
}

module.exports = { selfUpdate };
