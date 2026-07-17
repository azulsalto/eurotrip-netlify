import { getStore } from "@netlify/blobs";

export default async () => {
  const store = getStore("eurotrip-state");
  const state = await store.get("state", { type: "json" }) || {};
  return new Response(JSON.stringify({
    offers: Array.isArray(state.offers) ? state.offers : [],
    lastRun: state.lastRun || null
  }), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
};
