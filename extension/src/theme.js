// Dark mode toggle for the Horizon Console.
//
// The colors themselves come from CSS (the html.hpi-dark rules in styles.css),
// so hover and state changes are handled by the browser, not by this script.
// This file only places the toggle beside the header "About" link, remembers
// the choice, and sets the html.hpi-dark class on the console (not on the
// sign-in page, which has no toggle).
(() => {
  const STORAGE_KEY = "hpiDarkMode";
  const ROOT_CLASS = "hpi-dark";
  const UI_ATTR = "data-hpi-ui";
  const TOGGLE_ID = "theme-toggle";
  const ANCHOR_TEXT = "About";
  const CHECK_MS = 1000;
  // Computed styles copied from the About link so the toggle matches it
  const INLINE_PROPS = [
    "font-family",
    "font-size",
    "font-weight",
    "letter-spacing",
    "line-height",
    "color",
    "padding",
    "margin",
  ];

  let enabled = false;
  let anchor = null;
  let observer = null;
  let timer = 0;

  function toggleEl() {
    return document.querySelector(`button[${UI_ATTR}="${TOGGLE_ID}"]`);
  }

  // The "About" link in the header, found by its text near the top of the page.
  // Returns the outermost element whose only text is "About", so the toggle is
  // inserted beside the link, never inside it.
  function findAnchor() {
    if (anchor?.isConnected) return anchor;
    anchor = null;
    for (const el of document.querySelectorAll("a, button, span, div")) {
      if (el.childElementCount > 0 || el.closest(`[${UI_ATTR}]`)) continue;
      if (el.textContent.trim() !== ANCHOR_TEXT) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.top > 120) continue;
      let target = el;
      while (
        target.parentElement &&
        target.parentElement.textContent.trim() === ANCHOR_TEXT &&
        !target.parentElement.matches("header, nav, body, html")
      ) {
        target = target.parentElement;
      }
      anchor = target;
      return anchor;
    }
    return null;
  }

  function syncInlineStyle(btn, target) {
    const cs = getComputedStyle(target);
    for (const prop of INLINE_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (btn.style.getPropertyValue(prop) !== value) {
        btn.style.setProperty(prop, value);
      }
    }
  }

  function createToggle() {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hpi-theme-toggle";
    btn.setAttribute(UI_ATTR, TOGGLE_ID);
    btn.title = "Switch the Horizon console between light and dark mode";
    btn.innerHTML =
      '<span class="hpi-theme-label">Dark mode</span>' +
      '<span class="hpi-theme-track"><span class="hpi-theme-knob"></span></span>';
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      setEnabled(!enabled);
    });
    return btn;
  }

  function updateToggle() {
    const btn = toggleEl();
    if (btn) btn.setAttribute("aria-pressed", String(enabled));
  }

  function ensureToggle() {
    if (!document.body) return;
    const target = findAnchor();
    if (!target) return; // sign-in page: no toggle
    const btn = toggleEl();
    if (btn && btn.previousElementSibling === target) {
      syncInlineStyle(btn, target);
    } else {
      btn?.remove();
      const fresh = createToggle();
      target.insertAdjacentElement("afterend", fresh);
      syncInlineStyle(fresh, target);
    }
    updateToggle();
  }

  // Dark mode applies only where the toggle exists (the console)
  function applyClass() {
    const want = enabled && Boolean(findAnchor());
    document.documentElement.classList.toggle(ROOT_CLASS, want);
  }

  function setEnabled(next, { persist = true } = {}) {
    enabled = next;
    applyClass();
    updateToggle();
    if (persist) {
      try {
        chrome.storage.local.set({ [STORAGE_KEY]: enabled }).catch(() => {});
      } catch (_) {
        /* storage unavailable: the choice lasts for this page view only */
      }
    }
  }

  function readStoredState() {
    try {
      chrome.storage.local
        .get(STORAGE_KEY)
        .then((data) => {
          const next = data?.[STORAGE_KEY] === true;
          if (next !== enabled) setEnabled(next, { persist: false });
        })
        .catch(() => {});
    } catch (_) {
      /* no storage access: stays light */
    }
  }

  // Keep other open console tabs in step with the toggle
  function watchStoredState() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local" || !(STORAGE_KEY in changes)) return;
        const next = changes[STORAGE_KEY].newValue === true;
        if (next !== enabled) setEnabled(next, { persist: false });
      });
    } catch (_) {
      /* no storage access */
    }
  }

  function refresh() {
    ensureToggle();
    applyClass();
  }

  // The header can appear by a style change, which the observer does not see,
  // so a light periodic check backs up the observer.
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 150);
  }

  function start() {
    if (observer) return;
    observer = new MutationObserver(scheduleRefresh);
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(refresh, CHECK_MS);
    ensureToggle();
    watchStoredState();
    readStoredState();
  }

  window.HorizonPoolImagesTheme = { start };
})();
