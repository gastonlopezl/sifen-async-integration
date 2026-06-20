import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The dispatcher and poller speak SOAP over mTLS to SET. They do NOT belong
  // inside a Next route on Vercel: that host has a rotating US egress IP that
  // SET will not let through (see the README, IP adhesion). The Next app here is
  // the enqueue + status surface; the worker runs as a long-lived process on a
  // box with a fixed, SET-adhered Paraguayan IP. jszip is pulled in by the
  // worker, not the edge, so keep it external to the server bundle.
  serverExternalPackages: ["jszip", "pg"],
};

export default config;
