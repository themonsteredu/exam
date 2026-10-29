/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingIncludes: { "/api/sample/[name]": ["./samples/**/*"] },
  // 이 판의 표시 (배포마다 다르다). 화면과 서버가 같은 값을 빌드 때 받아 두고,
  // 화면이 예전 판이면(배포 전에 열어 둔 창) 시험지 만들기를 멈춘다: app/api/version, lib/client/version.ts
  env: { NEXT_PUBLIC_APP_VERSION: process.env.VERCEL_DEPLOYMENT_ID || process.env.VERCEL_GIT_COMMIT_SHA || "" },
};
export default nextConfig;
