# Tdarr private deployment layer

This directory contains the deployment hardening used for the self-hosted Tdarr instance. It does not modify Tdarr's proprietary application bundle or its license checks.

## Privacy contract

- The server and node use a Docker network created with `--internal`; they have no default route to the Internet.
- Pangolin/Newt is the only external-facing component. Newt joins the internal network only to proxy the labeled Tdarr HTTP resource.
- Images are pinned by digest. Updating an image is an explicit maintenance action.
- No Tdarr telemetry, update checks, license calls, plugin downloads, or third-party web requests can leave the Tdarr containers. Local media processing and server/node communication continue to work.
- External documentation/community links in the vendor UI are not used by the service and are not required for operation.

The Tdarr EULA prohibits reverse engineering, redistribution, and bypassing subscription tiers. This layer therefore leaves entitlement checks intact. If a paid feature is incorrectly blocked, fix the account/entitlement through Tdarr support or use an independently licensed alternative.

## Apply on the host

1. Create the internal network once:

   ```sh
   docker network inspect tdarr_internal >/dev/null 2>&1 || docker network create --internal tdarr_internal
   ```

2. Ensure the Newt service joins both `newt` and `tdarr_internal` networks.
3. Start the Tdarr compose project. The server and node must list `tdarr_internal` as their only network; the server's Pangolin labels remain on the server service.
4. Verify the egress boundary:

   ```sh
   docker exec tdarr-server getent hosts tdarr-node
   docker exec tdarr-server sh -c 'wget -qO- --timeout=3 https://example.com || test "$?" -ne 0'
   docker exec tdarr-node getent hosts tdarr-server
   ```

The first and third commands should resolve. The Internet request must fail.
