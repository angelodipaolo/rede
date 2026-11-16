const P: Record<string, string> = {
  right: 'M6 4l4 4-4 4',
  downchev: 'M4 6l4 4 4-4',
  up: 'M8 12V4M4.5 7.5L8 4l3.5 3.5',
  down: 'M8 4v8M4.5 8.5L8 12l3.5-3.5',
  unfold: 'M8 2v4M5.5 4L8 1.5 10.5 4M8 14v-4M5.5 12L8 14.5 10.5 12M3 8h10',
  check: 'M3.5 8.5l3 3 6-7',
  copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
  comment: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z',
  addcomment: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2zM8 5v4M6 7h4',
  history: 'M2.5 8a5.5 5.5 0 1 0 1.7-4M2.5 2.5v2.5H5M8 5v3l2 1.5',
  x: 'M4 4l8 8M12 4l-8 8',
  sun: 'M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3 3l1 1M12 12l1 1M3 13l1-1M12 4l1-1',
  moon: 'M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z',
  split: 'M2.5 3h11v10h-11zM8 3v10',
  unified: 'M2.5 3h11v10h-11zM2.5 8h11',
  panel: 'M2.5 3h11v10h-11zM10 3v10',
  sidebar: 'M2.5 3h11v10h-11zM6 3v10',
  plug: 'M6 2v3M10 2v3M4.5 5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11v3',
  keyboard: 'M1.5 4.5h13v7h-13zM4 7h1M7 7h1M10 7h1M5 9.5h6',
  reply: 'M6.5 4L3 7.5 6.5 11M3 7.5h6a4 4 0 0 1 4 4v1',
  edit: 'M10.5 2.5l3 3-8 8h-3v-3z',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.5 9h6l.5-9',
  note: 'M3.5 2.5h9v11h-9zM5.5 5.5h5M5.5 8h5M5.5 10.5h3',
  search: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 10l3.5 3.5',
  filter: 'M2.5 3.5h11l-4 5v4l-3 1.5v-5.5z',
  wrap: 'M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H9M10.5 10.5L9 12l1.5 1.5M2.5 12h4',
  nowrap: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  dot: 'M8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <svg class="ic" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d={P[name] ?? ''} fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}
