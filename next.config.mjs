/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module: keep it out of the bundler and load it
  // from node_modules at runtime.
  serverExternalPackages: ["better-sqlite3"],
  eslint: { ignoreDuringBuilds: true },

  // The cloud preview fetches the dev server through a proxy hostname.
  allowedDevOrigins: [
    "pv-65e8d471b83f-e79ad9e7-0821-4931-ad0f-7bfcc2a4f22e.style.dev",
    "localhost",
    "127.0.0.1",
  ],
};

export default nextConfig;
