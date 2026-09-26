(() => {
  if (window.__horizonPoolImagesBridgeInstalled) return;
  window.__horizonPoolImagesBridgeInstalled = true;

  const SOURCE = "horizon-pool-images-bridge";
  const EXT_SOURCE = "horizon-pool-images";
  let lastAuthorization = null;
  let csvEnrichmentMap = {};
  let suppressCsvIntercept = false;
  const blobByUrl = new Map();
  const originalFetch = window.fetch.bind(window);
  const originalCreateObjectURL = URL.createObjectURL.bind(URL);
  const originalRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  const originalAnchorClick = HTMLAnchorElement.prototype.click;

  function post(type, payload) {
    window.postMessage({ source: SOURCE, type, payload }, "*");
  }

  function normalizeHeader(text) {
    return String(text || "")
      .replace(/^\uFEFF/, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function parseCsvLine(line) {
    const result = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') {
            cur += '"';
            i += 1;
          } else {
            inQuotes = false;
          }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        result.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    result.push(cur);
    return result;
  }

  function escapeCsv(value) {
    const s = String(value ?? "");
    if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  function looksLikePoolsCsv(text) {
    const first = String(text || "").split(/\r?\n/, 1)[0] || "";
    const headers = parseCsvLine(first).map(normalizeHeader);
    return headers.includes("id") && headers.includes("display name");
  }

  function enrichPoolsCsv(text, map) {
    const normalized = String(text || "").replace(/^\uFEFF/, "");
    const lines = normalized.split(/\r?\n/);
    if (!lines.length) return text;

    const headers = parseCsvLine(lines[0]);
    const normHeaders = headers.map(normalizeHeader);
    if (normHeaders.includes("master image") && normHeaders.includes("snapshot")) {
      return text;
    }

    const idIdx = normHeaders.indexOf("id");
    const displayIdx = normHeaders.indexOf("display name");
    if (idIdx < 0 || displayIdx < 0) return text;

    const insertAt = displayIdx + 1;
    headers.splice(insertAt, 0, "Master Image", "Snapshot");

    const out = [headers.map(escapeCsv).join(",")];
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (!line.trim()) {
        out.push(line);
        continue;
      }
      const cols = parseCsvLine(line);
      while (cols.length < headers.length - 2) cols.push("");
      const poolKey = cols[idIdx] || "";
      const fields =
        map[poolKey] ||
        map[String(poolKey).toLowerCase()] ||
        {};
      cols.splice(
        insertAt,
        0,
        fields.masterImage || "—",
        fields.snapshot || "—"
      );
      out.push(cols.map(escapeCsv).join(","));
    }

    const endsWithNewline = /\r?\n$/.test(normalized);
    return out.join("\n") + (endsWithNewline ? "\n" : "");
  }

  function requestCsvMap() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(csvEnrichmentMap), 1500);
      const onMsg = (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.source !== EXT_SOURCE || msg.type !== "csv-map") return;
        if (msg.payload?.map && typeof msg.payload.map === "object") {
          csvEnrichmentMap = msg.payload.map;
        }
        clearTimeout(timer);
        window.removeEventListener("message", onMsg);
        resolve(csvEnrichmentMap);
      };
      window.addEventListener("message", onMsg);
      post("csv-map-request", {});
    });
  }

  function isZipPk(bytes) {
    return bytes && bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b;
  }

  function enrichPoolsXlsx(arrayBuffer, map) {
    const XLSX = window.XLSX;
    if (!XLSX?.read || !XLSX?.write) {
      console.warn("[HorizonPoolImages] SheetJS (XLSX) not loaded");
      return null;
    }

    const wb = XLSX.read(arrayBuffer, { type: "array" });
    const sheetName = wb.SheetNames?.[0];
    if (!sheetName) return null;
    const sheet = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false,
      defval: "",
    });
    if (!rows.length) return null;

    const headers = (rows[0] || []).map((h) => String(h ?? ""));
    const normHeaders = headers.map(normalizeHeader);
    if (normHeaders.includes("master image") && normHeaders.includes("snapshot")) {
      return null;
    }

    const idIdx = normHeaders.indexOf("id");
    const displayIdx = normHeaders.indexOf("display name");
    if (idIdx < 0 || displayIdx < 0) {
      console.warn("[HorizonPoolImages] Excel export missing ID/Display Name columns", headers);
      return null;
    }

    const insertAt = displayIdx + 1;
    headers.splice(insertAt, 0, "Master Image", "Snapshot");
    rows[0] = headers;

    for (let i = 1; i < rows.length; i += 1) {
      const row = Array.isArray(rows[i]) ? rows[i] : [];
      while (row.length < headers.length - 2) row.push("");
      const poolKey = row[idIdx] || "";
      const fields =
        map[poolKey] ||
        map[String(poolKey).toLowerCase()] ||
        {};
      row.splice(
        insertAt,
        0,
        fields.masterImage || "—",
        fields.snapshot || "—"
      );
      rows[i] = row;
    }

    wb.Sheets[sheetName] = XLSX.utils.aoa_to_sheet(rows);
    const out = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    console.log("[HorizonPoolImages] Enriched Excel export with Master Image / Snapshot");
    return new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  async function maybeEnrichDownloadBlob(blob, fileName) {
    if (!(blob instanceof Blob)) return null;
    const name = String(fileName || "");
    const type = String(blob.type || "").toLowerCase();

    let buffer;
    try {
      buffer = await blob.arrayBuffer();
    } catch (_) {
      return null;
    }
    const head = new Uint8Array(buffer.slice(0, 4));
    const map = Object.keys(csvEnrichmentMap).length
      ? csvEnrichmentMap
      : await requestCsvMap();

    // Horizon Console exports Desktop Pools as ExcelReport.xlsx
    if (/\.xlsx$/i.test(name) || isZipPk(head)) {
      try {
        return enrichPoolsXlsx(buffer, map || {});
      } catch (err) {
        console.warn("[HorizonPoolImages] Excel enrich failed", err);
        return null;
      }
    }

    const looksCsv =
      type.includes("csv") ||
      type.includes("text/plain") ||
      /\.csv$/i.test(name) ||
      !type;
    if (!looksCsv) return null;

    let text;
    try {
      text = new TextDecoder("utf-8").decode(buffer);
    } catch (_) {
      return null;
    }
    if (!looksLikePoolsCsv(text)) return null;

    const enriched = enrichPoolsCsv(text, map || {});
    if (enriched === text) return null;
    return new Blob([enriched], {
      type: type.includes("csv") ? blob.type : "text/csv;charset=utf-8",
    });
  }

  function triggerAnchorDownload(anchor) {
    suppressCsvIntercept = true;
    try {
      originalAnchorClick.call(anchor);
    } finally {
      suppressCsvIntercept = false;
    }
  }

  async function downloadEnrichedAnchor(anchor) {
    const href = anchor.href || "";
    const fileName =
      anchor.getAttribute("download") || anchor.download || "download.csv";

    // data:text/csv,... downloads
    if (/^data:text\/(csv|plain)/i.test(href)) {
      try {
        const comma = href.indexOf(",");
        if (comma > 0) {
          const meta = href.slice(0, comma);
          let body = href.slice(comma + 1);
          if (/;base64/i.test(meta)) body = atob(body);
          else body = decodeURIComponent(body.replace(/\+/g, " "));
          if (looksLikePoolsCsv(body)) {
            const map = Object.keys(csvEnrichmentMap).length
              ? csvEnrichmentMap
              : await requestCsvMap();
            const enriched = enrichPoolsCsv(body, map || {});
            const newBlob = new Blob([enriched], { type: "text/csv;charset=utf-8" });
            const newUrl = originalCreateObjectURL(newBlob);
            blobByUrl.set(newUrl, newBlob);
            const a = document.createElement("a");
            a.href = newUrl;
            a.download = fileName.endsWith(".csv") ? fileName : `${fileName}.csv`;
            a.style.display = "none";
            document.body.appendChild(a);
            triggerAnchorDownload(a);
            a.remove();
            setTimeout(() => {
              try {
                originalRevokeObjectURL(newUrl);
              } catch (_) {
                /* ignore */
              }
              blobByUrl.delete(newUrl);
            }, 2000);
            return;
          }
        }
      } catch (_) {
        /* fall through */
      }
      triggerAnchorDownload(anchor);
      return;
    }

    const blob = blobByUrl.get(href);
    if (!blob) {
      triggerAnchorDownload(anchor);
      return;
    }
    const enriched = await maybeEnrichDownloadBlob(blob, fileName);
    if (!enriched) {
      triggerAnchorDownload(anchor);
      return;
    }
    const newUrl = originalCreateObjectURL(enriched);
    blobByUrl.set(newUrl, enriched);
    const a = document.createElement("a");
    a.href = newUrl;
    a.download = fileName;
    a.style.display = "none";
    document.body.appendChild(a);
    triggerAnchorDownload(a);
    a.remove();
    setTimeout(() => {
      try {
        originalRevokeObjectURL(newUrl);
      } catch (_) {
        /* ignore */
      }
      blobByUrl.delete(newUrl);
    }, 2000);
  }

  function shouldInterceptAnchor(anchor) {
    if (!anchor || suppressCsvIntercept) return false;
    const href = anchor.href || "";
    const fileName = anchor.getAttribute("download") || anchor.download || "";
    if (/^data:text\/(csv|plain)/i.test(href) && fileName) return true;
    if (!href.startsWith("blob:")) return false;
    return (
      /\.csv$/i.test(fileName) ||
      /\.xlsx$/i.test(fileName) ||
      blobByUrl.has(href)
    );
  }

  URL.createObjectURL = function patchedCreateObjectURL(obj) {
    const url = originalCreateObjectURL(obj);
    if (obj instanceof Blob) blobByUrl.set(url, obj);
    return url;
  };

  URL.revokeObjectURL = function patchedRevokeObjectURL(url) {
    blobByUrl.delete(url);
    return originalRevokeObjectURL(url);
  };

  HTMLAnchorElement.prototype.click = function patchedAnchorClick() {
    if (shouldInterceptAnchor(this)) {
      downloadEnrichedAnchor(this).catch(() => triggerAnchorDownload(this));
      return;
    }
    return originalAnchorClick.call(this);
  };

  document.addEventListener(
    "click",
    (event) => {
      if (suppressCsvIntercept) return;
      const anchor = event.target?.closest?.("a[download], a[href^='blob:'], a[href^='data:text']");
      if (!shouldInterceptAnchor(anchor)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      downloadEnrichedAnchor(anchor).catch(() => triggerAnchorDownload(anchor));
    },
    true
  );

  function tryReadStoredToken() {
    const keys = [
      "access_token",
      "accessToken",
      "horizonToken",
      "AUTH_TOKEN",
      "authToken",
      "bearerToken",
    ];
    for (const store of [window.sessionStorage, window.localStorage]) {
      try {
        for (const key of keys) {
          const value = store.getItem(key);
          if (value && value.length > 20) {
            const auth = /^Bearer\s+/i.test(value) ? value : `Bearer ${value}`;
            return auth;
          }
        }
        // Scan JSON blobs for access_token
        for (let i = 0; i < store.length; i += 1) {
          const key = store.key(i);
          const raw = store.getItem(key);
          if (!raw || raw.length > 500000) continue;
          if (!/access[_-]?token/i.test(raw)) continue;
          try {
            const obj = JSON.parse(raw);
            const token =
              obj?.access_token ||
              obj?.accessToken ||
              obj?.token ||
              obj?.auth?.access_token;
            if (typeof token === "string" && token.length > 20) {
              return /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
            }
          } catch (_) {
            const m = raw.match(/"access_token"\s*:\s*"([^"]+)"/i);
            if (m?.[1]) {
              return /^Bearer\s+/i.test(m[1]) ? m[1] : `Bearer ${m[1]}`;
            }
          }
        }
      } catch (_) {
        /* ignore storage access issues */
      }
    }
    return null;
  }

  function setAuth(auth) {
    if (!auth || auth === lastAuthorization) return;
    lastAuthorization = auth;
    post("auth", { authorization: auth });
  }

  const stored = tryReadStoredToken();
  if (stored) setAuth(stored);

  function extractAuth(headers) {
    if (!headers) return null;
    try {
      if (typeof headers.get === "function") {
        return headers.get("Authorization") || headers.get("authorization");
      }
      if (Array.isArray(headers)) {
        for (const [k, v] of headers) {
          if (String(k).toLowerCase() === "authorization") return v;
        }
      }
      if (typeof headers === "object") {
        for (const [k, v] of Object.entries(headers)) {
          if (k.toLowerCase() === "authorization") return v;
        }
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  function captureAuth(url, headers) {
    const href = String(url || "");
    if (!/\/rest\//i.test(href) && !/view-vlsi/i.test(href)) return;
    const auth = extractAuth(headers);
    if (auth && /^Bearer\s+/i.test(auth)) setAuth(auth);
  }

  function isPoolsUrl(url) {
    return /desktop-pools/i.test(String(url || ""));
  }

  async function readJsonSafe(response) {
    try {
      return await response.clone().json();
    } catch (_) {
      return null;
    }
  }

  window.fetch = async function patchedFetch(input, init = {}) {
    const url = typeof input === "string" ? input : input?.url;
    const headers =
      init?.headers || (input && typeof input === "object" ? input.headers : null);
    captureAuth(url, headers);

    const response = await originalFetch(input, init);

    if (isPoolsUrl(url) && response.ok) {
      const data = await readJsonSafe(response);
      if (data != null) {
        post("pools-response", { url: String(url), data });
      }
    }

    // Enrich server-generated pool CSV exports when possible
    if (response.ok) {
      try {
        const ct = String(response.headers.get("content-type") || "").toLowerCase();
        const cd = String(response.headers.get("content-disposition") || "");
        if (/csv/i.test(ct) || /\.csv/i.test(cd) || /csv/i.test(cd)) {
          const text = await response.clone().text();
          if (looksLikePoolsCsv(text)) {
            const map = Object.keys(csvEnrichmentMap).length
              ? csvEnrichmentMap
              : await requestCsvMap();
            const enriched = enrichPoolsCsv(text, map || {});
            if (enriched !== text) {
              return new Response(enriched, {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
            }
          }
        }
      } catch (_) {
        /* keep original response */
      }
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__hpiUrl = String(url || "");
    this.__hpiHeaders = {};
    return originalOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this.__hpiHeaders) this.__hpiHeaders = {};
    this.__hpiHeaders[name] = value;
    if (
      String(name).toLowerCase() === "authorization" &&
      /^Bearer\s+/i.test(String(value || ""))
    ) {
      setAuth(value);
    }
    return originalSetHeader.call(this, name, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    captureAuth(this.__hpiUrl, this.__hpiHeaders);
    if (isPoolsUrl(this.__hpiUrl)) {
      this.addEventListener("load", function onLoad() {
        if (this.status >= 200 && this.status < 300) {
          try {
            post("pools-response", {
              url: this.__hpiUrl,
              data: JSON.parse(this.responseText),
            });
          } catch (_) {
            /* ignore */
          }
        }
      });
    }
    return originalSend.apply(this, args);
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window) return;
    const msg = event.data;
    if (!msg || msg.source !== EXT_SOURCE) return;

    if (msg.type === "csv-map" && msg.payload?.map && typeof msg.payload.map === "object") {
      csvEnrichmentMap = msg.payload.map;
      return;
    }

    if (msg.type === "ping") {
      if (!lastAuthorization) {
        const again = tryReadStoredToken();
        if (again) setAuth(again);
      }
      post("ready", { hasAuth: Boolean(lastAuthorization) });
      if (lastAuthorization) post("auth", { authorization: lastAuthorization });
      publishCsvMapFromContent();
      return;
    }

    if (msg.type !== "api-request") return;

    const { id, path, method = "GET", headers = {}, body = undefined } = msg.payload || {};
    try {
      const url = path.startsWith("http") ? path : `${location.origin}${path}`;
      const finalHeaders = {
        Accept: "application/json",
        ...(headers || {}),
      };
      if (lastAuthorization && !finalHeaders.Authorization) {
        finalHeaders.Authorization = lastAuthorization;
      }

      const response = await originalFetch(url, {
        method,
        headers: finalHeaders,
        body,
        credentials: "include",
      });

      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (_) {
        data = text;
      }

      post("api-response", {
        id,
        ok: response.ok,
        status: response.status,
        data,
      });
    } catch (error) {
      post("api-response", {
        id,
        ok: false,
        status: 0,
        error: String(error && error.message ? error.message : error),
      });
    }
  });

  function publishCsvMapFromContent() {
    post("csv-map-request", {});
  }

  post("ready", { hasAuth: Boolean(lastAuthorization) });
})();
