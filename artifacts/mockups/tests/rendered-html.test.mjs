import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the booking flow answer", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>VeriFlow — lesson booking flow in main-panel<\/title>/i);

  // the question and its answer
  assert.match(html, /Jak funguje rezervace a zaplacení lekce\?/);
  assert.match(html, /atomic hold → paid transition/);

  // navigation: the four views hang off the answered question, External does not
  const nav = html.match(/<nav class="nav">([\s\S]*?)<\/nav>/)?.[1] ?? "";
  assert.ok(nav, "sidebar nav did not render");
  assert.match(nav, /nav-section-label">Analyzed flows</);
  assert.match(nav, /nav-question[^>]*>Rezervace a zaplacení lekce</);
  const children = nav.match(/<div class="nav-children">([\s\S]*?)<\/div>/)?.[1] ?? "";
  for (const label of ["Flow", "Paths", "Modules", "Document"]) {
    assert.match(children, new RegExp(`nav-label">${label}<`), `${label} is not nested`);
  }
  assert.doesNotMatch(children, /External/);
  assert.match(nav, /nav-section-label">Project</);
  assert.match(nav, /nav-label">External systems</);

  // participants of the sequence diagram
  assert.match(html, /Checkout API/);
  assert.match(html, /Stripe Gateway/);
  assert.match(html, /Webhook route/);
  assert.match(html, /Supabase/);
  assert.match(html, /Post-commit effects/);

  // the flow itself: hold before Stripe, webhook coming back
  assert.match(html, /createPaymentHold/);
  assert.match(html, /checkout\.session\.completed/);
  assert.match(html, /claimWebhookEvent/);
  assert.match(html, /markWebhookProcessed/);

  // phase bands
  assert.match(html, /1 · Reserve the seat/);
  assert.match(html, /4 · Settle the money/);
  assert.match(html, /5 · Close the loop/);

  // alternative paths are advertised, not hidden
  assert.match(html, /Happy path/);
  assert.match(html, /Seat taken while the customer was deciding/);
  assert.match(html, /Payment lands on a hold that was cancelled/);
  assert.match(html, /Refund event arrives before fulfilment/);

  // evidence and honest index state (React splits interpolated text with comments)
  assert.match(html, /src\/modules\/payments\/checkout\/paymentHolds\.ts:49-73/);
  assert.match(html, /802dd7a/);
  assert.match(html, /commits behind/);
  assert.match(html, /HEAD is 143d36d/);

  assert.doesNotMatch(html, /codex-preview/);
  assert.doesNotMatch(html, /react-loading-skeleton/);
});
