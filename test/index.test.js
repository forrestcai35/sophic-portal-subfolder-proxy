import assert from "node:assert/strict"
import test from "node:test"
import {
  externalLocation,
  proxyConfig,
  upstreamUrlFor,
  default as worker,
} from "../src/index.js"

const env = {
  EXPECTED_HOST: "customer.com",
  MOUNT_PATH: "/blog",
  SOPHIC_ORIGIN: "https://app.sophic.so",
  SOPHIC_PORTAL_PATH: "/p/acme/blog",
}

test("maps the exact mount and its descendants without swallowing similar paths", () => {
  const config = proxyConfig(env)
  assert.ok(config)
  assert.equal(
    upstreamUrlFor("https://customer.com/blog", config)?.toString(),
    "https://app.sophic.so/p/acme/blog",
  )
  assert.equal(
    upstreamUrlFor("https://customer.com/blog/post?q=one", config)?.toString(),
    "https://app.sophic.so/p/acme/blog/post?q=one",
  )
  assert.equal(
    upstreamUrlFor(
      "https://customer.com/blog/_sophic/api/search?q=one",
      config,
    )?.toString(),
    "https://app.sophic.so/api/public/search?q=one",
  )
  assert.equal(upstreamUrlFor("https://customer.com/blogger", config), null)
  assert.equal(upstreamUrlFor("https://other.com/blog", config), null)
})

test("maps multiple workspace projects from one route bundle", () => {
  const config = proxyConfig({
    EXPECTED_HOST: "portal.northwind.test",
    SOPHIC_ORIGIN: "https://app.sophic.so",
    SOPHIC_ROUTES: JSON.stringify({
      "/manuals": "/p/northwind/developer-guide",
      "/support": "/p/northwind/customer-care",
    }),
  })
  assert.ok(config)
  assert.equal(
    upstreamUrlFor(
      "https://portal.northwind.test/manuals/doc/install",
      config,
    )?.toString(),
    "https://app.sophic.so/p/northwind/developer-guide/doc/install",
  )
  assert.equal(
    upstreamUrlFor("https://portal.northwind.test/support", config)?.toString(),
    "https://app.sophic.so/p/northwind/customer-care",
  )
  assert.equal(
    upstreamUrlFor("https://portal.northwind.test/status", config),
    null,
  )
})

test("stops an upstream redirect from bouncing back to the same customer URL", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async () =>
    new Response(null, {
      status: 307,
      headers: { location: "https://app.sophic.so/p/acme/blog" },
    })

  const response = await worker.fetch(
    new Request("https://customer.com/blog"),
    env,
  )

  assert.equal(response.status, 502)
  assert.match(await response.text(), /circular redirect/i)
})

test("rewrites Sophic redirects back to the customer mount", () => {
  const config = proxyConfig(env)
  assert.ok(config)
  assert.equal(
    externalLocation(
      "https://app.sophic.so/p/acme/blog/doc/launch?ref=search",
      "https://customer.com/blog",
      config,
    ),
    "https://customer.com/blog/doc/launch?ref=search",
  )
  assert.equal(
    externalLocation("https://billing.example.com/checkout", "https://customer.com/blog", config),
    "https://billing.example.com/checkout",
  )
})

test("rewrites portal assets without relying on HTMLRewriter", async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = async () =>
    new Response(
      '<link href="/_next/app.css"><script src="/_next/app.js"></script><img src="/logo.svg">',
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          link: '</_next/font.woff2>; rel=preload',
        },
      },
    )

  const response = await worker.fetch(
    new Request("https://customer.com/blog"),
    env,
  )
  const html = await response.text()

  assert.match(html, /href="https:\/\/app\.sophic\.so\/_next\/app\.css"/)
  assert.match(html, /src="https:\/\/app\.sophic\.so\/_next\/app\.js"/)
  assert.match(html, /src="https:\/\/app\.sophic\.so\/logo\.svg"/)
  assert.match(response.headers.get("link") ?? "", /https:\/\/app\.sophic\.so\/_next\/font/)
})

test("rejects an incomplete or root-mount configuration", () => {
  assert.equal(proxyConfig({ ...env, MOUNT_PATH: "/" }), null)
  assert.equal(proxyConfig({ ...env, SOPHIC_PORTAL_PATH: "/docs" }), null)
  assert.equal(proxyConfig({ ...env, EXPECTED_HOST: "" }), null)
  assert.equal(proxyConfig({ ...env, SOPHIC_ROUTES: "not json" }), null)
})
