// Tiny DOM builder. Everything goes in through textContent, so guest supplied text can never become markup.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('data-') || k === 'role' || k.startsWith('aria-') || k === 'href' || k === 'target' || k === 'rel' || k === 'download') el.setAttribute(k, v);
    else el[k] = v;
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
