import "./fonts.css";
import "./theme.css";
import type { ReactNode } from "react";

export const metadata = {
  title: "시험지 만들기",
  description: "시험지 사진을 한글 파일로 옮기는 도구",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
