(() => {
  const SOURCE = "horizon-pool-images-bridge";
  const api = new window.HorizonPoolImagesApi();
  const displayCache = new Map();
  let refreshTimer = null;
  let loadingPools = false;
  let loadedOnce = false;

  function debug(...args) {
    console.log("[HorizonPoolImages]", ...args);
  }

  async function ensurePoolsLoaded(force = false) {
    if (!api.authorization) {
      debug("Waiting for admin session token…");
      return;
    }
    if (loadingPools) return;
    if (!force && loadedOnce && api.poolById.size > 0) return;

    loadingPools = true;
    try {
      await api.listAllPools();
      loadedOnce = true;
      debug("Loaded pools", api.poolById.size);
      displayCache.clear();
      publishCsvMap();
      grid.schedule();
    } catch (err) {
      debug("listAllPools failed", err);
    } finally {
      loadingPools = false;
    }
  }

  async function resolveRow(rowKey) {
    if (displayCache.has(rowKey)) return displayCache.get(rowKey);

    let pool = api.findPool(rowKey);
    if (!pool && api.authorization) {
      await ensurePoolsLoaded(false);
      pool = api.findPool(rowKey);
    }
    if (!pool) {
      return {
        masterImage: "—",
        snapshot: "—",
        masterImagePath: null,
        snapshotPath: null,
      };
    }

    const fields = await api.getDisplayFields(pool);
    displayCache.set(rowKey, fields);
    const name = pool.name || pool.Name;
    const displayName = pool.display_name || pool.displayName;
    const id = pool.id || pool.Id;
    if (name) displayCache.set(String(name), fields);
    if (displayName) displayCache.set(String(displayName), fields);
    if (id) displayCache.set(String(id), fields);
    return fields;
  }

  function publishCsvMap() {
    const map = api.buildCsvEnrichmentMap();
    window.postMessage(
      { source: "horizon-pool-images", type: "csv-map", payload: { map } },
      "*"
    );
  }

  const grid = new window.HorizonPoolImagesGrid.GridInjector({
    resolveRow,
  });

  function scheduleRefresh(force = true) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      displayCache.clear();
      ensurePoolsLoaded(force).then(() => grid.schedule());
    }, 300);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== SOURCE) return;

    if (msg.type === "auth" && msg.payload?.authorization) {
      const prev = api.authorization;
      api.setAuthorization(msg.payload.authorization);
      if (prev !== api.authorization) {
        debug("Captured admin Bearer token");
        scheduleRefresh(true);
      }
    }

    if (msg.type === "pools-response" && msg.payload?.data) {
      api.ingestPoolsPayload(msg.payload.data);
      publishCsvMap();
      // Summary payloads often omit image fields — force full load/enrichment
      scheduleRefresh(true);
    }

    if (msg.type === "csv-map-request") {
      publishCsvMap();
    }

    if (msg.type === "ready") {
      debug("Page bridge ready (using logged-in admin session)");
      publishCsvMap();
    }
  });

  window.addEventListener("hashchange", () => scheduleRefresh(false));
  window.addEventListener("popstate", () => scheduleRefresh(false));

  function boot() {
    grid.start();
    // Ask MAIN bridge to re-send token (avoids race at document_start)
    window.postMessage({ source: "horizon-pool-images", type: "ping" }, "*");
    if (api.authorization) ensurePoolsLoaded(true);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();
