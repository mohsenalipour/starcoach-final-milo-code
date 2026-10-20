const shapes = {
  folder: '<path d="M3 7h6l2-3h10v15H3z"/><path d="M3 7V4h6l2 3"/>',
  play: '<path d="m9 5 11 7-11 7z"/>',
  code: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-15-2 18"/>',
  plus: '<path d="M12 4v16M4 12h16"/>',
  refresh:
    '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.2 8a8 8 0 0 1 13-3L20 8M4 16l1.8 3a8 8 0 0 0 13-3"/>',
  settings:
    '<path d="m9 3-1 3-3 1-2 3 2 2-1 3 3 2 2-1 3 2 3-1 1-3 3-1 2-3-2-2 1-3-3-2-2 1-3-2z"/><circle cx="12" cy="11" r="3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  plan: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield:
    '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6z"/><path d="m8 12 3 3 5-6"/>',
  spark: '<path d="m12 2 3 7 7 3-7 3-3 7-3-7-7-3 7-3z"/>',
  arrow: '<path d="M19 12H5m5-5-5 5 5 5"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8zm-10 9 10 5 10-5M2 16l10 5 10-5"/>',
  save: '<path d="M4 3h13l4 4v14H3V3zm3 0v6h10V3M7 21v-8h10v8"/>',
  terminal: '<path d="m4 5 6 7-6 7m8 0h9"/>',
  clear: '<path d="m5 5 14 14M5 19 19 5"/>',
  file: '<path d="M5 3h9l5 5v13H5zM14 3v6h5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6l4 2"/>',
  warning: '<path d="m12 3 10 18H2zM12 9v5m0 3v1"/>',
};
export function icon(name) {
  return `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${shapes[name] || shapes.code}</svg>`;
}
export function hydrateIcons(root = document) {
  root.querySelectorAll("i[data-icon]").forEach((node) => {
    node.outerHTML = icon(node.dataset.icon);
  });
}
