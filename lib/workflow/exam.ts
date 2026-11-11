import { getWorkflowMetadata } from "workflow";
import type { JobInput } from "@/lib/server/exam-job";
import { begin, inspectOriginal, preparePage, readPageStep, cropPage, readFigureStep, assemble, rebuild, draw, finish, failJob, progress } from "./exam-steps";

export async function createExam(job: JobInput) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  try {
    const doc = await begin(job, runId);
    let work: string;
    if (job.mode === "rebuild") {
      work = await rebuild(job);
    } else {
      const sources: { file: number; index: number; label: string; problem?: string }[] = [];
      for (let file = 0; file < doc.original_files.length; file++) {
        const pages = await inspectOriginal(job, doc.original_files[file]);
        sources.push(...pages.map((p: any, index: number) => ({ ...p, file, index })));
      }
      const results: string[] = [];
      const figures: string[] = [];
      let before: string | undefined;
      let usd = doc.cost_usd;
      let figuresDone = 0;
      let figuresTotal = 0;
      for (let i = 0; i < sources.length; i++) {
        const source = sources[i];
        await progress(job, { step: "page", message: `${i + 1}/${sources.length}쪽을 읽고 있습니다.`, pagesDone: i, pagesTotal: sources.length, figuresDone, figuresTotal, usd });
        const prepared = await preparePage(job, doc.original_files[source.file], source.index, i + 1);
        usd += prepared.usd;
        const page = await readPageStep(job, prepared.path, i + 1, sources.length, before);
        results.push(page.path); before = page.before; usd += page.usd;
        const cuts = await cropPage(job, prepared.path, page.path);
        figuresTotal += cuts.length;
        // 한 쪽의 그림을 최대 3개씩 읽는다. 각 호출은 독립된 서버 단계다.
        for (let j = 0; j < cuts.length; j += 3) {
          await progress(job, { step: "figure", message: `${i + 1}쪽의 그림을 읽고 있습니다.`, pagesDone: i + 1, pagesTotal: sources.length, figuresDone, figuresTotal, usd });
          const batch = await Promise.all(cuts.slice(j, j + 3).map(path => readFigureStep(job, path)));
          for (const figure of batch) { figures.push(figure.path); usd += figure.usd; figuresDone++; }
        }
      }
      await progress(job, { step: "draw", message: "그림을 그리고 있습니다.", pagesDone: sources.length, pagesTotal: sources.length, figuresDone, figuresTotal, usd });
      work = await assemble(job, results, figures, usd, sources.filter(s => s.problem).map(s => `${s.label}: ${s.problem}`));
    }
    const drawn = await draw(job, work);
    await finish(job, drawn);
  } catch (err) {
    await failJob(job, err instanceof Error ? err.message : "시험지 제작을 마치지 못했습니다.");
    throw err;
  }
}
