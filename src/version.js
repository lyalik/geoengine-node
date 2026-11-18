"use strict";

// Single source of truth for the bridge package version.
// Reported by /health and /recon, compared server-side when GEO Engine
// decides whether to push a self-update.
const VERSION = "1.0.1";

module.exports = { VERSION };
