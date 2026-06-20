import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The dispatcher and poller speak SOAP over mTLS to SET. They do NOT belong
  // inside a Next route on Vercel: that host has a rotating US egress IP over a
  // path that drops the large lote payloads silently (see the README, egress
  // gotcha). The Next app here is the enqueue + status surface; the worker runs
  // as a long-lived process on a box with a static, known-good egress. jszip is
  // pulled in by the worker, not the edge, so keep it external to the server bundle.
  serverExternalPackages: ["jszip", "pg"],
};

export default config;
