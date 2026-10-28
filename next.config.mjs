/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: { "/api/sample/[name]": ["./samples/**/*"] },
};
export default nextConfig;
