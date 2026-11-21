(() => {
  const ATTR_MARK = "data-hpi-col";
  const ATTR_ROW = "data-hpi-row";
  const HEADER_MASTER = "Master Image";
  const HEADER_SNAPSHOT = "Snapshot";
  const PLACEHOLDER = "…";
  const WIDTH_KEY = "hpiColumnWidths";
  const DEFAULT_WIDTH = 170;
  const MIN_WIDTH = 120;
  const MAX_WIDTH = 720;
  const RESIZABLE_KINDS = ["master", "snapshot"];

  function textOf(el) {
    return (el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function normalizeHeader(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function isDisplayNameHeader(text) {
    const t = normalizeHeader(text);
    return (
      t === "display name" ||
      t === "displayname" ||
      t.startsWith("display name ") ||
      /\bdisplay name\b/.test(t)
    );
  }

  function isPoolsPage() {
    const root = document.body;
    if (!root) return false;
    const text = textOf(root).slice(0, 5000).toLowerCase();
    return text.includes("display name") && text.includes("desktop");
  }

  function headerLeafNodes(grid) {
    const nodes = [
      ...grid.querySelectorAll(
        "clr-dg-column, th[role='columnheader'], [role='columnheader'], .datagrid-column, .clr-dg-column"
      ),
    ];
    // Prefer leaf-like headers (not wrappers that contain other headers)
    return nodes.filter((el) => {
      if (el.hasAttribute(ATTR_MARK)) return false;
      const t = normalizeHeader(textOf(el));
      if (!t || t.length > 48) return false;
      const nested = el.querySelector(
        "clr-dg-column, [role='columnheader'], .datagrid-column, th"
      );
      return !nested;
    });
  }

  function findDisplayNameHeader(grid) {
    // Prefer explicit column title nodes used by Clarity
    for (const title of grid.querySelectorAll(
      ".datagrid-column-title, .clr-dg-column-title, clr-dg-column"
    )) {
      if (isDisplayNameHeader(textOf(title))) {
        return title.closest(
          "clr-dg-column, [role='columnheader'], .datagrid-column, th"
        ) || title;
      }
    }
    const headers = headerLeafNodes(grid);
    return headers.find((h) => isDisplayNameHeader(textOf(h))) || null;
  }

  function findPoolsGrids() {
    if (!isPoolsPage()) return [];

    const selectors = [
      "clr-datagrid",
      ".datagrid",
      ".clr-datagrid",
      "[role='grid']",
      "table",
    ];
    const found = [];
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (findDisplayNameHeader(el)) found.push(el);
      }
    }
    return found.filter(
      (el, _, arr) => !arr.some((other) => other !== el && other.contains(el))
    );
  }

  function cellSelector() {
    return [
      ":scope > clr-dg-cell",
      ":scope > td",
      ":scope > [role='gridcell']",
      ":scope > .datagrid-cell",
      ":scope > .clr-dg-cell",
    ].join(", ");
  }

  function rowCellChildren(row) {
    let cells = [...row.querySelectorAll(cellSelector())];
    if (cells.length >= 2) return cells;

    // Clarity sticky/scrollable split: cells live under nested row parts
    const parts = [
      ...row.querySelectorAll(
        ".datagrid-row-sticky, .datagrid-row-scrollable, .datagrid-row-master, .datagrid-row-detail"
      ),
    ];
    if (parts.length) {
      cells = [];
      for (const part of parts) {
        cells.push(
          ...part.querySelectorAll(
            ":scope > clr-dg-cell, :scope > td, :scope > [role='gridcell'], :scope > .datagrid-cell, :scope > .clr-dg-cell, :scope > .datagrid-column"
          )
        );
      }
      if (cells.length >= 2) return cells;
    }

    // Fallback: all direct-ish cells in row
    return [
      ...row.querySelectorAll(
        "clr-dg-cell, td, [role='gridcell'], .datagrid-cell, .clr-dg-cell"
      ),
    ].filter((c) => c.closest("[data-hpi-col]") == null && !c.hasAttribute(ATTR_MARK));
  }

  function getBodyRows(grid) {
    const rows = [
      ...grid.querySelectorAll("clr-dg-row"),
      ...grid.querySelectorAll("tbody tr"),
      ...grid.querySelectorAll(".datagrid-body .datagrid-row"),
    ];

    const unique = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || seen.has(row)) continue;
      if (row.closest("thead, .datagrid-header, .clr-dg-header")) continue;
      // Must look like a data row with an ID link or several cells
      const cells = rowCellChildren(row);
      if (cells.length < 2 && !row.querySelector("a")) continue;
      seen.add(row);
      unique.push(row);
    }
    return unique;
  }

  function cloneColumnChrome(sample, kind, label, isHeader) {
    const tag = sample?.tagName ? sample.tagName.toLowerCase() : isHeader ? "div" : "div";
    // Use the same custom element tag when possible (clr-dg-column / clr-dg-cell)
    const el = document.createElement(tag === "th" || tag === "td" ? tag : sample?.tagName || "div");
    el.setAttribute(ATTR_MARK, kind);
    el.setAttribute("role", isHeader ? "columnheader" : "gridcell");

    // Copy classes but drop sort/filter specific ones that may break layout
    const cls = (sample?.className || "")
      .toString()
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !/sorted|filter|hidden|ng-|cdk-/i.test(c));
    el.className = [...cls, "hpi-cell", isHeader ? "hpi-header" : "hpi-body"].join(" ");

    // Match Clarity inner structure lightly so styles apply
    if (isHeader) {
      const title = document.createElement("span");
      title.className = "datagrid-column-title clr-dg-column-title hpi-title";
      title.textContent = label;
      // Copy native header typography so injected titles match sibling columns
      const sampleTitle =
        sample.querySelector?.(".datagrid-column-title, .clr-dg-column-title") || sample;
      try {
        const cs = getComputedStyle(sampleTitle);
        title.style.fontSize = cs.fontSize;
        title.style.fontWeight = cs.fontWeight;
        title.style.fontFamily = cs.fontFamily;
        title.style.letterSpacing = cs.letterSpacing;
        title.style.textTransform = cs.textTransform;
        title.style.color = cs.color;
        title.style.lineHeight = cs.lineHeight;
      } catch (_) {
        /* keep defaults */
      }
      el.appendChild(title);
      if (RESIZABLE_KINDS.includes(kind)) {
        el.appendChild(ColumnResize.createHandle(kind));
      }
    } else {
      el.textContent = label;
    }
    // Headers keep a simple title; body cells use the styled path tooltip
    if (isHeader) {
      el.title = label;
    } else {
      el.removeAttribute("title");
    }

    // Force these to behave like real columns in flex/grid rows
    el.style.cssText = [
      "display:flex",
      "align-items:center",
      "flex:0 0 var(--hpi-w, 170px)",
      "width:var(--hpi-w, 170px)",
      "min-width:var(--hpi-w, 170px)",
      "max-width:none",
      "box-sizing:border-box",
      "padding:0 12px",
      "white-space:nowrap",
      "overflow:hidden",
      "text-overflow:ellipsis",
      "align-self:stretch",
    ].join(";");

    return el;
  }

  function removeAllInjects(grid) {
    grid.querySelectorAll(`[${ATTR_MARK}]`).forEach((n) => n.remove());
  }

  function insertAfter(referenceNode, newNode) {
    referenceNode.parentNode.insertBefore(newNode, referenceNode.nextSibling);
  }

  function isAfterDisplayName(displayEl, masterEl, snapshotEl) {
    if (!displayEl || !masterEl || !snapshotEl) return false;
    if (masterEl.parentElement !== displayEl.parentElement) return false;
    if (snapshotEl.parentElement !== displayEl.parentElement) return false;
    const kids = [...displayEl.parentElement.children];
    const iDisplay = kids.indexOf(displayEl);
    const iMaster = kids.indexOf(masterEl);
    const iSnap = kids.indexOf(snapshotEl);
    return iDisplay >= 0 && iMaster === iDisplay + 1 && iSnap === iDisplay + 2;
  }

  function ensureHeaderColumns(grid) {
    const displayHeader = findDisplayNameHeader(grid);
    if (!displayHeader) return null;

    const existingMaster = grid.querySelector(`[${ATTR_MARK}="master"].hpi-header, [${ATTR_MARK}="master"][role="columnheader"]`);
    const existingSnap = grid.querySelector(`[${ATTR_MARK}="snapshot"].hpi-header, [${ATTR_MARK}="snapshot"][role="columnheader"]`);

    if (isAfterDisplayName(displayHeader, existingMaster, existingSnap)) {
      return displayHeader;
    }

    // Clean previous bad injects (including those nested under ID)
    removeAllInjects(grid);

    const master = cloneColumnChrome(displayHeader, "master", HEADER_MASTER, true);
    const snapshot = cloneColumnChrome(displayHeader, "snapshot", HEADER_SNAPSHOT, true);

    // ALWAYS after Display Name, same parent as Display Name (scrollable section)
    insertAfter(displayHeader, snapshot);
    insertAfter(displayHeader, master);

    // Prevent flex wrap that pushes new columns under the locked ID column
    let parent = displayHeader.parentElement;
    while (parent && parent !== grid) {
      const style = getComputedStyle(parent);
      if (style.display === "flex" || style.display === "inline-flex") {
        parent.style.flexWrap = "nowrap";
      }
      parent = parent.parentElement;
    }

    return displayHeader;
  }

  function indexAmongSiblings(el) {
    if (!el?.parentElement) return -1;
    return [...el.parentElement.children].indexOf(el);
  }

  function findDisplayNameCell(row, displayHeader) {
    // 1) Same column index within the same local parent structure
    const headerParent = displayHeader.parentElement;
    const headerIndex = indexAmongSiblings(displayHeader);
    if (headerParent && headerIndex >= 0) {
      // Find analogous container in this row (scrollable part)
      const headerPartClass = headerParent.className?.toString?.() || "";
      let rowPart = null;
      if (headerPartClass) {
        const cls = headerPartClass
          .split(/\s+/)
          .find((c) => /scrollable|detail|row/i.test(c));
        if (cls) rowPart = row.querySelector(`:scope .${CSS.escape(cls)}, :scope > .${CSS.escape(cls)}`);
      }
      if (!rowPart) {
        rowPart =
          row.querySelector(
            ":scope > .datagrid-row-scrollable, :scope .datagrid-row-scrollable, :scope > .datagrid-row-detail"
          ) || row;
      }

      const siblings = [...rowPart.children].filter(
        (c) =>
          !c.hasAttribute(ATTR_MARK) &&
          (c.matches("clr-dg-cell, td, [role='gridcell'], .datagrid-cell, .clr-dg-cell, .datagrid-column") ||
            c.querySelector?.("a") != null)
      );

      // Header parent children may be columns; map by index among column-like siblings
      const headerColSiblings = [...headerParent.children].filter(
        (c) =>
          !c.hasAttribute(ATTR_MARK) &&
          c.matches(
            "clr-dg-column, th, [role='columnheader'], .datagrid-column, .clr-dg-column"
          )
      );
      const displayIndex = headerColSiblings.indexOf(displayHeader);
      if (displayIndex >= 0 && siblings[displayIndex]) {
        return siblings[displayIndex];
      }
    }

    // 2) Fallback by position: cells are checkbox, ID, Display Name, ...
    const cells = rowCellChildren(row).filter((c) => !c.hasAttribute(ATTR_MARK));
    // Heuristic: cell after the one that contains the ID link
    const idIdx = cells.findIndex((c) => c.querySelector("a"));
    if (idIdx >= 0 && cells[idIdx + 1]) return cells[idIdx + 1];

    // 3) Absolute fallback: third cell (checkbox, id, display name)
    if (cells.length >= 3) return cells[2];
    return cells[cells.length - 1] || null;
  }

  function extractPoolKey(row) {
    for (const a of row.querySelectorAll("a")) {
      const t = textOf(a);
      if (t && t.length < 120) return t;
    }
    return null;
  }

  function ensureRowCells(row, displayHeader) {
    const displayCell = findDisplayNameCell(row, displayHeader);
    if (!displayCell) return null;

    let master = row.querySelector(`[${ATTR_MARK}="master"]`);
    let snapshot = row.querySelector(`[${ATTR_MARK}="snapshot"]`);

    if (isAfterDisplayName(displayCell, master, snapshot)) {
      return { master, snapshot };
    }

    // Remove misplaced injects in this row (e.g. nested under ID)
    row.querySelectorAll(`[${ATTR_MARK}]`).forEach((n) => n.remove());

    master = cloneColumnChrome(displayCell, "master", PLACEHOLDER, false);
    snapshot = cloneColumnChrome(displayCell, "snapshot", PLACEHOLDER, false);

    insertAfter(displayCell, snapshot);
    insertAfter(displayCell, master);

    let parent = displayCell.parentElement;
    while (parent && parent !== row.parentElement) {
      const style = getComputedStyle(parent);
      if (style.display === "flex" || style.display === "inline-flex") {
        parent.style.flexWrap = "nowrap";
      }
      parent = parent.parentElement;
    }

    return { master, snapshot };
  }

  function setCell(el, value, tooltip) {
    const next = value || "—";
    const tip = tooltip || next;
    // Keep header-like inner span out of body cells; use styled tooltip instead of title
    if (el.textContent !== next) {
      el.textContent = next;
    }
    el.removeAttribute("title");
    if (tip && tip !== "—" && tip !== "…") {
      el.setAttribute("data-hpi-tip", tip);
    } else {
      el.removeAttribute("data-hpi-tip");
    }
  }

  const PathTooltip = (() => {
    let tipEl = null;
    let arrowEl = null;
    let hideTimer = null;
    let bound = false;

    function ensureEl() {
      if (tipEl && document.body.contains(tipEl)) return tipEl;
      tipEl = document.createElement("div");
      tipEl.className = "hpi-tooltip";
      tipEl.setAttribute("role", "tooltip");
      arrowEl = document.createElement("div");
      arrowEl.className = "hpi-tooltip-arrow";
      tipEl.appendChild(arrowEl);
      const text = document.createElement("div");
      text.className = "hpi-tooltip-text";
      tipEl.appendChild(text);
      document.body.appendChild(tipEl);
      return tipEl;
    }

    function place(anchor) {
      const el = ensureEl();
      const textEl = el.querySelector(".hpi-tooltip-text");
      const tip = anchor.getAttribute("data-hpi-tip");
      if (!tip) return;
      textEl.textContent = tip;

      el.style.left = "0px";
      el.style.top = "0px";
      el.classList.add("hpi-tooltip-visible");

      const margin = 8;
      const rect = anchor.getBoundingClientRect();
      const tipRect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      const space = {
        bottom: vh - rect.bottom,
        top: rect.top,
        right: vw - rect.right,
        left: rect.left,
      };

      const order = ["bottom", "top", "right", "left"];
      let placement = "bottom";
      for (const side of order) {
        const need =
          side === "bottom" || side === "top"
            ? tipRect.height + margin
            : tipRect.width + margin;
        if (space[side] >= need) {
          placement = side;
          break;
        }
      }

      let left;
      let top;
      if (placement === "bottom") {
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        top = rect.bottom + margin;
      } else if (placement === "top") {
        left = rect.left + rect.width / 2 - tipRect.width / 2;
        top = rect.top - tipRect.height - margin;
      } else if (placement === "right") {
        left = rect.right + margin;
        top = rect.top + rect.height / 2 - tipRect.height / 2;
      } else {
        left = rect.left - tipRect.width - margin;
        top = rect.top + rect.height / 2 - tipRect.height / 2;
      }

      left = Math.max(margin, Math.min(left, vw - tipRect.width - margin));
      top = Math.max(margin, Math.min(top, vh - tipRect.height - margin));

      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.setAttribute("data-placement", placement);

      // Point arrow toward the anchor center
      if (placement === "bottom" || placement === "top") {
        const anchorCenterX = rect.left + rect.width / 2;
        const arrowLeft = Math.max(
          12,
          Math.min(tipRect.width - 12, anchorCenterX - left)
        );
        arrowEl.style.left = `${arrowLeft}px`;
        arrowEl.style.top = "";
        arrowEl.style.right = "";
        arrowEl.style.bottom = "";
        arrowEl.style.transform = "translateX(-50%)";
      } else {
        const anchorCenterY = rect.top + rect.height / 2;
        const arrowTop = Math.max(
          12,
          Math.min(tipRect.height - 12, anchorCenterY - top)
        );
        arrowEl.style.top = `${arrowTop}px`;
        arrowEl.style.left = "";
        arrowEl.style.right = "";
        arrowEl.style.bottom = "";
        arrowEl.style.transform = "translateY(-50%)";
      }
    }

    function hide() {
      if (!tipEl) return;
      tipEl.classList.remove("hpi-tooltip-visible");
    }

    function onOver(event) {
      const cell = event.target?.closest?.(
        `.hpi-body[${ATTR_MARK}][data-hpi-tip]`
      );
      if (!cell) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      place(cell);
    }

    function onOut(event) {
      const cell = event.target?.closest?.(
        `.hpi-body[${ATTR_MARK}][data-hpi-tip]`
      );
      if (!cell) return;
      const related = event.relatedTarget;
      if (related && cell.contains(related)) return;
      hideTimer = setTimeout(hide, 80);
    }

    function bind() {
      if (bound) return;
      bound = true;
      document.addEventListener("mouseover", onOver, true);
      document.addEventListener("mouseout", onOut, true);
      window.addEventListener(
        "scroll",
        () => {
          hide();
        },
        true
      );
    }

    function destroy() {
      hide();
      tipEl?.remove();
      tipEl = null;
      arrowEl = null;
    }

    return { bind, destroy, hide };
  })();

  // Drag the right edge of Master Image / Snapshot headers to widen or narrow
  // those columns. Widths are shared by header and body cells via CSS variables
  // (--hpi-master-w / --hpi-snapshot-w, see styles.css) and persisted per browser.
  // Shared drag handle for resizable columns. getStart() gives the width at the
  // start of a drag; onDrag() gets the raw (unclamped) width while dragging.
  function buildResizeHandle({ dataAttr, getStart, onDrag, onReset, onDone }) {
    const handle = document.createElement("span");
    handle.className = "hpi-resize-handle";
    handle.setAttribute("data-hpi-resize", dataAttr);
    handle.title = "Drag to resize · double-click to reset";

    handle.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      // Keep the press from starting a Clarity sort or a text selection
      event.preventDefault();
      event.stopPropagation();

      const startX = event.clientX;
      const startWidth = getStart();
      handle.setPointerCapture?.(event.pointerId);
      document.documentElement.classList.add("hpi-resizing");

      const onMove = (e) => onDrag(startWidth + (e.clientX - startX));
      const onUp = () => {
        handle.removeEventListener("pointermove", onMove);
        handle.removeEventListener("pointerup", onUp);
        handle.removeEventListener("pointercancel", onUp);
        document.documentElement.classList.remove("hpi-resizing");
        onDone();
      };
      handle.addEventListener("pointermove", onMove);
      handle.addEventListener("pointerup", onUp);
      handle.addEventListener("pointercancel", onUp);
    });

    handle.addEventListener("click", (e) => e.stopPropagation());
    handle.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onReset();
      onDone();
    });
    return handle;
  }

  const ColumnResize = (() => {
    const widths = {};
    for (const kind of RESIZABLE_KINDS) widths[kind] = DEFAULT_WIDTH;
    let loaded = false;

    function clamp(w) {
      return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
    }

    function apply() {
      const root = document.documentElement;
      for (const kind of RESIZABLE_KINDS) {
        root.style.setProperty(`--hpi-${kind}-w`, `${widths[kind]}px`);
      }
    }

    function save() {
      try {
        chrome.storage.local.set({ [WIDTH_KEY]: { ...widths } });
      } catch (_) {
        /* storage unavailable: the width still applies for this page view */
      }
    }

    function load() {
      if (loaded) return;
      loaded = true;
      try {
        chrome.storage.local
          .get(WIDTH_KEY)
          .then((data) => {
            const saved = data?.[WIDTH_KEY] || {};
            for (const kind of RESIZABLE_KINDS) {
              if (Number.isFinite(saved[kind])) widths[kind] = clamp(saved[kind]);
            }
            apply();
          })
          .catch(() => {});
      } catch (_) {
        /* no storage access: defaults only */
      }
      apply();
    }

    function createHandle(kind) {
      return buildResizeHandle({
        dataAttr: kind,
        getStart: () => widths[kind],
        onDrag: (w) => {
          widths[kind] = clamp(w);
          apply();
        },
        onReset: () => {
          widths[kind] = DEFAULT_WIDTH;
          apply();
        },
        onDone: save,
      });
    }

    return { load, createHandle };
  })();

  // Drag the right edge of the other Desktops columns (Display Name, ID, state,
  // etc.) to resize them. Widths are saved per column title in chrome.storage.local.
  // A column with no saved width keeps Horizon's own sizing.
  const NativeColumns = (() => {
    const STORE_KEY = "hpiNativeColumnWidths";
    const MIN_WIDTH = 60;
    const WIDTH_ATTR = "data-hpi-nw";
    const WIDTH_PROPS = ["box-sizing", "width", "min-width", "max-width", "flex"];
    const saved = {}; // column key -> px
    const registry = new WeakMap(); // header element -> { key, cells }
    const originals = new WeakMap(); // element -> Map(prop -> { value, priority })
    let loaded = false;

    function clamp(w) {
      return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
    }

    function setWidth(els, px) {
      for (const el of els) {
        if (!el) continue;
        if (!originals.has(el)) {
          const record = new Map();
          for (const prop of WIDTH_PROPS) {
            record.set(prop, {
              value: el.style.getPropertyValue(prop),
              priority: el.style.getPropertyPriority(prop),
            });
          }
          originals.set(el, record);
        }
        el.style.setProperty("box-sizing", "border-box", "important");
        el.style.setProperty("width", `${px}px`, "important");
        el.style.setProperty("min-width", `${px}px`, "important");
        el.style.setProperty("max-width", `${px}px`, "important");
        el.style.setProperty("flex", `0 0 ${px}px`, "important");
        el.setAttribute(WIDTH_ATTR, "1");
      }
    }

    function clearWidth(els) {
      for (const el of els) {
        if (!el || !el.hasAttribute(WIDTH_ATTR)) continue;
        const record = originals.get(el);
        for (const prop of WIDTH_PROPS) {
          const orig = record?.get(prop);
          if (orig?.value) el.style.setProperty(prop, orig.value, orig.priority);
          else el.style.removeProperty(prop);
        }
        originals.delete(el);
        el.removeAttribute(WIDTH_ATTR);
      }
    }

    function save() {
      try {
        chrome.storage.local.set({ [STORE_KEY]: { ...saved } }).catch(() => {});
      } catch (_) {
        /* storage unavailable: the width still applies for this page view */
      }
    }

    function load(onLoaded) {
      if (loaded) return;
      loaded = true;
      try {
        chrome.storage.local
          .get(STORE_KEY)
          .then((data) => {
            const stored = data?.[STORE_KEY] || {};
            for (const [key, px] of Object.entries(stored)) {
              if (Number.isFinite(px)) saved[key] = clamp(px);
            }
            onLoaded?.();
          })
          .catch(() => {});
      } catch (_) {
        /* no storage access: Horizon's default widths only */
      }
    }

    // Other Desktops column headers, in display order, without our injected ones
    function columnHeaders(grid) {
      const nodes = new Set(
        grid.querySelectorAll(
          "clr-dg-column, th[role='columnheader'], [role='columnheader'], .datagrid-column, .clr-dg-column, thead th"
        )
      );
      return [...nodes].filter((el) => {
        if (el.closest(`[${ATTR_MARK}]`)) return false;
        if (el.closest("tbody, .datagrid-body, clr-dg-row")) return false;
        return !el.querySelector(
          "clr-dg-column, [role='columnheader'], .datagrid-column, th"
        );
      });
    }

    // Title-based keys; duplicate titles get the column index appended
    function headerKeys(headers) {
      const bases = headers.map((h, i) => normalizeHeader(textOf(h)) || `#${i}`);
      const counts = {};
      for (const b of bases) counts[b] = (counts[b] || 0) + 1;
      return bases.map((b, i) => (counts[b] > 1 ? `${b}#${i}` : b));
    }

    function ensureHandle(header) {
      if (header.querySelector(":scope > [data-hpi-resize='native']")) return;
      if (getComputedStyle(header).position === "static") {
        // Sticky headers already anchor absolutely positioned children
        header.style.position = "relative";
      }
      header.appendChild(
        buildResizeHandle({
          dataAttr: "native",
          getStart: () => header.getBoundingClientRect().width,
          onDrag: (w) => {
            const entry = registry.get(header);
            if (!entry) return;
            const px = clamp(w);
            saved[entry.key] = px;
            setWidth([header, ...entry.cells], px);
          },
          onReset: () => {
            const entry = registry.get(header);
            if (!entry) return;
            delete saved[entry.key];
            clearWidth([header, ...entry.cells]);
          },
          onDone: save,
        })
      );
    }

    function apply(grid, rows) {
      const headers = columnHeaders(grid);
      if (headers.length < 2) return;

      // Cells are matched to headers by position. If any data row disagrees,
      // leave the whole grid alone rather than shift columns.
      const bodies = rows
        .map((row) =>
          rowCellChildren(row).filter((c) => !c.closest(`[${ATTR_MARK}]`))
        )
        .filter((cells) => cells.length >= 2);
      const aligned =
        bodies.length > 0 && bodies.every((cells) => cells.length === headers.length);
      if (!aligned) {
        clearWidth([...grid.querySelectorAll(`[${WIDTH_ATTR}]`)]);
        return;
      }

      const keys = headerKeys(headers);
      headers.forEach((header, i) => {
        const key = keys[i];
        const cells = bodies.map((rowCells) => rowCells[i]);
        registry.set(header, { key, cells });
        ensureHandle(header);
        if (Number.isFinite(saved[key])) {
          setWidth([header, ...cells], saved[key]);
        } else {
          clearWidth([header, ...cells]);
        }
      });
    }

    return { load, apply };
  })();

  class GridInjector {
    constructor({ resolveRow }) {
      this.resolveRow = resolveRow;
      this._observer = null;
      this._scheduled = false;
      this._busy = false;
    }

    start() {
      if (this._observer) return;
      PathTooltip.bind();
      ColumnResize.load();
      NativeColumns.load(() => this.schedule());
      this._observer = new MutationObserver(() => this.schedule());
      this._observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      this.schedule();
    }

    stop() {
      this._observer?.disconnect();
      this._observer = null;
      PathTooltip.destroy();
    }

    schedule() {
      if (this._scheduled) return;
      this._scheduled = true;
      requestAnimationFrame(() => {
        this._scheduled = false;
        this.sync().catch((err) => console.warn("[HorizonPoolImages] sync failed", err));
      });
    }

    async sync() {
      if (this._busy) return;
      this._busy = true;
      const observer = this._observer;
      try {
        observer?.disconnect();
        const grids = findPoolsGrids();
        for (const grid of grids) {
          const displayHeader = ensureHeaderColumns(grid);
          if (!displayHeader) continue;

          const rows = getBodyRows(grid);
          NativeColumns.apply(grid, rows);

          for (const row of rows) {
            const key = extractPoolKey(row);
            if (!key) continue;
            row.setAttribute(ATTR_ROW, key);
            const cells = ensureRowCells(row, displayHeader);
            if (!cells) continue;
            const fields = await this.resolveRow(key);
            if (fields) {
              setCell(
                cells.master,
                fields.masterImage,
                fields.masterImagePath || fields.masterImage
              );
              setCell(
                cells.snapshot,
                fields.snapshot,
                fields.snapshotPath || fields.snapshot
              );
            }
          }
        }
      } finally {
        this._busy = false;
        if (observer && this._observer === observer) {
          observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
          });
        }
      }
    }
  }

  window.HorizonPoolImagesGrid = {
    GridInjector,
    findPoolsGrids,
  };
})();
