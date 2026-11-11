"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "시험지 만들기", short: "만들기" },
  { href: "/archive", label: "완료 보관함", short: "보관함" },
  { href: "/settings", label: "설정", short: "설정" },
];

export default function AppNav() {
  const path = usePathname();
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    window.location.href = "/login";
  }
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">
          시험지 만들기
        </Link>
        <nav className="nav" aria-label="주 메뉴">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} aria-label={l.label} aria-current={path === l.href ? "page" : undefined}>
              <span className="nav-label-full">{l.label}</span>
              <span className="nav-label-short" aria-hidden="true">{l.short}</span>
            </Link>
          ))}
        </nav>
        <button type="button" className="nav-logout" onClick={logout}>
          로그아웃
        </button>
      </div>
    </header>
  );
}
