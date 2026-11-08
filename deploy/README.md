# Tdarr private deployment layer

This directory contains the deployment hardening used for the self-hosted Tdarr instance. It does not modify Tdarr's proprietary application bundle or its license checks.

## Privacy contract

- The server and node use a Docker network created with `--internal`; they have no default route to the Internet.
- Pangolin/Newt is the only external-facing component. Newt joins the internal network only to proxy the labeled Tdarr HTTP resource.
- Images are pinned by digest. Updating an image is an explicit maintenance action.
- No Tdarr telemetry, update checks, license calls, plugin downloads, or third-party web requests can leave the Tdarr containers. Local media processing and server/node communication continue to work.
- The browser UI itself calls `api.tdarr.io` (pro notice, version check, notifications) and loads the Monaco editor from jsDelivr. Container isolation cannot stop that, so Pangolin targets `tdarr-proxy`, an nginx sidecar that sets `Content-Security-Policy: connect-src 'self'` (plus same-origin scripts, styles, fonts and workers). The UI can only reach its own origin.
- Monaco 0.36.1 is self-hosted under `/_private/monaco` and preloaded, so `@monaco-editor/loader` reuses `window.monaco` instead of fetching it from the CDN. The proxy only injects one `<script>` tag into `index.html`; the vendor bundle is served unmodified.
- External documentation/community links in the vendor UI are not used by the service and are not required for operation.

The Tdarr EULA prohibits reverse engineering, redistribution, and bypassing subscription tiers. This layer therefore leaves entitlement checks intact. If a paid feature is incorrectly blocked, fix the account/entitlement through Tdarr support or use an independently licensed alternative.

## Apply on the host

1. Create the internal network once:

   ```sh
   docker network inspect tdarr_internal >/dev/null 2>&1 || docker network create --internal tdarr_internal
   ```

2. Install the self-hosted Monaco build next to the proxy config (verifies the npm integrity hash):

   ```sh
   mkdir -p proxy/private && cp deploy/proxy/nginx.conf proxy/ && cp deploy/proxy/monaco-preload.js proxy/private/
   sh deploy/proxy/fetch-monaco.sh proxy/private
   ```

3. Ensure the Newt service joins both `newt` and `tdarr_internal` networks.
4. Start the Tdarr compose project. All three services list `tdarr_internal` as their only network, and the Pangolin labels live on `tdarr-proxy`. Newt reads labels only at startup, so restart Newt after moving them.
5. Verify the egress boundary:

   ```sh
   docker exec tdarr-server getent hosts tdarr-node
   docker exec tdarr-server sh -c 'wget -qO- --timeout=3 https://example.com || test "$?" -ne 0'
   docker exec tdarr-node getent hosts tdarr-server
   ```

The first and third commands should resolve. The Internet request must fail. In the browser's DevTools, requests to `api.tdarr.io` must show as blocked by CSP.

## Library transcode preset (Intel N5095 / Jasper Lake)

The iGPU only has low-power VDENC, and the bundled ffmpeg is 7.1:

- `-global_quality` (ICQ) fails to open `hevc_qsv`, and with hardware decode it is silently ignored. Use CQP via `-q:v`.
- `-map 0:s:m:language:xxx?` is rejected by ffmpeg 7.1 whenever no stream matches, so it fails every job. Keep all subtitles with `-map 0:s?`.
- Tdarr requires `<io>` between input and output arguments.
- The library cache must be a path that both server and node see: `/media/.tdarr-cache`.

```text
-hwaccel qsv -hwaccel_output_format qsv<io>-map 0:V -map 0:a? -map 0:s? -map 0:t? -map_metadata 0 -c:v hevc_qsv -q:v 26 -c:a copy -c:s copy
```

`0:V` excludes attached cover pictures, which QSV cannot decode. QP 26 measured SSIM 0.990 against a 1080p h264 source at about 10% of its video bitrate, encoding at roughly 7x realtime.
