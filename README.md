# Sophic portal sub-folder proxy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/sophichq/sophic-cloudflare-proxy)

This Cloudflare Worker mounts one Sophic portal below a path on an existing
website, such as `customer.com/docs`, without changing the site's DNS target or
replacing its homepage.

## Deploy

1. Deploy this repository with Cloudflare's **Deploy to Cloudflare** flow.
2. Open **Settings → Variables and Secrets** and replace the three example
   Worker variables with the values shown by Sophic:
   - `EXPECTED_HOST` — `customer.com`
   - `SOPHIC_ORIGIN` — `https://app.sophic.so`
   - `SOPHIC_ROUTES` — `{\"/docs\":\"/p/<workspace>/docs\",\"/help\":\"/p/<workspace>/help\"}`
3. In **Workers & Pages → your Worker → Settings → Domains & Routes**, add two
   Worker Routes per project path for the existing Cloudflare zone:
   - `customer.com/docs`
   - `customer.com/docs/*`
4. Keep the zone's existing proxied A/CNAME records. Do not point the root
   domain at Sophic.

Repeat those two exact/child routes for every entry in `SOPHIC_ROUTES`. Using
exact routes instead of `customer.com/docs*` prevents the Worker from capturing
unrelated paths such as `/docs-old`.

The template sets `keep_vars` so later source-code deployments preserve the
customer-specific variables configured in Cloudflare.

## How it proxies

The Worker preserves the browser-visible path, request method, query string,
and request body. It maps each customer mount in `SOPHIC_ROUTES` directly to
its stable portal path, avoiding canonical-address redirect loops, and sends the
external host and mount path so Sophic renders links below the customer path.
The Worker also rewrites Sophic redirects back to the customer's URL.

## Local validation

Run `npm test`. Do not put credentials in this Worker; all three settings are
non-secret routing values.
