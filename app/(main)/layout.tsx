import type { ReactNode } from "react";
import AppNav from "@/components/app/AppNav";
import "../app.css";

export default function MainLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <AppNav />
      {children}
    </>
  );
}
