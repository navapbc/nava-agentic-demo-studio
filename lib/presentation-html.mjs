import { escapeHtml as e, presentationTheme } from './presentation-model.mjs';

export function presentationHtml(manifest, media) {
  const theme = presentationTheme(manifest);
  const slides = manifest.slides.map((slide, index) => {
    const demo = media.find(item => item.id === slide.demo);
    const paragraphs = (slide.body || []).map(item => `<p>${e(item)}</p>`).join('');
    let content = paragraphs;
    if (slide.layout === 'bullets') content = `<ul>${(slide.body || []).map(item => `<li>${e(item)}</li>`).join('')}</ul>`;
    if (slide.layout === 'demo') content = `<video controls playsinline preload="metadata" poster="${e(demo.poster)}" aria-label="${e(slide.title)}"><source src="${e(demo.file)}" type="video/mp4"></video>`;
    if (slide.layout === 'split') content = `<div class="copy">${paragraphs}</div><img src="${e(slide.image)}" alt="${e(slide.imageAlt || slide.title)}">`;
    if (slide.layout === 'table') content = `<table><thead><tr>${slide.columns.map(item => `<th>${e(item)}</th>`).join('')}</tr></thead><tbody>${slide.rows.map(row => `<tr>${row.map(cell => `<td>${e(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    return `<section class="slide ${slide.layout}" id="slide-${index + 1}" aria-label="Slide ${index + 1}: ${e(slide.title)}" ${index ? 'hidden' : ''}>
      ${slide.eyebrow ? `<div class="eyebrow">${e(slide.eyebrow)}</div>` : ''}
      <h1>${e(slide.title)}</h1><div class="content">${content}</div>
      ${slide.caption ? `<div class="caption">${e(slide.caption)}</div>` : ''}
      <footer><span>${e(manifest.title)}</span><span>${index + 1}</span></footer>
    </section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${e(manifest.title)}</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#090f19;color:#fff;font-family:'${theme.font}',Arial,sans-serif}main{position:relative;width:1280px;height:720px;transform-origin:top left}.viewport{position:relative;margin:auto;overflow:hidden}.slide{position:absolute;inset:0;background:#${theme.paper};color:#${theme.ink};padding:55px 68px 64px;display:flex;flex-direction:column}.slide[hidden]{display:none}h1{white-space:pre-line;font-size:48px;line-height:1.09;margin:0 0 35px;letter-spacing:-1.2px;font-weight:700}.content{min-height:0;flex:1}p{white-space:pre-line;font-size:32px;line-height:1.3;margin:0 0 22px;max-width:1070px}.eyebrow{font-size:18px;letter-spacing:2.5px;text-transform:uppercase;font-weight:700;color:#${theme.accent};margin-bottom:27px}.cover,.closing{background:#${theme.background};color:#${theme.foreground};padding-top:110px}.cover h1{font-size:74px;line-height:1.05;max-width:1050px;margin-bottom:42px}.cover p{color:#d8deea;max-width:990px}.closing h1{font-size:54px;max-width:1100px;margin-bottom:38px}.closing p{font-size:38px;color:#d8deea;max-width:1050px}.statement .content{display:flex;flex-direction:column;justify-content:center}.statement p{font-size:51px;line-height:1.17;max-width:1120px;letter-spacing:-.7px}.bullets li{font-size:32px;line-height:1.35;margin-bottom:22px;padding-left:9px}.bullets ul{margin-top:30px;padding-left:33px}.demo{background:#${theme.background};color:#${theme.foreground};padding-top:32px}.demo h1{font-size:43px;margin-bottom:22px}.demo .content{display:flex;align-items:flex-start;justify-content:center}.demo video{display:block;width:960px;height:540px;object-fit:contain;background:#000}.split .content{display:grid;grid-template-columns:1fr 1.22fr;gap:52px;align-items:center}.split img{width:100%;max-height:445px;object-fit:contain}.split p{font-size:29px}.table table{width:100%;border-collapse:collapse;font-size:28px;margin-top:22px;line-height:1.25}.table th{text-align:left;padding:18px 20px;border-bottom:3px solid #${theme.ink}}.table td{padding:27px 20px;border-bottom:1px solid #c9ced5}.table td:first-child{font-weight:700;width:38%}.caption{font-size:18px;margin-top:15px;line-height:1.2;opacity:.8}footer{position:absolute;bottom:23px;left:68px;right:68px;display:flex;justify-content:space-between;font-size:15px;opacity:.56}nav{height:64px;display:flex;gap:20px;align-items:center;justify-content:center;color:#d8deea;font-size:14px}button{font:inherit;background:#202e45;color:#fff;border:1px solid #45526b;border-radius:5px;padding:9px 18px;cursor:pointer}button:disabled{opacity:.35;cursor:default}button:focus-visible,video:focus-visible{outline:3px solid #${theme.accent};outline-offset:3px}.print-poster{display:none}
@media print{@page{size:13.333333in 7.5in;margin:0}html,body{width:1280px;background:white}nav{display:none}.viewport{width:1280px!important;height:auto!important;overflow:visible}main{transform:none!important;height:auto}.slide,.slide[hidden]{position:relative;display:flex!important;width:1280px;height:720px;break-after:page;print-color-adjust:exact;-webkit-print-color-adjust:exact}.slide:last-child{break-after:auto}video{display:none!important}.print-poster{display:block;width:960px;height:540px;object-fit:contain}}
</style></head><body><div class="viewport"><main>${slides}</main></div><nav aria-label="Presentation navigation"><button id="previous" type="button">Previous</button><span id="position" role="status" aria-live="polite"></span><button id="next" type="button">Next</button></nav>
<script>
const slides = [...document.querySelectorAll('.slide')];
let index = 0;
function show(value) {
  index = Math.min(slides.length - 1, Math.max(0, value));
  slides.forEach((slide, i) => { slide.hidden = i !== index; if (i !== index) slide.querySelectorAll('video').forEach(video => video.pause()); });
  document.getElementById('position').textContent = (index + 1) + ' / ' + slides.length;
  document.getElementById('previous').disabled = index === 0;
  document.getElementById('next').disabled = index === slides.length - 1;
  history.replaceState(null, '', '#slide-' + (index + 1));
}
function resize() { const scale = Math.max(.1, Math.min((innerWidth - 24) / 1280, (innerHeight - 80) / 720)); const viewport = document.querySelector('.viewport'); viewport.style.width = (1280 * scale) + 'px'; viewport.style.height = (720 * scale) + 'px'; document.querySelector('main').style.transform = 'scale(' + scale + ')'; }
document.getElementById('previous').onclick = () => show(index - 1);
document.getElementById('next').onclick = () => show(index + 1);
document.addEventListener('keydown', event => { if (['INPUT','TEXTAREA','VIDEO'].includes(event.target.tagName)) return; if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); show(index + 1); } if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); show(index - 1); } if (event.key === 'Home') show(0); if (event.key === 'End') show(slides.length - 1); });
addEventListener('resize', resize);
document.querySelectorAll('video').forEach(video => { const poster = new Image(); poster.src = video.poster; poster.alt = video.getAttribute('aria-label'); poster.className = 'print-poster'; video.after(poster); });
show(Math.max(0, Number(location.hash.match(/slide-(\\d+)/)?.[1] || 1) - 1)); resize();
window.presentationStudio = { goTo: show, currentSlide: () => index };
</script></body></html>`;
}
