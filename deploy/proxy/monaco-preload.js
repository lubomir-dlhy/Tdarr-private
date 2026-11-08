// @monaco-editor/loader reuses window.monaco when present instead of fetching it from jsDelivr.
(function () {
  var base = window.location.origin + "/_private/monaco/vs";
  var script = document.createElement("script");
  script.src = base + "/loader.js";
  script.onload = function () {
    window.require.config({ paths: { vs: base } });
    window.require(["vs/editor/editor.main"], function () {});
  };
  document.head.appendChild(script);
})();
