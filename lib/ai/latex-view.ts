// 수식(LaTeX)을 사람이 읽기 쉬운 HTML 로 바꾼다 (비교 보고서용 간단한 표시. 한글 파일에는 쓰지 않는다).
// 모르는 명령은 이름을 그대로 보여 준다.

const SYMBOLS: Record<string, string> = {
  angle: "∠", triangle: "△", circ: "°", degree: "°", times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", fallingdotseq: "≒", equiv: "≡",
  sim: "∽", parallel: "∥", perp: "⊥", pi: "π", cdots: "⋯", ldots: "…", therefore: "∴", because: "∵",
  infty: "∞", in: "∈", notin: "∉", subset: "⊂", subseteq: "⊆", cup: "∪", cap: "∩", emptyset: "∅",
  rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftrightarrow: "⇔", alpha: "α", beta: "β", gamma: "γ",
  theta: "θ", square: "□", bigcirc: "○", quad: "  ", qquad: "    ", ",": " ", ";": " ", ":": " ", " ": " ", "!": "",
  "{": "{", "}": "}", "%": "%", "\\": " / ",
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function latexToHtml(latex: string): string {
  let i = 0;
  const s = latex;

  const group = (): string => {
    // { … } 또는 글자 하나 또는 명령 하나
    while (s[i] === " ") i++;
    if (s[i] === "{") {
      i++;
      const out = seq("}");
      i++;
      return out;
    }
    return atom();
  };

  const atom = (): string => {
    const ch = s[i];
    if (ch === undefined) return "";
    if (ch === "\\") {
      const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
      if (!m) {
        i++;
        return "\\";
      }
      i += m[0].length;
      return command(m[1]);
    }
    if (ch === "{") return group();
    i++;
    if (/[a-z]/.test(ch)) return `<i>${ch}</i>`;
    return esc(ch);
  };

  const command = (name: string): string => {
    switch (name) {
      case "overline":
      case "bar":
        return `<span style="text-decoration:overline">${group()}</span>`;
      case "overrightarrow":
        return `<span style="position:relative">${group()}<sup style="position:absolute;left:0;right:0;top:-0.9em;text-align:center;font-size:0.7em">→</sup></span>`;
      case "overleftrightarrow":
        return `<span style="position:relative">${group()}<sup style="position:absolute;left:0;right:0;top:-0.9em;text-align:center;font-size:0.7em">↔</sup></span>`;
      case "overset": {
        const top = group();
        const base = group();
        return `<span style="position:relative">${base}<sup style="position:absolute;left:0;right:0;top:-0.9em;text-align:center;font-size:0.7em">${top.includes("frown") || top.includes("⌒") ? "⌒" : top}</sup></span>`;
      }
      case "frown":
        return "⌒";
      case "frac":
      case "dfrac":
      case "tfrac": {
        const a = group();
        const b = group();
        return `<span class="frac"><span>${a}</span><span>${b}</span></span>`;
      }
      case "sqrt": {
        let index = "";
        if (s[i] === "[") {
          const end = s.indexOf("]", i);
          index = `<sup>${esc(s.slice(i + 1, end))}</sup>`;
          i = end + 1;
        }
        return `${index}√<span style="text-decoration:overline">${group()}</span>`;
      }
      case "text":
      case "mathrm":
      case "textrm":
      case "operatorname":
      case "mbox":
        return group().replace(/<\/?i>/g, "");
      case "mathit":
      case "textit":
        return `<i>${group().replace(/<\/?i>/g, "")}</i>`;
      case "left":
      case "right":
      case "displaystyle":
        return "";
      case "begin": {
        const env = group().replace(/<[^>]+>/g, "");
        const end = s.indexOf(`\\end{${env}}`, i);
        const body = end >= 0 ? s.slice(i, end) : s.slice(i);
        i = end >= 0 ? end + `\\end{${env}}`.length : s.length;
        const rows = body.split("\\\\").map((r) => latexToHtml(r.replace(/&/g, " ")));
        return env === "cases" ? `{ ${rows.join(" , ")} }` : rows.join(" ; ");
      }
      default:
        return name in SYMBOLS ? SYMBOLS[name] : `\\${esc(name)}`;
    }
  };

  const seq = (until?: string): string => {
    let out = "";
    while (i < s.length && s[i] !== until) {
      if (s[i] === "^" || s[i] === "_") {
        const tag = s[i] === "^" ? "sup" : "sub";
        i++;
        const g = group();
        out += g === "°" ? "°" : `<${tag}>${g}</${tag}>`;
        continue;
      }
      out += atom();
    }
    return out;
  };

  try {
    return seq();
  } catch {
    return esc(latex);
  }
}

/** 시험지 JSON 조각 → HTML (글은 그대로, 수식은 읽기 쉽게) */
export function piecesToHtml(pieces: unknown): string {
  if (!Array.isArray(pieces)) return "";
  return pieces
    .map((p) => {
      if (typeof p === "string") return esc(p);
      const o = p as { t?: unknown; m?: unknown };
      if (typeof o.m === "string") return `<span class="math">${latexToHtml(o.m)}</span>`;
      if (o.t === "\n") return "<br>";
      return esc(String(o.t ?? ""));
    })
    .join("");
}
