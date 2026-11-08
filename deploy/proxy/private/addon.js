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
    link.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/></svg>';
    link.appendChild(el("span", "t-insights-label", "Insights"));
    var anchor = stats.closest("li") || stats;
    var holder = anchor.tagName === "LI" ? el("li", "t-insights-item") : null;
    if (holder) {
      holder.appendChild(link);
      anchor.parentNode.insertBefore(holder, anchor.nextSibling);
    } else {
      anchor.parentNode.insertBefore(link, anchor.nextSibling);
    }
  }

  var LOCKED_TARGETS = [
    [/job outcomes|verdict/i, "outcomes"],
    [/space saved/i, "saved"],
    [/running worker|worker activity|throughput/i, "throughput"],
    [/stream/i, "composition"]
  ];

  function replaceLockedWidgets() {
    var locked = document.querySelectorAll(".dash-widget:not(.t-replaced)");
    Array.prototype.forEach.call(locked, function (w) {
      if (!w.querySelector(".dash-locked, .dash-lock-overlay, .history-graphs-blurred")) return;
      w.classList.add("t-replaced");
      var titleEl = w.querySelector(".dash-widget-title");
      var title = titleEl && titleEl.firstChild ? titleEl.firstChild.textContent : "This chart";
      title = title.split("·")[0];
      var anchor = "";
      LOCKED_TARGETS.some(function (t) {
        if (t[0].test(title)) { anchor = "#" + t[1]; return true; }
        return false;
      });
      var body = w.querySelector(".dash-widget-body") || w;
      var note = el("div", "t-locked-note");
      note.appendChild(el("p", "t-locked-title", title.trim()));
      note.appendChild(el("p", "t-locked-text", "Shown on the Insights page, built from local job history."));
      var a = el("a", "t-locked-btn", "Open Insights");
      a.href = "/_private/insights/" + anchor;
      note.appendChild(a);
      body.appendChild(note);
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
    replaceLockedWidgets();
    hideRelayStub();
    markDestructive();
    emptyStates();
  }
  function schedule() {
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(sweep);
  }

  window.addEventListener("hashchange", function () {
    if (!fixRoute()) resetScroll();
    schedule();
  });
  fixRoute();

  function start() {
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
    schedule();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
