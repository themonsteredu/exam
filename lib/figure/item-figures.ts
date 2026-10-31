/** Keep the legacy first figure and every additional figure in source order. */
export function itemFigures(item: any): any[] {
  return [item?.figure, ...(Array.isArray(item?.extra_figures) ? item.extra_figures : [])].filter(Boolean);
}
export function setItemFigure(item: any, index: number, figure: any): void {
  if (index === 0) item.figure = figure;
  else {
    item.extra_figures = [...(item.extra_figures ?? [])];
    item.extra_figures[index - 1] = figure;
  }
}
