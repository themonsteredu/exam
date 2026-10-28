import Link from "next/link";

export default function Home() {
  return (
    <main className="page" style={{ maxWidth: 720 }}>
      <div className="page-head">
        <h1>시험지 만들기</h1>
        <p className="lead">아직 만드는 중입니다. 지금은 단계별로 확인할 수 있는 화면만 열려 있어요.</p>
      </div>
      <ul>
        <li>
          <Link href="/figure-test">그림 엔진 확인 (2단계)</Link>
        </li>
      </ul>
    </main>
  );
}
