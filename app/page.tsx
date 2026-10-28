import Link from "next/link";

export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: "60px auto", padding: "0 16px" }}>
      <h1 style={{ fontWeight: 700, fontSize: 26 }}>시험지 만들기</h1>
      <p style={{ color: "var(--muted)" }}>지금은 만드는 중입니다. 단계별로 확인할 수 있는 화면만 열려 있어요.</p>
      <ul>
        <li>
          <Link href="/figure-test">그림 엔진 확인 (2단계)</Link>
        </li>
      </ul>
    </main>
  );
}
