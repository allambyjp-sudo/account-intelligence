import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Server-only packages that load files from their own folders at runtime (pdfkit's fonts) or
  // shouldn't be bundled.
  serverExternalPackages: ["pg-boss", "@azure/msal-node", "pdfkit", "docx", "unpdf"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
