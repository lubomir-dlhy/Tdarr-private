(function () {
  "use strict";

  var SLASH_ROUTES = /^#\/(flows|libraries|stats|tools|plugins|automations|options|help|releases|logs|search)$/;
  var HIDDEN_TOOL_ROUTES = ["#/tools/tdarr-relay", "#/tools/dedupe", "#/tools/notifications"];

  function fixRoute() {
    var h = window.location.hash;
    if (SLASH_ROUTES.test(h)) {
      window.location.replace(h + "/");
      return true;
    }
    if (HIDDEN_TOOL_ROUTES.indexOf(h.replace(/\/$/, "")) !== -1) {
      window.location.replace("#/tools/variables");
      return true;
    }
    return false;
  }

  function resetScroll() {
    var main = document.querySelector(".app-main-content");
    if (main) main.scrollTop = 0;
    window.scrollTo(0, 0);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function addInsightsLink() {
    var nav = document.querySelector(".sidebar-nav");
    if (!nav || nav.querySelector(".t-insights-link")) return;
    var stats = Array.prototype.find.call(nav.querySelectorAll(".sidebar-nav-link"), function (a) {
      return /^\s*Stats\s*$/.test(a.textContent);
    });
    if (!stats) return;
    var link = el("a", "sidebar-nav-link t-insights-link");
    link.href = "/_private/insights/";
    link.title = "Insights";
    link.innerHTML =
      '<svg aria-hidden="true" focusable="false" class="svg-inline--fa nav-icon" role="img" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path fill="currentColor" d="M64 64c0-17.7-14.3-32-32-32S0 46.3 0 64V400c0 44.2 35.8 80 80 80H480c17.7 0 32-14.3 32-32s-14.3-32-32-32H80c-8.8 0-16-7.2-16-16V64zm406.6 86.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L320 210.7l-57.4-57.4c-12.5-12.5-32.8-12.5-45.3 0l-112 112c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L240 221.3l57.4 57.4c12.5 12.5 32.8 12.5 45.3 0l128-128z"/></svg>';
    link.appendChild(el("span", "nav-text", "Insights"));
    var anchor = stats.closest("li") || stats;
    var holder = anchor.tagName === "LI" ? el("li", "t-insights-item") : null;
    if (holder) {
      holder.appendChild(link);
      anchor.parentNode.insertBefore(holder, anchor.nextSibling);
    } else {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    }
  }

  var watchedGrids = new WeakSet();

  function removeLockedWidgets() {
    Array.prototype.forEach.call(document.querySelectorAll(".react-grid-item:not(.t-gone)"), function (item) {
      if (item.querySelector(".dash-locked, .dash-lock-overlay, .history-graphs-blurred")) item.classList.add("t-gone");
    });
    Array.prototype.forEach.call(document.querySelectorAll(".dash-grid"), function (grid) {
      if (!grid.querySelector(".t-gone")) return;
      if (!watchedGrids.has(grid)) {
        watchedGrids.add(grid);
        new MutationObserver(schedule).observe(grid, { attributes: true, attributeFilter: ["style"] });
      }
      var top = grid.getBoundingClientRect().top;
      var bottom = 0;
      Array.prototype.forEach.call(grid.children, function (c) {
        if (c.classList.contains("t-gone") || !c.classList.contains("react-grid-item")) return;
        bottom = Math.max(bottom, c.getBoundingClientRect().bottom - top);
      });
      var h = Math.ceil(bottom + 10) + "px";
      if (bottom > 0 && grid.style.height !== h) grid.style.height = h;
    });
  }

  function hideOrphanedProRows() {
    Array.prototype.forEach.call(document.querySelectorAll(".queue-controls-grid > .grid-item:not(.t-hidden)"), function (cell) {
      if (/^\s*Node priority:?\s*$/i.test(cell.textContent)) {
        cell.classList.add("t-hidden");
        if (cell.nextElementSibling) cell.nextElementSibling.classList.add("t-hidden");
      }
    });
  }

  function hideRelayStub() {
    var main = document.querySelector(".app-main-content");
    if (!main) return;
    Array.prototype.forEach.call(main.querySelectorAll("p, span, div, h5, h4"), function (n) {
      if (n.children.length === 0 && n.textContent.trim() === "Tdarr Relay" && !n.closest(".t-hidden")) {
        var box = n.parentElement;
        if (box && box.textContent.trim() === "Tdarr Relay") box.classList.add("t-hidden");
        else n.classList.add("t-hidden");
      }
    });
  }

  function markDestructive() {
    Array.prototype.forEach.call(document.querySelectorAll(".dropdown-item:not(.t-checked), .app-main-content button:not(.t-checked)"), function (n) {
      n.classList.add("t-checked");
      if (/^(delete|clear|remove|reset)\b/i.test(n.textContent.trim())) n.classList.add("t-destructive");
    });
  }

  function emptyStates() {
    var cl = document.querySelector(".app-main-content");
    if (!cl || !/^#\/releases/.test(window.location.hash)) return;
    if (cl.querySelector(".t-releases-note")) return;
    var box = cl.querySelector(".containerGeneral");
    if (box && box.textContent.replace(/\s+/g, "").length < 40) {
      box.appendChild(el("p", "t-releases-note", "Release notes are fetched from tdarr.io, which this private deployment blocks. Image versions are pinned in the compose file."));
    }
  }

  var queued = false;
  function sweep() {
    queued = false;
    addInsightsLink();
    removeLockedWidgets();
    hideRelayStub();
    hideOrphanedProRows();
    markDestructive();
    emptyStates();
  }
  function schedule() {
    if (queued) return;
    queued = true;
    window.setTimeout(sweep, 120);
  }

  window.addEventListener("hashchange", function () {
    if (!fixRoute()) resetScroll();
    schedule();
  });
  fixRoute();

  function start() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
    // react-grid-layout measures its width before theme.css changes the page padding.
    window.setTimeout(function () { window.dispatchEvent(new Event("resize")); }, 300);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
