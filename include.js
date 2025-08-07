(async function () {
  try {
    const headResp = await fetch('head-section.html');
    if (headResp.ok) {
      const headHtml = await headResp.text();
      document.head.insertAdjacentHTML('afterbegin', headHtml);
    }
    const placeholders = document.querySelectorAll('[data-include]');
    for (const el of placeholders) {
      const file = el.getAttribute('data-include');
      try {
        const resp = await fetch(file);
        if (!resp.ok) throw new Error('Missing');
        const html = await resp.text();
        el.outerHTML = html;
      } catch (e) {
        el.outerHTML = `<!-- Missing include: ${file} -->`;
      }
    }
  } catch (err) {
    console.error('Include failed', err);
  }
})();
