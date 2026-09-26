(() => {
  const MAX_INVENTORY_VERSION = 20;
  const MAX_EXTERNAL_VERSION = 10;
  const EXT_SOURCE = "horizon-pool-images";
  const BRIDGE_SOURCE = "horizon-pool-images-bridge";
  const DEBUG = true;

  function log(...args) {
    if (DEBUG) console.log("[HorizonPoolImages]", ...args);
  }

  function hostKey() {
    return location.host;
  }

  async function getCachedVersions() {
    try {
      const key = `versions:${hostKey()}`;
      const result = await chrome.storage.session.get(key);
      return result[key] || null;
    } catch (_) {
      return null;
    }
  }

  async function setCachedVersions(versions) {
    try {
      const key = `versions:${hostKey()}`;
      await chrome.storage.session.set({ [key]: versions });
    } catch (_) {
      /* ignore */
    }
  }

  function asArray(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.content)) return data.content;
    if (Array.isArray(data?.items)) return data.items;
    if (Array.isArray(data?.value)) return data.value;
    return [];
  }

  function pick(obj, ...keys) {
    if (!obj || typeof obj !== "object") return undefined;
    for (const key of keys) {
      if (obj[key] != null && obj[key] !== "") return obj[key];
    }
    return undefined;
  }

  class HorizonApi {
    constructor() {
      this.authorization = null;
      this.inventoryVersion = null;
      this.externalVersion = null;
      this.poolById = new Map();
      this.poolByName = new Map();
      this.vmNameCache = new Map();
      this.snapshotNameCache = new Map();
      this._vmFetchInflight = new Map();
      this._snapFetchInflight = new Map();
      this._probePromise = null;
      this._pending = new Map();
      this._reqSeq = 0;
      this._bridgeReady = false;

      window.addEventListener("message", (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== BRIDGE_SOURCE) return;

        if (msg.type === "ready") {
          this._bridgeReady = true;
        }

        if (msg.type === "auth" && msg.payload?.authorization) {
          this.setAuthorization(msg.payload.authorization);
        }

        if (msg.type === "api-response" && msg.payload?.id != null) {
          const pending = this._pending.get(msg.payload.id);
          if (pending) {
            this._pending.delete(msg.payload.id);
            pending.resolve(msg.payload);
          }
        }
      });
    }

    setAuthorization(authorization) {
      if (!authorization) return;
      this.authorization = authorization;
    }

    bridgeRequest(path, options = {}) {
      const id = `r${Date.now()}-${++this._reqSeq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(id);
          reject(new Error(`API bridge timeout for ${path}`));
        }, 30000);

        this._pending.set(id, {
          resolve: (payload) => {
            clearTimeout(timer);
            resolve(payload);
          },
        });

        window.postMessage(
          {
            source: EXT_SOURCE,
            type: "api-request",
            payload: {
              id,
              path,
              method: options.method || "GET",
              headers: {
                ...(this.authorization ? { Authorization: this.authorization } : {}),
                ...(options.headers || {}),
              },
              body: options.body,
            },
          },
          "*"
        );
      });
    }

    async request(path, options = {}) {
      if (!this.authorization) {
        throw new Error("No Authorization token captured yet");
      }
      const result = await this.bridgeRequest(path, options);
      return {
        ok: Boolean(result.ok),
        status: result.status || 0,
        data: result.data,
        async json() {
          return result.data;
        },
      };
    }

    async probeVersions() {
      if (this.inventoryVersion) {
        return {
          inventoryVersion: this.inventoryVersion,
          externalVersion: this.externalVersion,
        };
      }
      if (this._probePromise) return this._probePromise;

      this._probePromise = (async () => {
        const cached = await getCachedVersions();
        if (cached?.inventoryVersion) {
          if (await this._checkInventory(cached.inventoryVersion)) {
            this.inventoryVersion = cached.inventoryVersion;
            this.externalVersion =
              cached.externalVersion || (await this._probeExternal());
            return {
              inventoryVersion: this.inventoryVersion,
              externalVersion: this.externalVersion,
            };
          }
        }

        for (let v = MAX_INVENTORY_VERSION; v >= 1; v -= 1) {
          if (await this._checkInventory(v)) {
            this.inventoryVersion = v;
            break;
          }
        }
        if (!this.inventoryVersion) {
          throw new Error("Could not find working desktop-pools API version");
        }

        this.externalVersion = await this._probeExternal();
        await setCachedVersions({
          inventoryVersion: this.inventoryVersion,
          externalVersion: this.externalVersion,
        });
        log("API versions", this.inventoryVersion, this.externalVersion);
        return {
          inventoryVersion: this.inventoryVersion,
          externalVersion: this.externalVersion,
        };
      })();

      try {
        return await this._probePromise;
      } finally {
        this._probePromise = null;
      }
    }

    async _checkInventory(version) {
      try {
        const res = await this.request(
          `/rest/inventory/v${version}/desktop-pools?page=1&size=1`
        );
        if (res.status === 404) return false;
        return res.ok || res.status === 400 || res.status === 401 || res.status === 403;
      } catch (_) {
        return false;
      }
    }

    async _probeExternal() {
      for (let v = MAX_EXTERNAL_VERSION; v >= 1; v -= 1) {
        try {
          const res = await this.request(`/rest/external/v${v}/base-vms`);
          if (res.status === 404) continue;
          if (res.ok || res.status === 400 || res.status === 401 || res.status === 403) {
            return v;
          }
        } catch (_) {
          /* continue */
        }
      }
      return 1;
    }

    ingestPoolsPayload(data) {
      const pools = asArray(data);
      for (const pool of pools) this._indexPool(pool);
      log("Ingested pools", pools.length, "total indexed", this.poolById.size);
      return pools;
    }

    _indexPool(pool) {
      if (!pool || typeof pool !== "object") return;
      const id = pick(pool, "id", "Id");
      const name = pick(pool, "name", "Name");
      const displayName = pick(pool, "display_name", "displayName", "DisplayName");
      if (id) this.poolById.set(String(id), pool);
      if (name) this.poolByName.set(String(name).toLowerCase(), pool);
      if (displayName) this.poolByName.set(String(displayName).toLowerCase(), pool);
    }

    hasProvisioningInfo(pool) {
      if (!pool) return false;
      const settings =
        pool.provisioning_settings ||
        pool.provisioningSettings ||
        pool.AutomatedDesktopData?.VirtualCenterNamesData ||
        null;
      if (!settings && (pool.parent_vm_path || pool.parentVmPath || pool.snapshot_path || pool.snapshotPath)) {
        return true;
      }
      if (!settings) return false;
      return Boolean(
        pick(
          settings,
          "parent_vm_id",
          "parentVmId",
          "base_snapshot_id",
          "baseSnapshotId",
          "parent_vm_path",
          "parentVmPath",
          "snapshot_path",
          "snapshotPath",
          "template_path",
          "templatePath",
          "im_stream_id",
          "imStreamId",
          "vm_template_id",
          "vmTemplateId"
        )
      );
    }

    async listAllPools() {
      await this.probeVersions();
      const base = `/rest/inventory/v${this.inventoryVersion}/desktop-pools`;
      const all = [];
      let page = 1;
      const size = 100;

      while (page < 100) {
        const res = await this.request(`${base}?page=${page}&size=${size}`);
        if (!res.ok) {
          if (page === 1) {
            const fallback = await this.request(base);
            if (!fallback.ok) {
              throw new Error(`Failed to list desktop pools: HTTP ${fallback.status}`);
            }
            return this.ingestPoolsPayload(fallback.data);
          }
          break;
        }
        const batch = this.ingestPoolsPayload(res.data);
        all.push(...batch);
        if (batch.length < size) break;
        page += 1;
      }

      // Enrich pools that lack image fields (common on summary list responses)
      await this.enrichMissingDetails(all);
      return all;
    }

    async enrichMissingDetails(pools) {
      const need = pools.filter((p) => !this.hasProvisioningInfo(p) && pick(p, "id", "Id"));
      const limit = 8;
      for (let i = 0; i < need.length; i += limit) {
        const chunk = need.slice(i, i + limit);
        await Promise.all(
          chunk.map(async (pool) => {
            const id = pick(pool, "id", "Id");
            try {
              const res = await this.request(
                `/rest/inventory/v${this.inventoryVersion}/desktop-pools/${encodeURIComponent(id)}`
              );
              if (res.ok && res.data && typeof res.data === "object") {
                this._indexPool(res.data);
              }
            } catch (err) {
              log("detail fetch failed", id, err);
            }
          })
        );
      }
    }

    findPool(rowKey) {
      if (!rowKey) return null;
      const key = String(rowKey).trim();
      if (this.poolById.has(key)) return this.poolById.get(key);
      const lower = key.toLowerCase();
      if (this.poolByName.has(lower)) return this.poolByName.get(lower);
      for (const [name, pool] of this.poolByName.entries()) {
        if (name === lower || name.includes(lower) || lower.includes(name)) {
          return pool;
        }
      }
      return null;
    }

    pathLeaf(value) {
      if (!value) return null;
      const text = String(value);
      const parts = text.split(/[/\\]/).filter(Boolean);
      return parts[parts.length - 1] || text;
    }

    async resolveVmName(vcenterId, vmId, datacenterId) {
      if (!vmId) return null;
      if (String(vmId).includes("/")) return this.pathLeaf(vmId);

      const cacheKey = `${vcenterId || ""}:${vmId}`;
      if (this.vmNameCache.has(cacheKey)) return this.vmNameCache.get(cacheKey);

      const fetchKey = `${vcenterId || ""}:${datacenterId || ""}`;
      if (!this._vmFetchInflight.has(fetchKey)) {
        const promise = (async () => {
          await this.probeVersions();
          const params = new URLSearchParams();
          if (vcenterId) params.set("vcenter_id", vcenterId);
          if (datacenterId) params.set("datacenter_id", datacenterId);
          params.set("filter_incompatible_vms", "false");
          try {
            const res = await this.request(
              `/rest/external/v${this.externalVersion}/base-vms?${params}`
            );
            if (res.ok) {
              for (const vm of asArray(res.data)) {
                const id = String(pick(vm, "id", "Id") || "");
                const name =
                  pick(vm, "name", "Name") || this.pathLeaf(pick(vm, "path", "Path")) || id;
                this.vmNameCache.set(`${vcenterId || ""}:${id}`, name);
              }
            }
          } catch (err) {
            log("base-vms resolve failed", err);
          }
        })().finally(() => this._vmFetchInflight.delete(fetchKey));
        this._vmFetchInflight.set(fetchKey, promise);
      }
      await this._vmFetchInflight.get(fetchKey);

      if (!this.vmNameCache.has(cacheKey)) this.vmNameCache.set(cacheKey, vmId);
      return this.vmNameCache.get(cacheKey);
    }

    async resolveSnapshotName(vcenterId, baseVmId, snapshotId) {
      if (!snapshotId) return null;
      if (String(snapshotId).includes("/")) return this.pathLeaf(snapshotId);

      const cacheKey = `${vcenterId || ""}:${baseVmId || ""}:${snapshotId}`;
      if (this.snapshotNameCache.has(cacheKey)) return this.snapshotNameCache.get(cacheKey);

      await this.probeVersions();
      if (!baseVmId || !vcenterId || String(baseVmId).includes("/")) {
        this.snapshotNameCache.set(cacheKey, snapshotId);
        return snapshotId;
      }

      const fetchKey = `${vcenterId}:${baseVmId}`;
      if (!this._snapFetchInflight.has(fetchKey)) {
        const promise = (async () => {
          try {
            const params = new URLSearchParams({
              vcenter_id: vcenterId,
              base_vm_id: baseVmId,
            });
            const res = await this.request(
              `/rest/external/v${this.externalVersion}/base-snapshots?${params}`
            );
            if (res.ok) {
              for (const snap of asArray(res.data)) {
                const id = String(pick(snap, "id", "Id") || "");
                const name =
                  pick(snap, "name", "Name") ||
                  this.pathLeaf(pick(snap, "path", "Path")) ||
                  id;
                this.snapshotNameCache.set(`${vcenterId}:${baseVmId}:${id}`, name);
              }
            }
          } catch (err) {
            log("base-snapshots resolve failed", err);
          }
        })().finally(() => this._snapFetchInflight.delete(fetchKey));
        this._snapFetchInflight.set(fetchKey, promise);
      }
      await this._snapFetchInflight.get(fetchKey);

      if (!this.snapshotNameCache.has(cacheKey)) {
        this.snapshotNameCache.set(cacheKey, snapshotId);
      }
      return this.snapshotNameCache.get(cacheKey);
    }

    extractImageHints(pool) {
      const settings =
        pool.provisioning_settings ||
        pool.provisioningSettings ||
        {};
      const vcNames =
        pool.AutomatedDesktopData?.VirtualCenterNamesData ||
        pool.automatedDesktopData?.virtualCenterNamesData ||
        {};

      const parentVmId = pick(
        settings,
        "parent_vm_id",
        "parentVmId",
        "parent_vm",
        "parentVm"
      );
      const snapshotId = pick(
        settings,
        "base_snapshot_id",
        "baseSnapshotId",
        "snapshot_id",
        "snapshotId"
      );
      // Paths live under provisioning_settings in modern Horizon REST responses
      const parentPath =
        pick(settings, "parent_vm_path", "parentVmPath", "parent_vm_name", "parentVmName") ||
        pick(pool, "parent_vm_path", "parentVmPath", "parent_vm_name", "parentVmName") ||
        pick(vcNames, "parentVmPath", "ParentVmPath", "parent_vm_path");
      const snapshotPath =
        pick(settings, "snapshot_path", "snapshotPath", "snapshot_name", "snapshotName") ||
        pick(pool, "snapshot_path", "snapshotPath", "snapshot_name", "snapshotName") ||
        pick(vcNames, "snapshotPath", "SnapshotPath", "snapshot_path");
      const templatePath =
        pick(settings, "template_path", "templatePath") ||
        pick(pool, "template_path", "templatePath");

      return {
        parentVmId,
        snapshotId,
        parentPath,
        snapshotPath,
        templatePath,
        imStreamId: pick(settings, "im_stream_id", "imStreamId"),
        imTagId: pick(settings, "im_tag_id", "imTagId"),
        vmTemplateId: pick(settings, "vm_template_id", "vmTemplateId"),
        vcenterId: pick(pool, "vcenter_id", "vcenterId"),
        datacenterId: pick(settings, "datacenter_id", "datacenterId"),
        source: String(pick(pool, "source", "Source") || "").toUpperCase(),
        type: String(pick(pool, "type", "Type") || "").toUpperCase(),
      };
    }

    fieldsFromHints(hints) {
      const empty = {
        masterImage: "—",
        snapshot: "—",
        masterImagePath: null,
        snapshotPath: null,
      };
      if (!hints) return empty;

      const isInstant =
        hints.source === "INSTANT_CLONE" ||
        String(hints.source || "").includes("INSTANT") ||
        Boolean(hints.parentVmId || hints.snapshotId || hints.parentPath);

      if (hints.type && hints.type !== "AUTOMATED" && !isInstant) {
        return empty;
      }

      if (hints.parentPath || hints.snapshotPath) {
        return {
          masterImage: this.pathLeaf(hints.parentPath) || hints.parentPath || "—",
          snapshot: this.pathLeaf(hints.snapshotPath) || hints.snapshotPath || "—",
          masterImagePath: hints.parentPath || null,
          snapshotPath: hints.snapshotPath || null,
        };
      }

      if (hints.templatePath) {
        return {
          masterImage: this.pathLeaf(hints.templatePath) || hints.templatePath,
          snapshot: "—",
          masterImagePath: hints.templatePath,
          snapshotPath: null,
        };
      }

      return null;
    }

    /** Sync path-based fields for CSV export (no network). */
    getDisplayFieldsSync(pool) {
      const empty = {
        masterImage: "—",
        snapshot: "—",
        masterImagePath: null,
        snapshotPath: null,
      };
      if (!pool) return empty;
      const fromPaths = this.fieldsFromHints(this.extractImageHints(pool));
      if (fromPaths) return fromPaths;

      const hints = this.extractImageHints(pool);
      if (hints.imStreamId || hints.imTagId) {
        return {
          masterImage: hints.imStreamId || "—",
          snapshot: hints.imTagId || "—",
          masterImagePath: null,
          snapshotPath: null,
        };
      }
      if (hints.parentVmId || hints.snapshotId) {
        return {
          masterImage: hints.parentVmId || "—",
          snapshot: hints.snapshotId || "—",
          masterImagePath: null,
          snapshotPath: null,
        };
      }
      if (hints.vmTemplateId) {
        return {
          masterImage: hints.vmTemplateId,
          snapshot: "—",
          masterImagePath: null,
          snapshotPath: null,
        };
      }
      return empty;
    }

    buildCsvEnrichmentMap() {
      const map = {};
      for (const pool of this.poolById.values()) {
        const fields = this.getDisplayFieldsSync(pool);
        const entry = {
          masterImage: fields.masterImage || "—",
          snapshot: fields.snapshot || "—",
        };
        const keys = [
          pick(pool, "name", "Name"),
          pick(pool, "display_name", "displayName", "DisplayName"),
          pick(pool, "id", "Id"),
        ];
        for (const key of keys) {
          if (!key) continue;
          map[String(key)] = entry;
          map[String(key).toLowerCase()] = entry;
        }
      }
      return map;
    }

    async getDisplayFields(pool) {
      const empty = {
        masterImage: "—",
        snapshot: "—",
        masterImagePath: null,
        snapshotPath: null,
      };
      if (!pool) return empty;

      let current = pool;
      if (!this.hasProvisioningInfo(current)) {
        const id = pick(current, "id", "Id");
        if (id && this.inventoryVersion) {
          try {
            const res = await this.request(
              `/rest/inventory/v${this.inventoryVersion}/desktop-pools/${encodeURIComponent(id)}`
            );
            if (res.ok && res.data) {
              this._indexPool(res.data);
              current = res.data;
            }
          } catch (_) {
            /* keep summary */
          }
        }
      }

      const hints = this.extractImageHints(current);
      const fromPaths = this.fieldsFromHints(hints);
      if (fromPaths) return fromPaths;

      if (hints.parentVmId || hints.snapshotId) {
        const masterImage = await this.resolveVmName(
          hints.vcenterId,
          hints.parentVmId,
          hints.datacenterId
        );
        const snapshot = await this.resolveSnapshotName(
          hints.vcenterId,
          hints.parentVmId,
          hints.snapshotId
        );
        return {
          masterImage: masterImage || hints.parentVmId || "—",
          snapshot: snapshot || hints.snapshotId || "—",
          masterImagePath: null,
          snapshotPath: null,
        };
      }

      if (hints.imStreamId || hints.imTagId) {
        return {
          masterImage: hints.imStreamId || "—",
          snapshot: hints.imTagId || "—",
          masterImagePath: null,
          snapshotPath: null,
        };
      }

      if (hints.vmTemplateId) {
        const name = await this.resolveVmName(
          hints.vcenterId,
          hints.vmTemplateId,
          hints.datacenterId
        );
        return {
          masterImage: name || hints.vmTemplateId,
          snapshot: "—",
          masterImagePath: null,
          snapshotPath: null,
        };
      }

      return empty;
    }
  }

  window.HorizonPoolImagesApi = HorizonApi;
})();
