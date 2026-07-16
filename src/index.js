const CONFIG_ERROR =
  "This Sophic proxy is not configured. Check EXPECTED_HOST, SOPHIC_ORIGIN, and SOPHIC_ROUTES (or the legacy MOUNT_PATH and SOPHIC_PORTAL_PATH)."

function normalizedPath(value, { allowRoot = false } = {}) {
  const raw = String(value ?? "").trim()
  if (!raw) return allowRoot ? "/" : ""
  const withSlash = raw.startsWith("/") ? raw : `/${raw}`
  const normalized = withSlash.replace(/\/{2,}/g, "/").replace(/\/+$/, "")
  return normalized || "/"
}

function normalizedOrigin(value) {
  try {
    const url = new URL(String(value ?? "").trim())
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
    url.pathname = "/"
    url.search = ""
    url.hash = ""
    return url
  } catch {
    return null
  }
}

function normalizedRoute(mountValue, portalValue) {
  const mountPath = normalizedPath(mountValue)
  const portalPath = normalizedPath(portalValue)
  if (
    !mountPath ||
    mountPath === "/" ||
    !portalPath ||
    !portalPath.startsWith("/p/")
  ) {
    return null
  }
  return { mountPath, portalPath }
}

function normalizedRouteMap(value) {
  const raw = String(value ?? "").trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") return []
    const routes = []
    const seen = new Set()
    for (const [mountValue, portalValue] of Object.entries(parsed)) {
      const route = normalizedRoute(mountValue, portalValue)
      if (!route || seen.has(route.mountPath)) return []
      seen.add(route.mountPath)
      routes.push(route)
    }
    return routes.sort((a, b) => b.mountPath.length - a.mountPath.length)
  } catch {
    return []
  }
}

export function proxyConfig(env) {
  const expectedHost = String(env.EXPECTED_HOST ?? "")
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, "")
  const sophicOrigin = normalizedOrigin(env.SOPHIC_ORIGIN)
  const routeMap = normalizedRouteMap(env.SOPHIC_ROUTES)
  const legacyRoute = normalizedRoute(env.MOUNT_PATH, env.SOPHIC_PORTAL_PATH)
  const routes = routeMap ?? (legacyRoute ? [legacyRoute] : [])

  if (
    !expectedHost ||
    expectedHost.includes("/") ||
    !sophicOrigin ||
    routes.length === 0
  ) {
    return null
  }

  return {
    expectedHost,
    sophicOrigin,
    routes,
    mountPath: routes[0].mountPath,
    portalPath: routes[0].portalPath,
  }
}

function activeRoute(requestUrl, config) {
  const incoming = new URL(requestUrl)
  if (incoming.hostname.toLowerCase() !== config.expectedHost) return null
  const routes = config.routes ?? [
    { mountPath: config.mountPath, portalPath: config.portalPath },
  ]
  return (
    routes.find(
      (route) =>
        incoming.pathname === route.mountPath ||
        incoming.pathname.startsWith(`${route.mountPath}/`),
    ) ?? null
  )
}

export function upstreamUrlFor(requestUrl, config) {
  const incoming = new URL(requestUrl)
  const route = activeRoute(requestUrl, config)
  if (!route) return null

  const upstream = new URL(config.sophicOrigin)
  const suffix = incoming.pathname.slice(route.mountPath.length)
  const apiPrefix = "/_sophic/api/"

  // Address the stable portal route directly. Going through the public mount
  // on app.sophic.so can hit the project's canonical-address redirect first:
  // customer.example/manuals -> app.sophic.so/p/project/<id> -> the public mount.
  // Using /p/<workspace>/<project> removes that redirect hop entirely while
  // the forwarding headers keep all rendered links rooted at the public mount.
  upstream.pathname = suffix.startsWith(apiPrefix)
    ? `/api/public/${suffix.slice(apiPrefix.length)}`
    : `${route.portalPath}${suffix}`
  upstream.search = incoming.search
  return upstream
}

export function externalLocation(location, requestUrl, config) {
  if (!location) return null
  const route = activeRoute(requestUrl, config)
  if (!route) return location
  const target = new URL(location, config.sophicOrigin)
  if (target.origin !== config.sophicOrigin.origin) return location
  if (
    target.pathname !== route.portalPath &&
    !target.pathname.startsWith(`${route.portalPath}/`)
  ) {
    return location
  }

  const incoming = new URL(requestUrl)
  const suffix = target.pathname.slice(route.portalPath.length)
  target.protocol = incoming.protocol
  target.host = incoming.host
  target.pathname = `${route.mountPath}${suffix}`
  return target.toString()
}

function proxyRequest(request, upstream, config) {
  const headers = new Headers(request.headers)
  headers.set("x-forwarded-host", config.expectedHost)
  headers.set("x-sophic-base-path", config.mountPath)
  headers.set("x-sophic-proxy", "cloudflare-worker-v1")
  headers.delete("cf-connecting-ip")

  return new Request(upstream, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
  })
}

async function rewriteHtml(response, config) {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("text/html")) return response

  const assetOrigin = config.sophicOrigin.origin
  const headers = new Headers(response.headers)
  headers.delete("content-length")
  headers.delete("content-encoding")

  const link = headers.get("link")
  if (link) {
    headers.set(
      "link",
      link
        .replaceAll("</_next/", `<${assetOrigin}/_next/`)
        .replaceAll("</logo.svg>", `<${assetOrigin}/logo.svg>`),
    )
  }

  const html = (await response.text())
    .replace(/(["'])\/_next\//g, `$1${assetOrigin}/_next/`)
    .replace(/(["'])\/logo\.svg(?=["'])/g, `$1${assetOrigin}/logo.svg`)

  return new Response(html, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function isSelfRedirect(location, requestUrl) {
  try {
    const target = new URL(location)
    const current = new URL(requestUrl)
    target.hash = ""
    current.hash = ""
    return target.toString() === current.toString()
  } catch {
    return false
  }
}

export default {
  async fetch(request, env) {
    const config = proxyConfig(env)
    if (!config) return new Response(CONFIG_ERROR, { status: 500 })

    const route = activeRoute(request.url, config)
    if (!route) {
      return new Response("This Worker only serves the configured Sophic path.", {
        status: 404,
      })
    }
    const activeConfig = { ...config, ...route, routes: [route] }
    const upstream = upstreamUrlFor(request.url, activeConfig)

    const upstreamResponse = await fetch(
      proxyRequest(request, upstream, activeConfig),
    )
    const response = new Response(upstreamResponse.body, upstreamResponse)
    const location = externalLocation(
      response.headers.get("location"),
      request.url,
      activeConfig,
    )
    if (location && isSelfRedirect(location, request.url)) {
      return new Response(
        "Sophic returned a circular redirect. Check SOPHIC_ROUTES and redeploy this Worker.",
        {
          status: 502,
          headers: { "x-sophic-proxy": "cloudflare-worker-v1" },
        },
      )
    }
    if (location) response.headers.set("location", location)
    response.headers.set("x-sophic-proxy", "cloudflare-worker-v1")
    return rewriteHtml(response, activeConfig)
  },
}
